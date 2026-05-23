import { badRequest, json, one, run } from "../lib/db";
import { sessionResponse } from "../lib/auth";
import { getQuickAccess, isEmail, isFreeAccessEmail, normalizeEmail } from "../lib/quick-access";

type Env = {
  DB: D1Database;
  APP_ORIGIN?: string;
  EMAIL_WEBHOOK_URL?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  ALLOW_DEV_MAGIC_LINKS?: string;
  QUERY_QUICK_FREE_ACCESS_EMAILS?: string;
};

type UserRow = {
  id: string;
  email: string;
  display_name: string;
  role: "writer" | "agent";
};

type MagicLinkRow = {
  token: string;
  email: string;
  expires_at: string;
  used_at: string | null;
};

const MAGIC_LINK_LIFETIME_HOURS = 6;

function configuredOrigins(env: Env) {
  return String(env.APP_ORIGIN || "http://127.0.0.1:4174")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function isLocalOrigin(origin: string) {
  try {
    const url = new URL(origin);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function magicLinkOrigin(request: Request, env: Env) {
  const requestOrigin = request.headers.get("origin")?.replace(/\/$/, "");
  const origins = configuredOrigins(env);
  if (requestOrigin && (origins.includes(requestOrigin) || isLocalOrigin(requestOrigin))) return requestOrigin;
  return origins[0] || "http://127.0.0.1:4174";
}

async function sendMagicLink(env: Env, email: string, link: string) {
  if (env.RESEND_API_KEY && env.RESEND_FROM_EMAIL) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.RESEND_FROM_EMAIL,
        to: [email],
        subject: "Your Query Quick sign-in link",
        html: `
          <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.5;color:#15221c">
            <h1 style="font-size:22px;margin:0 0 12px">Open Query Quick</h1>
            <p>Use this secure link to open your Query Quick workspace. It expires in ${MAGIC_LINK_LIFETIME_HOURS} hours.</p>
            <p><a href="${link}" style="color:#123d2d">Open Query Quick</a></p>
            <p style="color:#66736c">After that, return to Query Quick and enter your email to receive a fresh link.</p>
            <p style="color:#66736c;font-size:13px">If you did not request this link, you can ignore this email.</p>
          </div>
        `,
        text: `Open Query Quick: ${link}\n\nThis link expires in ${MAGIC_LINK_LIFETIME_HOURS} hours. After that, return to Query Quick and enter your email to receive a fresh link.\n\nIf you did not request this link, you can ignore this email.`,
        tags: [{ name: "product", value: "query_quick" }],
      }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null) as { message?: string } | null;
      throw badRequest(error?.message || "Resend could not send the magic link.", response.status);
    }
    return { delivered: true };
  }

  if (!env.EMAIL_WEBHOOK_URL) return { delivered: false };
  await fetch(env.EMAIL_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      to: email,
      subject: "Your Query Quick sign-in link",
      text: `Open your Query Quick workspace: ${link}`,
    }),
  });
  return { delivered: true };
}

async function upsertUser(env: Env, email: string): Promise<UserRow> {
  const existing = await one<UserRow>(env.DB, `SELECT id, email, display_name, role FROM users WHERE email = ?1`, [email]);
  if (existing) return existing;

  const id = crypto.randomUUID();
  const displayName = email.split("@")[0] || "Query Quick user";
  await run(
    env.DB,
    `INSERT INTO users (id, email, display_name, role, password_salt, password_hash, created_at)
     VALUES (?1, ?2, ?3, 'writer', ?4, ?5, ?6)`,
    [id, email, displayName, crypto.randomUUID(), crypto.randomUUID(), new Date().toISOString()]
  );
  return { id, email, display_name: displayName, role: "writer" };
}

async function createSession(env: Env, user: UserRow) {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
  await run(env.DB, `INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)`, [
    token,
    user.id,
    expiresAt,
    new Date().toISOString(),
  ]);
  return sessionResponse(token, user);
}

export async function handleQuickAuth(request: Request, env: Env, url: URL) {
  if (request.method !== "POST") return badRequest("Method not allowed.", 405);
  const body = (await request.json()) as Record<string, unknown>;

  if (url.pathname === "/api/auth/magic/request") {
    const email = normalizeEmail(body.email);
    if (!isEmail(email)) return badRequest("A valid email is required.");
    const origin = magicLinkOrigin(request, env);
    const allowDevLink = env.ALLOW_DEV_MAGIC_LINKS === "true" || isLocalOrigin(origin);
    const access = await getQuickAccess(env, email);
    if (!access.active && !allowDevLink) {
      return badRequest("Query Quick is $9.95/month. Subscribe first, or enter the email you used at Stripe.", 402);
    }

    const token = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 1000 * 60 * 60 * MAGIC_LINK_LIFETIME_HOURS).toISOString();
    await run(env.DB, `INSERT INTO magic_links (token, email, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)`, [
      token,
      email,
      expiresAt,
      now.toISOString(),
    ]);

    const link = `${origin}/auth/verify?token=${encodeURIComponent(token)}`;
    const delivery = await sendMagicLink(env, email, link);
    return json({
      ok: true,
      delivered: delivery.delivered,
      dev_magic_link: !delivery.delivered && allowDevLink ? link : undefined,
    });
  }

  if (url.pathname === "/api/auth/magic/verify") {
    const token = String(body.token || "").trim();
    if (!token) return badRequest("Token is required.");
    const row = await one<MagicLinkRow>(env.DB, `SELECT * FROM magic_links WHERE token = ?1`, [token]);
    if (!row || row.used_at) return badRequest("This sign-in link is no longer valid.", 401);
    if (new Date(row.expires_at).getTime() < Date.now()) return badRequest("This sign-in link has expired.", 401);

    const origin = magicLinkOrigin(request, env);
    const allowDevLink = env.ALLOW_DEV_MAGIC_LINKS === "true" || isLocalOrigin(origin);
    const access = await getQuickAccess(env, row.email);
    if (!access.active && !allowDevLink) {
      return badRequest("This email needs an active Query Quick subscription before sign-in.", 402);
    }
    await run(env.DB, `UPDATE magic_links SET used_at = ?1 WHERE token = ?2`, [new Date().toISOString(), token]);
    const user = await upsertUser(env, row.email);
    if (isFreeAccessEmail(env, row.email)) {
      await run(
        env.DB,
        `INSERT INTO subscriptions_quick (user_id, status, updated_at)
         VALUES (?1, 'owner_free', ?2)
         ON CONFLICT(user_id) DO UPDATE SET status = 'owner_free', updated_at = ?2`,
        [user.id, new Date().toISOString()]
      );
    } else if (allowDevLink && access.status === "none") {
      await run(
        env.DB,
        `INSERT INTO subscriptions_quick (user_id, status, updated_at)
         VALUES (?1, 'dev_access', ?2)
         ON CONFLICT(user_id) DO NOTHING`,
        [user.id, new Date().toISOString()]
      );
    }
    return json(await createSession(env, user));
  }

  return badRequest("Route not found.", 404);
}

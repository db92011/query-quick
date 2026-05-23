import { requireSession } from "../lib/auth";
import { badRequest, json, one, run } from "../lib/db";

type Env = {
  DB: D1Database;
  APP_ORIGIN?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_PRICE_ID?: string;
  QUERY_QUICK_FREE_ACCESS_EMAILS?: string;
};

type SubscriptionRow = {
  stripe_customer_id: string | null;
};

function clean(value: unknown) {
  return String(value || "").trim();
}

function normalizeEmail(value: unknown) {
  return clean(value).toLowerCase();
}

const DEFAULT_FREE_ACCESS_EMAILS = ["danbrooking@gmail.com"];

function configuredFreeAccessEmails(env: Env) {
  const configured = clean(env.QUERY_QUICK_FREE_ACCESS_EMAILS);
  const emails = configured ? configured.split(/[\s,;]+/) : [];
  return new Set([...DEFAULT_FREE_ACCESS_EMAILS, ...emails].map(normalizeEmail).filter(Boolean));
}

function isFreeAccessEmail(env: Env, email: string) {
  return configuredFreeAccessEmails(env).has(normalizeEmail(email));
}

async function stripeRequest<T>(env: Env, path: string, params: URLSearchParams): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw badRequest("Stripe is not configured.", 503);
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  const data = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw badRequest(data.error?.message || "Stripe request failed.", response.status);
  return data;
}

async function ensureQuickUser(env: Env, email: string) {
  const existing = await one<{ id: string }>(env.DB, `SELECT id FROM users WHERE email = ?1`, [email]);
  if (existing?.id) return existing.id;
  const id = crypto.randomUUID();
  const displayName = email.split("@")[0] || "Query Quick user";
  await run(
    env.DB,
    `INSERT INTO users (id, email, display_name, role, password_salt, password_hash, created_at)
     VALUES (?1, ?2, ?3, 'writer', ?4, ?5, ?6)`,
    [id, email, displayName, crypto.randomUUID(), crypto.randomUUID(), new Date().toISOString()]
  );
  return id;
}

async function upsertQuickSubscription(env: Env, input: {
  email?: string;
  customer?: string;
  subscriptionId?: string;
  status?: string;
  currentPeriodEnd?: string;
}) {
  const now = new Date().toISOString();
  const customer = clean(input.customer);
  const subscriptionId = clean(input.subscriptionId);
  const status = clean(input.status) || "active";
  const currentPeriodEnd = clean(input.currentPeriodEnd);
  const email = normalizeEmail(input.email);

  if (email) {
    const userId = await ensureQuickUser(env, email);
    await run(
      env.DB,
      `INSERT INTO subscriptions_quick
         (user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, updated_at)
       VALUES (?1, NULLIF(?2, ''), NULLIF(?3, ''), ?4, NULLIF(?5, ''), ?6)
       ON CONFLICT(user_id) DO UPDATE SET
         stripe_customer_id = COALESCE(NULLIF(?2, ''), subscriptions_quick.stripe_customer_id),
         stripe_subscription_id = COALESCE(NULLIF(?3, ''), subscriptions_quick.stripe_subscription_id),
         status = ?4,
         current_period_end = COALESCE(NULLIF(?5, ''), subscriptions_quick.current_period_end),
         updated_at = ?6`,
      [userId, customer, subscriptionId, status, currentPeriodEnd, now]
    );
    return;
  }

  if (customer) {
    await run(
      env.DB,
      `UPDATE subscriptions_quick
       SET stripe_subscription_id = COALESCE(NULLIF(?2, ''), stripe_subscription_id),
           status = ?3,
           current_period_end = COALESCE(NULLIF(?4, ''), current_period_end),
           updated_at = ?5
       WHERE stripe_customer_id = ?1`,
      [customer, subscriptionId, status, currentPeriodEnd, now]
    );
  }
}

export async function handleBilling(request: Request, env: Env, url: URL) {
  if (request.method !== "POST") return badRequest("Method not allowed.", 405);
  const origin = String(env.APP_ORIGIN || "http://127.0.0.1:4174").replace(/\/$/, "");

  if (url.pathname === "/api/billing/checkout") {
    const body = await request.json().catch(() => ({})) as { email?: unknown };
    const email = normalizeEmail(body.email);
    if (isFreeAccessEmail(env, email)) {
      const userId = await ensureQuickUser(env, email);
      await run(
        env.DB,
        `INSERT INTO subscriptions_quick (user_id, status, updated_at)
         VALUES (?1, 'owner_free', ?2)
         ON CONFLICT(user_id) DO UPDATE SET status = 'owner_free', updated_at = ?2`,
        [userId, new Date().toISOString()]
      );
      return json({ ok: true, url: `${origin}/quick?checkout=free&email=${encodeURIComponent(email)}` });
    }

    const priceId = env.STRIPE_PRICE_ID;
    if (!priceId) return badRequest("Stripe price is not configured.", 503);
    const params = new URLSearchParams({
      mode: "subscription",
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      success_url: `${origin}/quick?checkout=success`,
      cancel_url: `${origin}/`,
      allow_promotion_codes: "true",
    });
    if (email) params.set("customer_email", email);
    const session = await stripeRequest<{ url: string }>(env, "checkout/sessions", params);
    return json({ ok: true, url: session.url });
  }

  if (url.pathname === "/api/billing/portal") {
    const session = await requireSession(request, env);
    const subscription = await one<SubscriptionRow>(
      env.DB,
      `SELECT stripe_customer_id FROM subscriptions_quick WHERE user_id = ?1`,
      [session.user.id]
    );
    if (!subscription?.stripe_customer_id) return badRequest("No Stripe customer is attached to this account.", 404);
    const portal = await stripeRequest<{ url: string }>(
      env,
      "billing_portal/sessions",
      new URLSearchParams({
        customer: subscription.stripe_customer_id,
        return_url: `${origin}/quick`,
      })
    );
    return json({ ok: true, url: portal.url });
  }

  if (url.pathname === "/api/billing/webhook") {
    const event = await request.json() as { type?: string; data?: { object?: Record<string, unknown> } };
    const object = event.data?.object || {};
    const customerDetails = object.customer_details as { email?: unknown } | undefined;
    await upsertQuickSubscription(env, {
      email: object.customer_email as string | undefined || customerDetails?.email as string | undefined,
      customer: object.customer as string | undefined,
      subscriptionId: object.subscription as string | undefined || object.id as string | undefined,
      status: object.status as string | undefined || event.type || "updated",
      currentPeriodEnd: typeof object.current_period_end === "number"
        ? new Date(Number(object.current_period_end) * 1000).toISOString()
        : "",
    });
    return json({ ok: true });
  }

  return badRequest("Route not found.", 404);
}

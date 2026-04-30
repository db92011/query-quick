import { badRequest, one } from "./db";

export type SessionUser = {
  id: string;
  email: string;
  role: "writer" | "agent";
  display_name: string;
};

type SessionRecord = {
  token: string;
  user_id: string;
  expires_at: string;
  email: string;
  role: "writer" | "agent";
  display_name: string;
};

function toHex(buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function hashPassword(password: string, salt: string) {
  const bytes = new TextEncoder().encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(digest);
}

export function sessionResponse(token: string, user: SessionUser) {
  return {
    ok: true,
    session: {
      token,
      user,
    },
  };
}

export async function requireSession(request: Request, env: { DB: D1Database }) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) throw badRequest("Missing authorization token.", 401);

  const session = await one<SessionRecord>(
    env.DB,
    `SELECT s.token, s.user_id, s.expires_at, u.email, u.role, u.display_name
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = ?1`,
    [token]
  );

  if (!session) throw badRequest("Invalid session.", 401);
  if (new Date(session.expires_at).getTime() < Date.now()) throw badRequest("Session expired.", 401);

  return {
    token: session.token,
    user: {
      id: session.user_id,
      email: session.email,
      role: session.role,
      display_name: session.display_name,
    } satisfies SessionUser,
  };
}


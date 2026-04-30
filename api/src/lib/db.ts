export function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers || {}),
    },
  });
}

export function textResponse(message: string, status = 200) {
  return new Response(message, { status });
}

export function badRequest(message: string, status = 400) {
  return json({ ok: false, error: message }, { status });
}

export async function one<T = Record<string, unknown>>(db: D1Database, sql: string, params: unknown[] = []) {
  return db.prepare(sql).bind(...params).first<T>();
}

export async function all<T = Record<string, unknown>>(db: D1Database, sql: string, params: unknown[] = []) {
  const result = await db.prepare(sql).bind(...params).all<T>();
  return result.results || [];
}

export async function run(db: D1Database, sql: string, params: unknown[] = []) {
  return db.prepare(sql).bind(...params).run();
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}


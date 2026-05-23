import { one } from "./db";

export type QuickAccessEnv = {
  DB: D1Database;
  QUERY_QUICK_FREE_ACCESS_EMAILS?: string;
};

type QuickSubscriptionRow = {
  user_id: string;
  status: string | null;
  current_period_end: string | null;
};

const DEFAULT_FREE_ACCESS_EMAILS = ["danbrooking@gmail.com"];
const ACTIVE_STATUSES = new Set([
  "active",
  "trialing",
  "past_due",
  "complete",
  "owner_free",
  "free_access",
  "dev_access",
]);

export function normalizeEmail(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

export function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function configuredFreeAccessEmails(env: QuickAccessEnv) {
  const configured = String(env.QUERY_QUICK_FREE_ACCESS_EMAILS || "").trim();
  const emails = configured ? configured.split(/[\s,;]+/) : [];
  return new Set([...DEFAULT_FREE_ACCESS_EMAILS, ...emails].map(normalizeEmail).filter(Boolean));
}

export function isFreeAccessEmail(env: QuickAccessEnv, email: string) {
  return configuredFreeAccessEmails(env).has(normalizeEmail(email));
}

function isCurrentPeriod(currentPeriodEnd: string | null) {
  if (!currentPeriodEnd) return true;
  const timestamp = Date.parse(currentPeriodEnd);
  if (!Number.isFinite(timestamp)) return true;
  return timestamp >= Date.now();
}

export async function getQuickAccess(env: QuickAccessEnv, emailInput: unknown) {
  const email = normalizeEmail(emailInput);
  const freeAccess = isFreeAccessEmail(env, email);
  if (freeAccess) {
    return {
      email,
      active: true,
      freeAccess,
      status: "owner_free",
      currentPeriodEnd: null,
      userId: null,
    };
  }

  const row = await one<QuickSubscriptionRow>(
    env.DB,
    `SELECT u.id AS user_id, sq.status, sq.current_period_end
     FROM users u
     LEFT JOIN subscriptions_quick sq ON sq.user_id = u.id
     WHERE u.email = ?1
     LIMIT 1`,
    [email]
  );
  const status = normalizeEmail(row?.status);
  const active = Boolean(status && ACTIVE_STATUSES.has(status) && isCurrentPeriod(row?.current_period_end || null));

  return {
    email,
    active,
    freeAccess,
    status: status || "none",
    currentPeriodEnd: row?.current_period_end || null,
    userId: row?.user_id || null,
  };
}

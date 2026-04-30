import { requireSession } from "../lib/auth";
import { badRequest, json, one, run } from "../lib/db";

type Env = {
  DB: D1Database;
  APP_ORIGIN?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_PRICE_ID?: string;
};

type SubscriptionRow = {
  stripe_customer_id: string | null;
};

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

export async function handleBilling(request: Request, env: Env, url: URL) {
  if (request.method !== "POST") return badRequest("Method not allowed.", 405);
  const origin = String(env.APP_ORIGIN || "http://127.0.0.1:4174").replace(/\/$/, "");

  if (url.pathname === "/api/billing/checkout") {
    const priceId = env.STRIPE_PRICE_ID;
    if (!priceId) return badRequest("Stripe price is not configured.", 503);
    const params = new URLSearchParams({
      mode: "subscription",
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      success_url: `${origin}/subscribed`,
      cancel_url: `${origin}/`,
      allow_promotion_codes: "true",
    });
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
    const customer = String(object.customer || "");
    const subscriptionId = String(object.subscription || object.id || "");
    const status = String(object.status || event.type || "updated");
    if (customer) {
      await run(
        env.DB,
        `UPDATE subscriptions_quick
         SET stripe_customer_id = ?1, stripe_subscription_id = COALESCE(NULLIF(?2, ''), stripe_subscription_id), status = ?3, updated_at = ?4
         WHERE stripe_customer_id = ?1`,
        [customer, subscriptionId, status, new Date().toISOString()]
      );
    }
    return json({ ok: true });
  }

  return badRequest("Route not found.", 404);
}

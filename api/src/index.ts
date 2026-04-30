import { badRequest, json, textResponse } from "./lib/db";
import { handleBilling } from "./routes/billing";
import { handleQuickAuth } from "./routes/quick-auth";
import { handleAgentDiscover, handleAgentIntelRefresh, handleAgentSearch, handleMarkSent, handleQuickFileUpload, handleQuickProfile, handleWaitlist } from "./routes/quick";

type Env = {
  DB: D1Database;
  FILES?: R2Bucket;
  APP_ORIGIN?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  EMAIL_WEBHOOK_URL?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_PRICE_ID?: string;
};

function withCors(response: Response, origin: string) {
  response.headers.set("access-control-allow-origin", origin);
  response.headers.set("access-control-allow-headers", "authorization, content-type, stripe-signature");
  response.headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  return response;
}

export default {
  async fetch(request: Request, env: Env) {
    const origin = String(env.APP_ORIGIN || "*");
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), origin);

    try {
      const url = new URL(request.url);
      let response: Response;

      if (request.method === "GET" && url.pathname === "/api/health") {
        response = json({ ok: true, service: "query-quick-api" });
      } else if (url.pathname.startsWith("/api/auth/magic/")) {
        response = await handleQuickAuth(request, env, url);
      } else if (url.pathname.startsWith("/api/billing/")) {
        response = await handleBilling(request, env, url);
      } else if (url.pathname === "/api/waitlist") {
        response = await handleWaitlist(request, env);
      } else if (url.pathname === "/api/agents/search") {
        response = await handleAgentSearch(request, env);
      } else if (url.pathname === "/api/agents/discover") {
        response = await handleAgentDiscover(request, env);
      } else if (url.pathname === "/api/profile") {
        response = await handleQuickProfile(request, env);
      } else if (url.pathname === "/api/submission-kit/file") {
        response = await handleQuickFileUpload(request, env);
      } else if (url.pathname === "/api/submissions/mark-sent") {
        response = await handleMarkSent(request, env);
      } else {
        response = textResponse("Not Found", 404);
      }

      return withCors(response, origin);
    } catch (error) {
      if (error instanceof Response) return withCors(error, origin);
      return withCors(badRequest(error instanceof Error ? error.message : "Unknown error.", 500), origin);
    }
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleAgentIntelRefresh(env));
  },
};

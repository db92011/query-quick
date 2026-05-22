import { badRequest, json, textResponse } from "./lib/db";
import { handleBilling } from "./routes/billing";
import { handleQuickAuth } from "./routes/quick-auth";
import {
  type AgentEngineQueueMessage,
  handleAgentDiscover,
  handleAgentIntelBackfill,
  handleAgentEngineQueue,
  handleAgentEngineScheduled,
  handleAgentSearch,
  handleMarkSent,
  handleQuickFileUpload,
  handleQuickProfile,
  handleWaitlist,
} from "./routes/quick";

type Env = {
  DB: D1Database;
  FILES?: R2Bucket;
  WISHLIST_INDEX?: Vectorize;
  AI?: Ai;
  AGENT_DISCOVERY_QUEUE?: Queue<AgentEngineQueueMessage>;
  AGENT_VERIFICATION_QUEUE?: Queue<AgentEngineQueueMessage>;
  WISHLIST_EXTRACTION_QUEUE?: Queue<AgentEngineQueueMessage>;
  GENRE_NORMALIZATION_QUEUE?: Queue<AgentEngineQueueMessage>;
  RANKING_REFRESH_QUEUE?: Queue<AgentEngineQueueMessage>;
  OPEN_STATUS_REFRESH_QUEUE?: Queue<AgentEngineQueueMessage>;
  NOTIFICATION_CHECK_QUEUE?: Queue<AgentEngineQueueMessage>;
  APP_ORIGIN?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENAI_EMBEDDING_MODEL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  GOOGLE_SEARCH_API_KEY?: string;
  GOOGLE_SEARCH_CX?: string;
  BING_SEARCH_API_KEY?: string;
  BING_SEARCH_ENDPOINT?: string;
  EMAIL_WEBHOOK_URL?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_PRICE_ID?: string;
};

function configuredOrigins(env: Env) {
  return String(env.APP_ORIGIN || "*")
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

function corsOrigin(request: Request, env: Env) {
  const requestOrigin = request.headers.get("origin")?.replace(/\/$/, "");
  const allowedOrigins = configuredOrigins(env);
  const fallbackOrigin = allowedOrigins[0] || "*";

  if (!requestOrigin) return fallbackOrigin;
  if (fallbackOrigin === "*") return "*";
  if (allowedOrigins.includes(requestOrigin) || isLocalOrigin(requestOrigin)) return requestOrigin;
  return fallbackOrigin;
}

function withCors(request: Request, response: Response, env: Env) {
  response.headers.set("access-control-allow-origin", corsOrigin(request, env));
  response.headers.set("access-control-allow-headers", "authorization, content-type, stripe-signature");
  response.headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  response.headers.set("vary", "Origin");
  return response;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (request.method === "OPTIONS") return withCors(request, new Response(null, { status: 204 }), env);

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
        response = await handleAgentSearch(request, env, ctx);
      } else if (url.pathname === "/api/agents/discover") {
        response = await handleAgentDiscover(request, env, ctx);
      } else if (url.pathname === "/api/agents/refresh-intel") {
        response = await handleAgentIntelBackfill(request, env);
      } else if (url.pathname === "/api/profile") {
        response = await handleQuickProfile(request, env);
      } else if (url.pathname === "/api/submission-kit/file") {
        response = await handleQuickFileUpload(request, env);
      } else if (url.pathname === "/api/submissions/mark-sent") {
        response = await handleMarkSent(request, env);
      } else {
        response = textResponse("Not Found", 404);
      }

      return withCors(request, response, env);
    } catch (error) {
      if (error instanceof Response) return withCors(request, error, env);
      return withCors(request, badRequest(error instanceof Error ? error.message : "Unknown error.", 500), env);
    }
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleAgentEngineScheduled(controller, env));
  },
  async queue(batch: MessageBatch<AgentEngineQueueMessage>, env: Env) {
    await handleAgentEngineQueue(batch, env);
  },
} satisfies ExportedHandler<Env, AgentEngineQueueMessage>;

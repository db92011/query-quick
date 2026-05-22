import { requireSession } from "../lib/auth";
import { all, badRequest, json, one, run } from "../lib/db";

type Env = {
  DB: D1Database;
  FILES?: R2Bucket;
  WISHLIST_INDEX?: Vectorize;
  AGENT_DISCOVERY_QUEUE?: Queue<AgentEngineQueueMessage>;
  AGENT_VERIFICATION_QUEUE?: Queue<AgentEngineQueueMessage>;
  WISHLIST_EXTRACTION_QUEUE?: Queue<AgentEngineQueueMessage>;
  GENRE_NORMALIZATION_QUEUE?: Queue<AgentEngineQueueMessage>;
  RANKING_REFRESH_QUEUE?: Queue<AgentEngineQueueMessage>;
  OPEN_STATUS_REFRESH_QUEUE?: Queue<AgentEngineQueueMessage>;
  NOTIFICATION_CHECK_QUEUE?: Queue<AgentEngineQueueMessage>;
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
};

export type AgentEngineJobType =
  | "agent-discovery"
  | "agent-verification"
  | "wishlist-extraction"
  | "genre-normalization"
  | "ranking-refresh"
  | "open-status-refresh"
  | "notification-check";

export type AgentEngineQueueMessage = {
  job_id?: string;
  job_type: AgentEngineJobType;
  agent_id?: string;
  source_url?: string;
  genre?: string;
  subgenre?: string;
  category?: string;
  tone?: string;
  audience?: string;
  reason?: string;
  priority?: number;
  created_at?: string;
  payload?: Record<string, unknown>;
};

type AgentRecord = {
  agent_name: string;
  agency: string;
  genre_fit: string;
  matched_genre: string;
  matched_subgenre: string;
  genre_evidence: string;
  subgenre_evidence: string;
  fit_reason: string;
  email_opener?: string;
  query_method: "email" | "querytracker" | "querymanager" | "form" | "portal";
  submission_url?: string;
  public_email?: string;
  requirements_summary: string;
  required_materials?: Array<
    | "query_letter"
    | "concise_description"
    | "synopsis"
    | "first_pages"
    | "sample_chapters"
    | "proposal"
    | "logline"
    | "short_pitch"
    | "bio_paragraph"
    | "publishing_history"
    | "comps"
    | "trigger_warnings"
    | "inspiration"
    | "more_about_you"
    | "prizes"
  >;
  wishlist_summary?: string;
  submission_requirements?: Record<string, unknown>;
  submission_schema?: AgentSubmissionSchema;
  open_status: "open" | "selective" | "closed";
  source_url: string;
  source_urls?: string[];
  verification_notes?: string;
  submission_route_verified?: boolean;
  submission_route_verified_at?: string;
  submission_route_status?: number;
  submission_route_notes?: string;
  last_verified: string;
  confidence_score: number;
  seen_before?: boolean;
  intel_pending?: boolean;
};

type AgentSubmissionSchema = {
  method: AgentRecord["query_method"];
  requires_query_letter: boolean;
  requires_synopsis: boolean;
  synopsis_type: "" | "short" | "1_page" | "full";
  requires_bio: boolean;
  sample_pages: number;
  attachments_required: string[];
  form_fields: Record<string, unknown>;
  querymanager_enabled: boolean;
  email_submission_enabled: boolean;
  submission_url: string;
  last_verified: string;
  confidence: number;
};

type AgentCandidate = {
  agent_name: string;
  agency: string;
  genre_fit: string;
  matched_genre: string;
  matched_subgenre: string;
  genre_evidence: string;
  subgenre_evidence: string;
  fit_reason: string;
  query_method: "email" | "querytracker" | "querymanager" | "form" | "portal";
  submission_url?: string;
  public_email?: string;
  open_status: "open" | "selective";
  source_url: string;
  source_urls?: string[];
  last_verified: string;
  confidence_score: number;
};

type DiscoveryLane = {
  id: string;
  source: string;
  focus: string;
};

type AgentSearchDiagnostics = {
  raw_count: number;
  candidate_count: number;
  verified_count: number;
  soft_verified_count?: number;
  discovery_passes?: number;
  search_result_count?: number;
  search_context_used?: boolean;
  search_provider_errors?: string[];
  source_lanes?: string;
  source?: string;
  error?: string;
};

type SearchSnippet = {
  source: "google" | "bing" | "gemini-google";
  title: string;
  url: string;
  snippet: string;
};

type SearchSnippetResult = {
  snippets: SearchSnippet[];
  errors: string[];
};

type RouteVerificationResult = {
  agent: AgentRecord | null;
  status: number;
  notes: string;
  closed: boolean;
};

const MAX_AGENT_POOL_RESULTS = 750;
const ENRICHMENT_BATCH_SIZE = 12;
const TARGET_AGENT_POOL_SIZE = 337;
const DISCOVERY_PROVIDER_TIMEOUT_MS = 30000;
const SEARCH_PROVIDER_TIMEOUT_MS = 12000;
const STORED_POOL_DISCOVERY_BUDGET_MS = 18000;
const EMPTY_POOL_DISCOVERY_BUDGET_MS = 22000;
const SEARCH_RESULTS_PER_PROVIDER = 8;
const INSTANT_SEARCH_LIMIT = 50;
const SNAPSHOT_RETENTION_DAYS = 14;

const queueNames: Record<AgentEngineJobType, string> = {
  "agent-discovery": "agent-discovery",
  "agent-verification": "agent-verification",
  "wishlist-extraction": "wishlist-extraction",
  "genre-normalization": "genre-normalization",
  "ranking-refresh": "ranking-refresh",
  "open-status-refresh": "open-status-refresh",
  "notification-check": "notification-check",
};

const coreDiscoverySources = [
  "AALA member directory and AALA agent profile pages with public subject-focus and submissions status",
  "QueryTracker-style public search results",
  "Reedsy public agent directory pages",
  "agency websites and agency submission pages",
  "Manuscript Wish List and public agent profile pages",
  "LiteraryAgencies.com genre directory pages as broad lead lists",
  "The Wordling US literary agents list as agency and agent-name coverage",
  "1000 Literary Agents US listings as query-status and genre lead coverage",
  "RegionalDirectory.us literary agency listings as low-confidence agency locator leads",
  "agent interviews, podcast notes, and video guidance",
];

const sourceReliabilityGuidance = [
  "AALA profiles are high-priority professional directory sources for subject focus and open/closed status, but still verify the exact submission route and requirements from the AALA profile or agency page before marking a record ready.",
  "LiteraryAgencies.com genre pages can seed agent names, agencies, and genre hints; treat those claims as leads until confirmed by AALA, agency, QueryManager, QueryTracker, MSWL, or another primary source.",
  "The Wordling's US literary agents list is useful for agency and agent-name coverage, but it does not prove open status, genre fit, or submission requirements.",
  "1000LiteraryAgents.com can seed query-status and broad genre leads, but its rows must be cross-checked against current AALA, agency, QueryManager, QueryTracker, or direct submission pages before use.",
  "RegionalDirectory.us is only a low-confidence agency locator source because listings may be stale or non-agent-adjacent; never use it alone to mark an agent open or genre-matched.",
];

const genericStoredTerms = new Set(["adult", "adult fiction", "fiction", "nonfiction", "this category"]);

const allowedFileKinds = new Set([
  "query_letter",
  "concise_description",
  "synopsis",
  "first_pages",
  "sample_chapters",
  "proposal",
  "logline",
  "short_pitch",
  "bio_paragraph",
  "publishing_history",
  "comps",
  "trigger_warnings",
  "inspiration",
  "more_about_you",
  "prizes",
]);

function clean(value: unknown) {
  return String(value || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function clampScore(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function queueBindingForJob(env: Env, jobType: AgentEngineJobType) {
  const bindings: Record<AgentEngineJobType, Queue<AgentEngineQueueMessage> | undefined> = {
    "agent-discovery": env.AGENT_DISCOVERY_QUEUE,
    "agent-verification": env.AGENT_VERIFICATION_QUEUE,
    "wishlist-extraction": env.WISHLIST_EXTRACTION_QUEUE,
    "genre-normalization": env.GENRE_NORMALIZATION_QUEUE,
    "ranking-refresh": env.RANKING_REFRESH_QUEUE,
    "open-status-refresh": env.OPEN_STATUS_REFRESH_QUEUE,
    "notification-check": env.NOTIFICATION_CHECK_QUEUE,
  };
  return bindings[jobType];
}

function canonicalJobPayload(message: AgentEngineQueueMessage) {
  return {
    ...message,
    created_at: message.created_at || nowIso(),
    priority: Number(message.priority || 50),
    payload: message.payload || {},
  };
}

function cacheKey(body: Record<string, unknown>) {
  return ["v8", body.genre, body.subgenre, body.category].map((value) => clean(value).toLowerCase()).join("::");
}

function normalizedAgentKey(agent: AgentRecord) {
  return `${agent.agent_name}::${agent.agency}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function normalizeSearchText(value: unknown) {
  return clean(value).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function wishlistSummaryForAgent(agent: Partial<AgentRecord>) {
  const direct = clean(agent.wishlist_summary);
  if (direct) return direct;
  const parts = [
    clean(agent.matched_genre) ? `Genre: ${clean(agent.matched_genre)}.` : "",
    clean(agent.matched_subgenre) ? `Wishlist/subgenre signal: ${clean(agent.matched_subgenre)}.` : "",
    clean(agent.genre_evidence),
    clean(agent.subgenre_evidence),
    clean(agent.fit_reason),
  ].filter(Boolean);
  return parts.join(" ").slice(0, 1200);
}

function agentNeedsIntel(agent: Partial<AgentRecord>) {
  const summary = clean(agent.requirements_summary).toLowerCase();
  return (
    !summary ||
    summary.includes("building agent intel") ||
    summary.includes("indexing") ||
    !Array.isArray(agent.required_materials) ||
    agent.required_materials.length <= 1 ||
    !clean(agent.verification_notes) ||
    !clean(agent.email_opener)
  );
}

function validUrl(value: string | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function validEmail(value: string | undefined) {
  return /\S+@\S+\.\S+/.test(value || "");
}

function fallbackAgentSourceUrl(agentName: string, agency: string) {
  const query = encodeURIComponent([agentName, agency, "literary agent submissions"].filter(Boolean).join(" "));
  return `https://www.google.com/search?q=${query}`;
}

function hasUsableAgentLead(agent: Partial<AgentRecord | AgentCandidate>) {
  const sourceUrls = Array.isArray(agent.source_urls) ? agent.source_urls : [];
  return (
    validEmail(agent.public_email) ||
    validUrl(agent.submission_url) ||
    validUrl(agent.source_url) ||
    sourceUrls.some((url) => validUrl(clean(url)))
  );
}

function filterAgents(agents: AgentRecord[]) {
  return agents.filter((agent) => {
    if (!agent.agent_name || !agent.agency || !agent.requirements_summary) return false;
    const hasGenreSignal = [
      agent.genre_fit,
      agent.matched_genre,
      agent.matched_subgenre,
      agent.genre_evidence,
      agent.subgenre_evidence,
      agent.fit_reason,
    ].some((value) => Boolean(clean(value)));
    if (!hasGenreSignal) return false;
    if (!["email", "querytracker", "querymanager", "form", "portal"].includes(agent.query_method)) return false;
    if (!["open", "selective", "closed"].includes(agent.open_status)) return false;
    if (agent.open_status === "closed") return false;
    if (!hasUsableAgentLead(agent)) return false;
    if (!agent.last_verified || Number.isNaN(Date.parse(agent.last_verified))) return false;
    if (Number(agent.confidence_score || 0) < 50) return false;
    if (agent.query_method === "email") return validEmail(agent.public_email) && validUrl(agent.source_url);
    return validUrl(agent.submission_url) || validUrl(agent.source_url);
  });
}

function inferRequiredMaterials(value: string) {
  const text = normalizePageText(value);
  const inferred: NonNullable<AgentRecord["required_materials"]> = ["query_letter"];
  const add = (key: NonNullable<AgentRecord["required_materials"]>[number]) => {
    if (!inferred.includes(key)) inferred.push(key);
  };

  if (/(concise|brief|short).{0,40}(description|summary)|description of (your|the) (work|book|manuscript)/.test(text)) add("concise_description");
  if (/synopsis/.test(text)) add("synopsis");
  if (/(first|sample).{0,30}(page|pages)|\b\d+\s+pages?\b/.test(text)) add("first_pages");
  if (/(first|sample).{0,30}(chapter|chapters)|sample chapters?/.test(text)) add("sample_chapters");
  if (/proposal|nonfiction proposal/.test(text)) add("proposal");
  if (/logline/.test(text)) add("logline");
  if (/(one paragraph|short).{0,30}(pitch|summary)|\bpitch\b/.test(text)) add("short_pitch");
  if (/bio|biographical|about you|author information|writer information/.test(text)) add("bio_paragraph");
  if (/publishing history|publication history|publishing credits|publication credits|previously published|credentials/.test(text)) add("publishing_history");
  if (/comp titles|comparison titles|comparable titles|books in conversation|comps\b/.test(text)) add("comps");
  if (/trigger warning|content warning/.test(text)) add("trigger_warnings");
  if (/why now|why you wrote|inspiration/.test(text)) add("inspiration");
  if (/more about you|tell us who you are|your journey/.test(text)) add("more_about_you");
  if (/prize|award|contest|fellowship/.test(text)) add("prizes");
  return inferred;
}

function tokenToPageCount(value: string) {
  const normalized = value.toLowerCase().replace(/\s+/g, "-");
  const numeric = Number(normalized);
  if (Number.isFinite(numeric) && numeric > 0) return Math.max(1, Math.min(50, Math.floor(numeric)));
  const words: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    twenty: 20,
    "twenty-five": 25,
    thirty: 30,
    forty: 40,
    fifty: 50,
  };
  return words[normalized] || 0;
}

function inferSamplePageCount(value: string) {
  const numberPattern = "(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty|twenty five|twenty-five|thirty|forty|fifty)";
  const text = normalizePageText(value);
  const patterns = [
    new RegExp(`first\\s+${numberPattern}\\s+(?:manuscript\\s+)?pages?`),
    new RegExp(`${numberPattern}\\s*[- ]page\\s+(?:sample|excerpt|submission|attachment)`),
    new RegExp(`(?:send|submit|include|paste|attach|upload)\\s+(?:the\\s+)?(?:first\\s+)?${numberPattern}\\s+(?:manuscript\\s+)?pages?`),
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const count = match?.[1] ? tokenToPageCount(match[1]) : 0;
    if (count) return count;
  }
  return 0;
}

function inferSynopsisType(value: string): AgentSubmissionSchema["synopsis_type"] {
  const text = normalizePageText(value);
  if (!/synopsis/.test(text)) return "";
  if (/1[- ]page synopsis|one[- ]page synopsis|single[- ]page synopsis/.test(text)) return "1_page";
  if (/short synopsis|brief synopsis|concise synopsis/.test(text)) return "short";
  if (/full synopsis|complete synopsis/.test(text)) return "full";
  return "";
}

function submissionSchemaForAgent(agent: AgentRecord): AgentSubmissionSchema {
  const text = [
    agent.requirements_summary,
    agent.verification_notes,
    agent.submission_route_notes,
    JSON.stringify(agent.submission_requirements || {}),
  ].filter(Boolean).join(" ");
  const required = new Set(agent.required_materials || inferRequiredMaterials(text));
  required.add("query_letter");
  const samplePages = inferSamplePageCount(text);
  if (samplePages) required.add("first_pages");
  const attachmentsRequired = Array.from(required).map((field) => (
    field === "first_pages" && samplePages ? `first_${samplePages}_pages` : field
  ));
  const routeUrl = submissionRouteUrl(agent);
  return {
    method: agent.query_method,
    requires_query_letter: required.has("query_letter"),
    requires_synopsis: required.has("synopsis"),
    synopsis_type: inferSynopsisType(text),
    requires_bio: required.has("bio_paragraph"),
    sample_pages: samplePages,
    attachments_required: attachmentsRequired,
    form_fields: {},
    querymanager_enabled: agent.query_method === "querymanager" || routeUrl.includes("querymanager.com"),
    email_submission_enabled: agent.query_method === "email",
    submission_url: agent.query_method === "email" ? agent.public_email || "" : routeUrl,
    last_verified: agent.last_verified,
    confidence: Math.max(0, Math.min(100, Number(agent.confidence_score || 0))),
  };
}

function normalizeAgent(agent: AgentRecord): AgentRecord {
  const requirementText = [
    agent.requirements_summary,
    agent.verification_notes,
    agent.genre_evidence,
    agent.subgenre_evidence,
    agent.fit_reason,
  ].map(clean).join(" ");
  const inferredMaterials = inferRequiredMaterials(requirementText);
  const requiredMaterials: NonNullable<AgentRecord["required_materials"]> = Array.from(new Set([
    "query_letter",
    ...inferredMaterials,
    ...(Array.isArray(agent.required_materials) ? agent.required_materials : []),
  ]));
  const normalized: AgentRecord = {
    ...agent,
    matched_genre: clean(agent.matched_genre),
    matched_subgenre: clean(agent.matched_subgenre),
    genre_evidence: clean(agent.genre_evidence),
    subgenre_evidence: clean(agent.subgenre_evidence),
    fit_reason: clean(agent.fit_reason),
    email_opener: clean(agent.email_opener),
    wishlist_summary: wishlistSummaryForAgent(agent),
    submission_requirements: agent.submission_requirements || {},
    source_urls: Array.isArray(agent.source_urls) && agent.source_urls.length ? agent.source_urls : [agent.source_url],
    verification_notes: clean(agent.verification_notes),
    submission_route_verified: agent.submission_route_verified !== false,
    submission_route_verified_at: clean(agent.submission_route_verified_at),
    submission_route_status: Number(agent.submission_route_status || 0),
    submission_route_notes: clean(agent.submission_route_notes),
    required_materials: requiredMaterials,
  };
  return {
    ...normalized,
    submission_schema: agent.submission_schema || submissionSchemaForAgent(normalized),
  };
}

function submissionRouteUrl(agent: AgentRecord) {
  if (agent.query_method === "email") return agent.source_url;
  return agent.submission_url || agent.source_url;
}

function routeName(agent: AgentRecord) {
  const routeUrl = submissionRouteUrl(agent);
  if (agent.query_method === "email") return "email guidelines";
  if (agent.query_method === "querytracker" || routeUrl.includes("querytracker.net")) return "QueryTracker submission page";
  if (agent.query_method === "querymanager") return "QueryManager page";
  if (agent.query_method === "form") return "personal website submission form";
  return "submission portal";
}

function liveSubmissionStatus(status: number) {
  return status > 0 && status < 500 && status !== 404 && status !== 410;
}

function normalizePageText(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ");
}

function routePageSaysClosed(value: string) {
  const text = normalizePageText(value);
  return [
    "not currently open",
    "not open right now",
    "not open at this time",
    "not open to queries",
    "not accepting queries",
    "not accepting submissions",
    "currently closed",
    "closed to queries",
    "closed to submissions",
    "temporarily closed",
    "no longer accepting",
    "is closed to queries",
    "is closed to submissions",
    "is not currently accepting",
    "this agent is not currently accepting",
    "not available for querying",
    "not presently accepting",
    "query window is closed",
    "submission window is closed",
  ].some((phrase) => text.includes(phrase));
}

async function verifySubmissionRouteResult(agent: AgentRecord): Promise<RouteVerificationResult> {
  const routeUrl = submissionRouteUrl(agent);
  if (!validUrl(routeUrl)) return { agent: null, status: 0, notes: "Submission route URL is missing or invalid.", closed: false };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(routeUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "user-agent": "QueryQuickBot/1.0 (+https://querysalon.com)",
      },
    });
    if (!liveSubmissionStatus(response.status)) {
      return { agent: null, status: response.status, notes: `${routeName(agent)} returned HTTP ${response.status}.`, closed: response.status === 404 || response.status === 410 };
    }
    const pageText = await response.text();
    if (routePageSaysClosed(pageText)) {
      return { agent: null, status: response.status, notes: `${routeName(agent)} loaded but says the agent is not currently open.`, closed: true };
    }
    return {
      agent: {
        ...agent,
        submission_route_verified: true,
        submission_route_verified_at: new Date().toISOString(),
        submission_route_status: response.status,
        submission_route_notes:
          agent.query_method === "email"
            ? `Email route kept because the public ${routeName(agent)} page responded with HTTP ${response.status} and the email address is present.`
            : `${routeName(agent)} responded with HTTP ${response.status}.`,
      },
      status: response.status,
      notes: `${routeName(agent)} responded with HTTP ${response.status}.`,
      closed: false,
    };
  } catch {
    return { agent: null, status: 0, notes: `${routeName(agent)} could not be verified during this refresh window.`, closed: false };
  } finally {
    clearTimeout(timeout);
  }
}

async function verifySubmissionRoute(agent: AgentRecord): Promise<AgentRecord | null> {
  return (await verifySubmissionRouteResult(agent)).agent;
}

async function verifySubmissionRoutes(agents: AgentRecord[]) {
  const verified = await Promise.all(agents.map((agent) => verifySubmissionRoute(agent)));
  return verified.filter((agent): agent is AgentRecord => Boolean(agent));
}

async function softVerifySubmissionRoutes(agents: AgentRecord[]) {
  return agents.map((agent) => {
    if (agent.submission_route_verified) return agent;
    return normalizeAgent({
      ...agent,
      submission_route_verified: false,
      submission_route_verified_at: new Date().toISOString(),
      submission_route_status: 0,
      submission_route_notes: "Stage-one download kept this source-backed route. Agent Intel must confirm the exact requirements before sending.",
      verification_notes: clean(agent.verification_notes) || "Stage-one discovery kept this source-backed agent for Agent Intel review.",
      intel_pending: true,
    });
  });
}

function dedupeAgents(agents: AgentRecord[]) {
  const seen = new Set<string>();
  const deduped: AgentRecord[] = [];
  for (const agent of agents) {
    const key = normalizedAgentKey(agent);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(agent);
  }
  return deduped;
}

async function userSeenAgentKeys(env: Env, userId: string) {
  const rows = await all<{ normalized_key: string }>(
    env.DB,
    `SELECT DISTINCT lower(agent_name || '::' || agency) AS normalized_key
     FROM quick_submissions
     WHERE user_id = ?1`,
    [userId]
  );
  return new Set(rows.map((row) => row.normalized_key.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")));
}

function markSeenBefore(agents: AgentRecord[], seenKeys: Set<string>) {
  return agents.map((agent) => ({
    ...agent,
    seen_before: seenKeys.has(normalizedAgentKey(agent)),
  }));
}

function safeJsonArray(value: string, fallback: string[] = []) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function timeoutSignal(timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timeout) };
}

function stripHtml(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchSourceSnippet(url: string) {
  if (!validUrl(url)) return "";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6500);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.6",
        "user-agent": "QueryQuickBot/1.0 (+https://querysalon.com)",
      },
    });
    if (!liveSubmissionStatus(response.status)) return "";
    const text = stripHtml(await response.text());
    return text.slice(0, 2400);
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

async function buildGuidelineContext(agents: AgentRecord[]) {
  const contexts = await Promise.all(agents.map(async (agent, index) => {
    const urls = Array.from(new Set([
      submissionRouteUrl(agent),
      agent.source_url,
      ...(agent.source_urls || []),
    ].filter(validUrl))).slice(0, 3);
    const snippets = await Promise.all(urls.map(async (url) => ({ url, text: await fetchSourceSnippet(url) })));
    const usable = snippets.filter((snippet) => snippet.text);
    if (!usable.length) {
      return `${index + 1}. ${agent.agent_name} — ${agent.agency}
Route: ${submissionRouteUrl(agent)}
No readable page snippet was available. Use live web search and public source pages to verify exact submission requirements.`;
    }
    return `${index + 1}. ${agent.agent_name} — ${agent.agency}
Route: ${submissionRouteUrl(agent)}
Source snippets:
${usable.map((snippet) => `- ${snippet.url}\n  ${snippet.text}`).join("\n")}`;
  }));
  return contexts.join("\n\n");
}

function extractResponseText(data: unknown) {
  const direct = (data as { output_text?: unknown })?.output_text;
  if (typeof direct === "string") return direct;
  const output = (data as { output?: Array<{ content?: Array<{ text?: unknown }> }> })?.output || [];
  for (const item of output) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") return content.text;
    }
  }
  return "{\"agents\":[]}";
}

function extractJsonText(value: string) {
  const trimmed = value.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  if (trimmed.startsWith("{")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : "{\"agents\":[]}";
}

function parseAgentCandidates(value: string): AgentCandidate[] {
  try {
    const cleaned = value.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    const parsed = JSON.parse(cleaned.startsWith("[") ? cleaned : extractJsonText(value)) as { agents?: unknown; candidates?: unknown };
    const agents = Array.isArray(parsed.agents)
      ? parsed.agents
      : Array.isArray(parsed.candidates)
        ? parsed.candidates
        : Array.isArray(parsed)
          ? parsed
          : [];
    return agents as AgentCandidate[];
  } catch {
    return [];
  }
}

async function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Response) {
    try {
      const data = await error.clone().json() as { error?: string; message?: string };
      return data.error || data.message || fallback;
    } catch {
      try {
        return await error.clone().text() || fallback;
      } catch {
        return fallback;
      }
    }
  }
  return error instanceof Error ? error.message : fallback;
}

function inferCandidateQueryMethod(candidate: AgentCandidate): AgentRecord["query_method"] {
  const routeText = [candidate.submission_url, candidate.source_url, ...(candidate.source_urls || [])]
    .map(clean)
    .join(" ")
    .toLowerCase();
  if (candidate.query_method === "email" && validEmail(candidate.public_email)) return "email";
  if (routeText.includes("querymanager")) return "querymanager";
  if (routeText.includes("querytracker")) return "querytracker";
  if (candidate.query_method === "form") return "form";
  if (candidate.query_method === "portal" || candidate.query_method === "querymanager" || candidate.query_method === "querytracker") {
    return candidate.query_method;
  }
  if (validEmail(candidate.public_email)) return "email";
  return "portal";
}

function candidateToAgent(candidate: AgentCandidate): AgentRecord {
  const queryMethod = inferCandidateQueryMethod(candidate);
  const sourceUrl = validUrl(candidate.source_url)
    ? candidate.source_url
    : validUrl(candidate.submission_url)
      ? candidate.submission_url || ""
      : fallbackAgentSourceUrl(candidate.agent_name, candidate.agency);
  return normalizeAgent({
    agent_name: candidate.agent_name,
    agency: candidate.agency,
    genre_fit: candidate.genre_fit,
    matched_genre: candidate.matched_genre,
    matched_subgenre: candidate.matched_subgenre,
    genre_evidence: candidate.genre_evidence,
    subgenre_evidence: candidate.subgenre_evidence,
    fit_reason: candidate.fit_reason,
    email_opener: "",
    query_method: queryMethod,
    submission_url: candidate.submission_url || "",
    public_email: candidate.public_email || "",
    requirements_summary: "Building Agent Intel...",
    required_materials: ["query_letter"],
    wishlist_summary: [
      candidate.genre_evidence,
      candidate.subgenre_evidence,
      candidate.fit_reason,
    ].map(clean).filter(Boolean).join(" "),
    submission_requirements: {},
    open_status: candidate.open_status,
    source_url: sourceUrl,
    source_urls: Array.from(new Set([
      sourceUrl,
      ...(Array.isArray(candidate.source_urls) ? candidate.source_urls : []),
    ])).filter(validUrl),
    verification_notes: "Live candidate discovered; Query Quick is building Agent Intel.",
    submission_route_verified: false,
    submission_route_notes: "Stage-one download kept this source-backed route. Agent Intel must confirm the exact requirements before sending.",
    last_verified: clean(candidate.last_verified) || new Date().toISOString().slice(0, 10),
    confidence_score: Number(candidate.confidence_score || 45),
    intel_pending: true,
  });
}

function genreExpansionTerms(body: Record<string, unknown>) {
  const genre = clean(body.genre);
  const subgenre = clean(body.subgenre);
  const category = clean(body.category);
  const combined = `${genre} ${subgenre}`.toLowerCase();
  const terms = [
    genre,
    subgenre,
    category,
  ].filter(Boolean);
  if (/romance|rom-?com|romantasy|love story|historical romance|paranormal romance|contemporary romance/.test(combined)) {
    terms.push("romance", "romantic comedy", "contemporary romance", "historical romance", "paranormal romance", "romantasy");
  }
  if (/upmarket|women|woman|book club|rom-?com|romance|literary|commercial/.test(combined)) {
    terms.push("women's fiction", "book club fiction", "upmarket fiction", "literary fiction", "commercial fiction", "crossover fiction");
  }
  if (/fantasy|romantasy|speculative|sff|sci[- ]?fi|science fiction|horror|paranormal|supernatural|dystopian/.test(combined)) {
    terms.push("speculative fiction", "SFF", "fantasy", "science fiction", "sci-fi", "horror", "paranormal", "crossover fiction");
  }
  if (/thriller|mystery|crime|suspense|noir/.test(combined)) {
    terms.push("thriller", "mystery", "crime fiction", "suspense", "noir", "commercial fiction");
  }
  if (/historical/.test(combined)) {
    terms.push("historical fiction", "historical novel", "historical");
  }
  if (/\bya\b|young adult|teen/.test(combined) || /\bya\b|young adult/.test(category.toLowerCase())) {
    terms.push("young adult", "YA", "teen fiction");
  }
  if (/middle grade|\bmg\b|kidlit|children/.test(combined) || /middle grade|children/.test(category.toLowerCase())) {
    terms.push("middle grade", "MG", "kidlit", "children's books");
  }
  if (/picture book|chapter book|early reader/.test(combined)) {
    terms.push("picture book", "chapter book", "early reader", "children's books");
  }
  if (/memoir|narrative nonfiction|nonfiction|self-help|business|history|essay/.test(combined)) {
    terms.push("narrative nonfiction", "memoir", "nonfiction", "prescriptive nonfiction", "proposal-driven nonfiction", "essay collection");
  }
  return Array.from(new Set(terms.map((term) => term.toLowerCase()))).slice(0, 18);
}

function storedPoolTerms(body: Record<string, unknown>) {
  const genre = clean(body.genre).toLowerCase();
  const subgenre = clean(body.subgenre).toLowerCase();
  const combined = `${genre} ${subgenre}`;
  const terms = [
    genre,
    ...subgenre.split(/[\/,;|]+/).map((term) => term.trim()),
  ].filter((term) => term && !genericStoredTerms.has(term));

  if (/fantasy|romantasy|speculative|sff/.test(combined)) terms.push("fantasy", "romantasy", "speculative fiction", "SFF");
  if (/sci[- ]?fi|science fiction/.test(combined)) terms.push("science fiction", "sci-fi", "SFF", "speculative fiction");
  if (/horror|paranormal|supernatural/.test(combined)) terms.push("horror", "paranormal", "supernatural", "speculative fiction");
  if (/thriller|mystery|crime|suspense|noir/.test(combined)) terms.push("thriller", "mystery", "crime fiction", "suspense", "noir");
  if (/romance|rom-?com/.test(genre)) terms.push("romance", "romantic comedy", "rom-com", "contemporary romance");
  if (/upmarket|women|woman|book club|literary|commercial/.test(combined)) terms.push("upmarket fiction", "women's fiction", "book club fiction", "literary fiction", "commercial fiction");
  if (/middle grade|\bmg\b|kidlit|children/.test(combined)) terms.push("middle grade", "MG", "kidlit", "children's books");
  if (/\bya\b|young adult|teen/.test(combined)) terms.push("young adult", "YA", "teen fiction");
  if (/memoir|narrative nonfiction|self-help|business|history|essay/.test(combined)) terms.push("memoir", "narrative nonfiction", "prescriptive nonfiction", "essay collection");

  return Array.from(new Set(terms.map((term) => term.toLowerCase()))).slice(0, 16);
}

function candidateDiscoveryPrompt(body: Record<string, unknown>) {
  const alreadySeen = Array.isArray(body.exclude_agents)
    ? (body.exclude_agents as unknown[]).map(clean).filter(Boolean).slice(0, 450)
    : [];
  const discoveryFocus = clean(body.discovery_focus);
  const discoveryLane = clean(body.discovery_lane);
  const discoverySource = clean(body.discovery_source);
  const expandedTerms = Array.isArray(body.expanded_genres)
    ? (body.expanded_genres as unknown[]).map(clean).filter(Boolean)
    : genreExpansionTerms(body);
  const searchContext = clean(body.search_context);
  const exclusionText = alreadySeen.length
    ? `\nAvoid returning these already-seen agents unless there are no alternatives:\n${alreadySeen.map((agent) => `- ${agent}`).join("\n")}\nKeep searching deeper for different agents beyond this list.`
    : "";
  const searchContextText = searchContext
    ? `\nSearch-engine source snippets for this pass:\n${searchContext}\nUse these snippets as leads only. Verify agent fit, open status, and submission route before returning a record.`
    : "";
  return `Find currently open literary agent submission candidates for this project.

Genre: ${clean(body.genre)}
Subgenre: ${clean(body.subgenre)}
Category: ${clean(body.category)}
Discovery focus: ${discoveryFocus || "broad genre/subgenre pool"}
Discovery lane: ${discoveryLane || "general"}
Preferred source lane: ${discoverySource || coreDiscoverySources.join(", ")}
Expanded genre boundaries: ${expandedTerms.join(", ")}
Source reliability rules:
${sourceReliabilityGuidance.map((rule) => `- ${rule}`).join("\n")}

Return as many unique agents as you can for this specific focus, aiming for 40-75 useful records in this pass when the public sources support it. Do not stop after a handful of obvious names.
This is stage one only: discovery and live submission route candidates. Agent Intel will fill missing requirements later.
Include an agent when you can identify the agent name, agency, genre/subgenre fit, and either a specific submission route, public query email, or a reliable public source/profile page that can lead Agent Intel to the route.
Do not include closed agents. Do not include QueryTracker/QueryManager pages that say not open, temporarily closed, or not accepting queries.
Use current public web sources. Prefer the source lane above, then expand to ${coreDiscoverySources.join("; ")}.
Search beyond the obvious top results and keep going through directories/profile pages so we can build depth over time. Treat adjacent categories as valid when the evidence supports the user's project.
Do not write long explanations. Keep evidence to one short sentence per field.${exclusionText}${searchContextText}

Return JSON only in this exact shape:
{
  "agents": [
    {
      "agent_name": "",
      "agency": "",
      "genre_fit": "",
      "matched_genre": "",
      "matched_subgenre": "",
      "genre_evidence": "",
      "subgenre_evidence": "",
      "fit_reason": "",
      "query_method": "email",
      "submission_url": "",
      "public_email": "",
      "open_status": "open",
      "source_url": "",
      "source_urls": [],
      "last_verified": "2026-04-29",
      "confidence_score": 80
    }
  ]
}`;
}

function sourceCandidateList(body: Record<string, unknown>) {
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  return candidates
    .map((candidate) => {
      const agent = candidate as Partial<AgentRecord>;
      const materials = Array.isArray(agent.required_materials) ? agent.required_materials : [];
      const summary = clean(agent.requirements_summary);
      if (summary && !agentNeedsIntel(agent)) {
        return normalizeAgent(agent as AgentRecord);
      }
      return candidateToAgent(candidate as AgentCandidate);
    })
    .filter((agent) => agent.agent_name && agent.agency && validUrl(submissionRouteUrl(agent)))
    .slice(0, MAX_AGENT_POOL_RESULTS);
}

async function candidatesFromRaw(rawAgents: AgentCandidate[], diagnosticsPatch: Partial<AgentSearchDiagnostics> = {}) {
  const candidates = rawAgents.map(candidateToAgent);
  const filtered = candidates.filter((agent) => {
    if (!agent.agent_name || !agent.agency) return false;
    if (!["open", "selective"].includes(agent.open_status)) return false;
    if (Number(agent.confidence_score || 0) < 20) return false;
    if (!hasUsableAgentLead(agent)) return false;
    if (agent.query_method === "email") return validEmail(agent.public_email);
    return validUrl(agent.submission_url) || validUrl(agent.source_url);
  });
  const verified = await softVerifySubmissionRoutes(dedupeAgents(filtered));
  return {
    agents: verified,
    diagnostics: {
      raw_count: rawAgents.length,
      candidate_count: filtered.length,
      verified_count: verified.length,
      soft_verified_count: verified.filter((agent) => agent.submission_route_verified === false).length,
      ...diagnosticsPatch,
    },
  };
}

async function generateAgentCandidates(env: Env, body: Record<string, unknown>) {
  if (!env.OPENAI_API_KEY) throw badRequest("Agent search is not configured yet. Missing OPENAI_API_KEY.", 503);
  const prompt = candidateDiscoveryPrompt(body);

  let response: Response;
  const timeout = timeoutSignal(DISCOVERY_PROVIDER_TIMEOUT_MS);
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: timeout.signal,
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: clean(env.OPENAI_MODEL) || "gpt-4.1-mini",
        tools: [{ type: "web_search_preview" }],
        input: [
          {
            role: "system",
            content: "You discover currently open literary agent candidates and source-backed submission routes. Return JSON only. Do not include closed agents.",
          },
          { role: "user", content: prompt },
        ],
        max_output_tokens: 8000,
      }),
    });
  } catch (error) {
    throw error;
  } finally {
    timeout.clear();
  }
  const data = await response.json() as { error?: { message?: string }; status?: string; incomplete_details?: { reason?: string } };
  if (!response.ok) throw badRequest(data.error?.message || "Agent discovery failed.", response.status);
  if (data.status === "incomplete") {
    throw badRequest(`Agent discovery stopped before returning candidates: ${data.incomplete_details?.reason || "incomplete response"}.`, 502);
  }
  return candidatesFromRaw(parseAgentCandidates(extractResponseText(data)));
}

async function generateGeminiCandidates(env: Env, body: Record<string, unknown>) {
  if (!env.GEMINI_API_KEY) throw badRequest("Gemini discovery is not configured.", 503);
  const model = clean(env.GEMINI_MODEL) || "gemini-2.5-flash";
  const timeout = timeoutSignal(DISCOVERY_PROVIDER_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, {
      method: "POST",
      signal: timeout.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: candidateDiscoveryPrompt(body) }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 8000 },
      }),
    });
  } finally {
    timeout.clear();
  }
  const data = await response.json() as {
    error?: { message?: string };
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> };
    }>;
  };
  if (!response.ok) throw badRequest(data.error?.message || "Gemini discovery failed.", response.status);
  const groundedSources = parseGeminiGroundedSourceSnippets(data);
  const text = (data.candidates || [])
    .flatMap((candidate) => candidate.content?.parts || [])
    .map((part) => part.text || "")
    .join("\n");
  return candidatesFromRaw(parseAgentCandidates(text), {
    search_result_count: groundedSources.length,
    search_context_used: groundedSources.length > 0,
  });
}

async function generateClaudeCandidates(env: Env, body: Record<string, unknown>) {
  if (!env.ANTHROPIC_API_KEY) throw badRequest("Claude discovery is not configured.", 503);
  const timeout = timeoutSignal(DISCOVERY_PROVIDER_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: timeout.signal,
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: clean(env.ANTHROPIC_MODEL) || "claude-sonnet-4-5",
        max_tokens: 8000,
        temperature: 0.2,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: candidateDiscoveryPrompt(body) }],
      }),
    });
  } finally {
    timeout.clear();
  }
  const data = await response.json() as {
    error?: { message?: string };
    content?: Array<{ type?: string; text?: string }>;
  };
  if (!response.ok) throw badRequest(data.error?.message || "Claude discovery failed.", response.status);
  const text = (data.content || []).filter((part) => part.type === "text").map((part) => part.text || "").join("\n");
  return candidatesFromRaw(parseAgentCandidates(text));
}

function searchQueriesForLane(body: Record<string, unknown>) {
  const genre = clean(body.genre);
  const subgenre = clean(body.subgenre);
  const category = clean(body.category);
  const lane = clean(body.discovery_lane);
  const expanded = genreExpansionTerms(body)
    .filter((term) => term !== genre.toLowerCase() && term !== subgenre.toLowerCase() && term !== category.toLowerCase())
    .slice(0, 5)
    .join(" ");
  const bases = Array.from(new Set([
    [category, genre, subgenre].filter(Boolean).join(" "),
    [category, expanded].filter(Boolean).join(" "),
  ].filter(Boolean)));
  const laneTerms: Record<string, string[]> = {
    broad: ["literary agents accepting queries", "literary agent submissions"],
    aala: ["site:aalitagents.org/agents AALA agents submissions subject focus", "site:aalitagents.org/author literary agent submissions subject focus"],
    querytracker: ["QueryTracker literary agents open to queries", "querytracker accepting queries literary agent"],
    querymanager: ["QueryManager literary agent submission form", "querymanager open submissions literary agent"],
    mswl: ["Manuscript Wish List literary agent", "MSWL literary agent wishlist"],
    agency: ["literary agency submission guidelines agents accepting queries", "agency submissions literary agent profile"],
    "newer-agents": ["new literary agent building list", "associate literary agent accepting queries"],
    boutique: ["boutique literary agency submissions", "independent literary agents accepting queries"],
    "source-directories": ["AALA LiteraryAgencies The Wordling 1000 Literary Agents agent directory", "literary agent directory genre agency accepting queries"],
    literaryagencies: ["site:literaryagencies.com literary agents accepting new writers", "site:literaryagencies.com genre literary agents AALA Member"],
    wordling: ["site:thewordling.com/literary-agents-us literary agents agency list", "The Wordling US literary agents agency"],
    "1000literaryagents": ["site:1000literaryagents.com/literary-agents-us.php accepts queries literary agent", "1000 Literary Agents accepts queries genre"],
    regionaldirectory: ["site:literary-agents.regionaldirectory.us literary agents agency", "RegionalDirectory literary agents agency website"],
    "deep-directory": ["literary agent directory accepting submissions", "literary agent profile submissions"],
    google: ["literary agents accepting queries", "agency profile submission guidelines"],
    bing: ["literary agents accepting submissions", "new literary agents accepting queries"],
  };
  const terms = laneTerms[lane] || ["literary agents accepting queries", "submission guidelines literary agent"];
  return terms
    .flatMap((term) => bases.map((base) => [base, term].filter(Boolean).join(" ")))
    .slice(0, 4);
}

async function fetchGoogleSearchSnippets(env: Env, query: string): Promise<SearchSnippetResult> {
  if (!env.GOOGLE_SEARCH_API_KEY || !env.GOOGLE_SEARCH_CX) return { snippets: [], errors: [] };
  const timeout = timeoutSignal(SEARCH_PROVIDER_TIMEOUT_MS);
  try {
    const url = new URL("https://customsearch.googleapis.com/customsearch/v1");
    url.searchParams.set("key", env.GOOGLE_SEARCH_API_KEY);
    url.searchParams.set("cx", env.GOOGLE_SEARCH_CX);
    url.searchParams.set("q", query);
    url.searchParams.set("num", String(SEARCH_RESULTS_PER_PROVIDER));
    const response = await fetch(url.toString(), { signal: timeout.signal });
    const data = await response.json() as {
      items?: Array<{ title?: string; link?: string; snippet?: string }>;
      error?: { message?: string };
    };
    if (!response.ok) {
      return { snippets: [], errors: [`Google search ${response.status}: ${clean(data.error?.message) || "request failed"}`] };
    }
    const snippets = (data.items || []).map((item) => ({
      source: "google" as const,
      title: clean(item.title),
      url: clean(item.link),
      snippet: clean(item.snippet),
    })).filter((item) => item.title && validUrl(item.url));
    return { snippets, errors: [] };
  } catch {
    return { snippets: [], errors: ["Google search timed out or could not be reached."] };
  } finally {
    timeout.clear();
  }
}

async function fetchBingSearchSnippets(env: Env, query: string): Promise<SearchSnippetResult> {
  if (!env.BING_SEARCH_API_KEY || !env.BING_SEARCH_ENDPOINT) return { snippets: [], errors: [] };
  const timeout = timeoutSignal(SEARCH_PROVIDER_TIMEOUT_MS);
  try {
    const url = new URL(env.BING_SEARCH_ENDPOINT);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(SEARCH_RESULTS_PER_PROVIDER));
    url.searchParams.set("mkt", "en-US");
    url.searchParams.set("responseFilter", "Webpages");
    const response = await fetch(url.toString(), {
      signal: timeout.signal,
      headers: { "Ocp-Apim-Subscription-Key": env.BING_SEARCH_API_KEY },
    });
    const data = await response.json() as {
      webPages?: { value?: Array<{ name?: string; url?: string; snippet?: string }> };
      error?: { message?: string };
      message?: string;
    };
    if (!response.ok) {
      return { snippets: [], errors: [`Bing search ${response.status}: ${clean(data.error?.message || data.message) || "request failed"}`] };
    }
    const snippets = (data.webPages?.value || []).map((item) => ({
      source: "bing" as const,
      title: clean(item.name),
      url: clean(item.url),
      snippet: clean(item.snippet),
    })).filter((item) => item.title && validUrl(item.url));
    return { snippets, errors: [] };
  } catch {
    return { snippets: [], errors: ["Bing search timed out or could not be reached."] };
  } finally {
    timeout.clear();
  }
}

function geminiGroundedSourcePrompt(body: Record<string, unknown>, queries: string[]) {
  return `Use Google Search grounding to find current public web leads for Query Quick literary agent discovery.

Project:
- Genre: ${clean(body.genre)}
- Subgenre: ${clean(body.subgenre)}
- Category: ${clean(body.category)}
- Discovery lane: ${clean(body.discovery_lane) || "general"}
- Discovery focus: ${clean(body.discovery_focus) || "current open literary agent source leads"}

Search these ideas:
${queries.map((query) => `- ${query}`).join("\n")}

Return 10-16 source leads when available. Prioritize specific agent profile pages, agency submission guideline pages, QueryManager pages, QueryTracker public pages, Manuscript Wish List pages, Reedsy pages, Publishers Marketplace/public profile pages, and interviews that name live submission interests.
Avoid generic advice posts unless they name specific agents and current submission routes.
Do not include pages that clearly say the agent is closed to queries.

Return JSON only:
{
  "results": [
    {
      "title": "",
      "url": "",
      "snippet": ""
    }
  ]
}`;
}

function parseGeminiGroundedSourceSnippets(data: {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    groundingMetadata?: {
      groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
    };
  }>;
}) {
  const snippets: SearchSnippet[] = [];
  const text = (data.candidates || [])
    .flatMap((candidate) => candidate.content?.parts || [])
    .map((part) => part.text || "")
    .join("\n");
  try {
    const parsed = JSON.parse(extractJsonText(text)) as { results?: Array<{ title?: string; url?: string; snippet?: string }> };
    snippets.push(...(parsed.results || []).map((item) => ({
      source: "gemini-google" as const,
      title: clean(item.title),
      url: clean(item.url),
      snippet: clean(item.snippet),
    })));
  } catch {
    // Grounding metadata below still gives us usable source leads when Gemini wraps or truncates the JSON.
  }
  for (const candidate of data.candidates || []) {
    for (const chunk of candidate.groundingMetadata?.groundingChunks || []) {
      const uri = clean(chunk.web?.uri);
      if (!uri) continue;
      snippets.push({
        source: "gemini-google",
        title: clean(chunk.web?.title) || "Google grounded source",
        url: uri,
        snippet: "Source returned by Gemini Google Search grounding.",
      });
    }
  }
  const seen = new Set<string>();
  return snippets.filter((snippet) => {
    if (!snippet.title || !validUrl(snippet.url)) return false;
    const key = snippet.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchGeminiGroundedSearchSnippets(env: Env, body: Record<string, unknown>, queries: string[]): Promise<SearchSnippetResult> {
  if (!env.GEMINI_API_KEY) return { snippets: [], errors: [] };
  const model = clean(env.GEMINI_MODEL) || "gemini-2.5-flash";
  const timeout = timeoutSignal(SEARCH_PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, {
      method: "POST",
      signal: timeout.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: geminiGroundedSourcePrompt(body, queries) }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 4000 },
      }),
    });
    const data = await response.json() as {
      error?: { message?: string };
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> };
      }>;
    };
    if (!response.ok) {
      return { snippets: [], errors: [`Gemini Google Search ${response.status}: ${clean(data.error?.message) || "request failed"}`] };
    }
    return { snippets: parseGeminiGroundedSourceSnippets(data).slice(0, 20), errors: [] };
  } catch {
    return { snippets: [], errors: ["Gemini Google Search timed out or could not be reached."] };
  } finally {
    timeout.clear();
  }
}

async function searchSnippetsForLane(env: Env, body: Record<string, unknown>) {
  const queries = searchQueriesForLane(body);
  const results = await Promise.all([
    fetchGeminiGroundedSearchSnippets(env, body, queries),
    ...queries.flatMap((query) => [
      fetchGoogleSearchSnippets(env, query),
      fetchBingSearchSnippets(env, query),
    ]),
  ]);
  const seen = new Set<string>();
  const snippets = results.flatMap((result) => result.snippets).filter((result) => {
    const key = result.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 20);
  const errors = Array.from(new Set(results.flatMap((result) => result.errors).filter(Boolean))).slice(0, 4);
  return { snippets, errors };
}

function formatSearchContext(snippets: SearchSnippet[]) {
  return snippets.map((item, index) => (
    `${index + 1}. [${item.source}] ${item.title}\n${item.url}\n${item.snippet}`
  )).join("\n\n");
}

function discoveryLanes(body: Record<string, unknown>): DiscoveryLane[] {
  const genre = clean(body.genre) || "this genre";
  const subgenre = clean(body.subgenre) || "this subgenre";
  const category = clean(body.category) || "this category";
  const expanded = genreExpansionTerms(body).join(", ");
  return [
    { id: "broad", source: "public web search across literary agent profiles and directories", focus: `broad current ${category} ${genre} literary agents accepting ${subgenre}; include adjacent fit terms: ${expanded}` },
    { id: "aala", source: "AALA member directory and AALA agent profile pages", focus: `AALA member agents with public subject-focus matches for ${genre}, ${subgenre}, or adjacent terms; use AALA open/closed status as a signal and still verify exact requirements` },
    { id: "querytracker", source: "QueryTracker-style public search results and public query-status snippets", focus: `QueryTracker agents open to ${genre}, ${subgenre}, and adjacent subscriber-specific fit terms` },
    { id: "querymanager", source: "QueryManager public submission pages and agency links", focus: `QueryManager submission forms for literary agents accepting ${genre}, ${subgenre}, or adjacent terms` },
    { id: "mswl", source: "Manuscript Wish List and public agent wishlist/profile pages", focus: `Manuscript Wish List agents seeking ${genre}, ${subgenre}, and adjacent fit terms` },
    { id: "agency", source: "agency websites, staff pages, and submission guidelines", focus: `agency submission pages naming agents open to ${genre}, ${subgenre}, and adjacent fit terms` },
    { id: "newer-agents", source: "new agent announcements, agency staff pages, interviews, and public profiles", focus: `newer and associate literary agents building lists in ${genre}, ${subgenre}, or adjacent fit terms` },
    { id: "boutique", source: "boutique and independent agency websites", focus: `independent agencies and boutique agencies accepting ${genre}, ${subgenre}, or adjacent fit terms` },
    { id: "source-directories", source: "LiteraryAgencies.com, The Wordling, 1000 Literary Agents, and RegionalDirectory.us lead lists", focus: `secondary directory lead pass for ${genre}, ${subgenre}, and adjacent categories; use these sources for coverage, then confirm every useful lead through AALA, agency, QueryManager, QueryTracker, MSWL, or a direct submission page` },
    { id: "deep-directory", source: "deep public directory/profile search", focus: `deep directory pass for additional open ${genre}, ${subgenre}, and adjacent agents not already found; prioritize AALA and primary agency pages over secondary directories` },
    { id: "google", source: "Google Programmable Search source snippets", focus: `Google search pass for additional ${category} ${genre} literary agents accepting ${subgenre}; prioritize profile, guideline, and directory pages not already found` },
    { id: "bing", source: "Bing Web Search source snippets", focus: `Bing search pass for additional ${category} ${genre} literary agents accepting ${subgenre}; prioritize profile, guideline, and directory pages not already found` },
  ];
}

function queuedDiscoveryLanes(body: Record<string, unknown>, resultCount: number) {
  const priorityIds = [
    "aala",
    "querymanager",
    "mswl",
    "agency",
    "newer-agents",
    "querytracker",
    "boutique",
    "broad",
  ];
  const laneCount = resultCount === 0 ? 6 : resultCount < 10 ? 4 : 2;
  const lanes = discoveryLanes(body);
  return priorityIds
    .map((id) => lanes.find((lane) => lane.id === id))
    .filter((lane): lane is DiscoveryLane => Boolean(lane))
    .slice(0, laneCount);
}

async function generateDiscoveryPass(env: Env, body: Record<string, unknown>) {
  const providers: Array<Promise<{ agents: AgentRecord[]; diagnostics: AgentSearchDiagnostics }>> = [];
  if (env.OPENAI_API_KEY) providers.push(generateAgentCandidates(env, body));
  if (env.GEMINI_API_KEY) providers.push(generateGeminiCandidates(env, body));
  if (env.ANTHROPIC_API_KEY) providers.push(generateClaudeCandidates(env, body));
  if (!providers.length) throw badRequest("Agent discovery is not configured. Add at least one AI provider key.", 503);

  const results = await Promise.allSettled(providers);
  const fulfilled = results
    .filter((result): result is PromiseFulfilledResult<{ agents: AgentRecord[]; diagnostics: AgentSearchDiagnostics }> => result.status === "fulfilled");
  if (!fulfilled.length) {
    const firstError = results.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;
    throw firstError instanceof Response ? firstError : badRequest(firstError instanceof Error ? firstError.message : "All discovery providers failed.", 502);
  }
  return fulfilled;
}

async function generateLiveCandidatePool(env: Env, body: Record<string, unknown>) {
  const requestedFocus = clean(body.discovery_focus);
  const requestedLane: DiscoveryLane | null = requestedFocus
    ? { id: clean(body.discovery_lane) || "requested", source: clean(body.discovery_source) || "requested source lane", focus: requestedFocus }
    : null;
  const lanes = requestedLane ? [requestedLane] : discoveryLanes(body);
  const baseExcludeAgents = Array.isArray(body.exclude_agents)
    ? (body.exclude_agents as unknown[]).map(clean).filter(Boolean)
    : [];
  const passResults = await Promise.allSettled(lanes.map(async (lane) => {
    const laneBody = {
      ...body,
      discovery_lane: lane.id,
      discovery_source: lane.source,
      discovery_focus: lane.focus,
      expanded_genres: genreExpansionTerms(body),
      exclude_agents: baseExcludeAgents.slice(0, 450),
    };
    const snippetsPromise = searchSnippetsForLane(env, laneBody);
    let baseResult: Array<PromiseFulfilledResult<{ agents: AgentRecord[]; diagnostics: AgentSearchDiagnostics }>> = [];
    let baseError: unknown = null;
    try {
      baseResult = await generateDiscoveryPass(env, laneBody);
    } catch (error) {
      baseError = error;
    }
    const { snippets, errors: searchProviderErrors } = await snippetsPromise;
    const withSearchDiagnostics = (
      providerResult: PromiseFulfilledResult<{ agents: AgentRecord[]; diagnostics: AgentSearchDiagnostics }>,
      used: boolean
    ) => {
      const providerSearchCount = providerResult.value.diagnostics.search_result_count || 0;
      return {
        ...providerResult,
        value: {
          ...providerResult.value,
          diagnostics: {
            ...providerResult.value.diagnostics,
            search_result_count: providerSearchCount + snippets.length,
            search_context_used: used || Boolean(providerResult.value.diagnostics.search_context_used),
            search_provider_errors: Array.from(new Set([
              ...(providerResult.value.diagnostics.search_provider_errors || []),
              ...searchProviderErrors,
            ])).slice(0, 4),
          },
        },
      };
    };
    if (!snippets.length) {
      if (baseResult.length) return baseResult.map((providerResult) => withSearchDiagnostics(providerResult, false));
      throw baseError instanceof Response ? baseError : badRequest(baseError instanceof Error ? baseError.message : "Discovery did not return source leads.", 502);
    }
    let searchResult: Array<PromiseFulfilledResult<{ agents: AgentRecord[]; diagnostics: AgentSearchDiagnostics }>> = [];
    try {
      searchResult = await generateDiscoveryPass(env, {
        ...body,
        discovery_lane: lane.id,
        discovery_source: `${lane.source}; Google/Bing source snippets`,
        discovery_focus: lane.focus,
        expanded_genres: genreExpansionTerms(body),
        exclude_agents: [
          ...baseExcludeAgents,
          ...baseResult.flatMap((providerResult) => providerResult.value.agents.map((agent) => `${agent.agent_name} — ${agent.agency}`)),
        ].slice(0, 450),
        search_context: formatSearchContext(snippets),
      });
    } catch {
      if (baseResult.length) return baseResult.map((providerResult) => withSearchDiagnostics(providerResult, false));
      throw baseError instanceof Response ? baseError : badRequest(baseError instanceof Error ? baseError.message : "Discovery did not return source leads.", 502);
    }
    return [
      ...baseResult,
      ...searchResult.map((providerResult) => withSearchDiagnostics(providerResult, true)),
    ];
  }));
  const fulfilled = passResults
    .filter((result): result is PromiseFulfilledResult<Array<PromiseFulfilledResult<{ agents: AgentRecord[]; diagnostics: AgentSearchDiagnostics }>>> => result.status === "fulfilled")
    .flatMap((result) => result.value);
  if (!fulfilled.length) {
    const firstError = passResults.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;
    throw firstError instanceof Response ? firstError : badRequest(firstError instanceof Error ? firstError.message : "Discovery timed out before returning candidates.", 504);
  }
  const agents = dedupeAgents(fulfilled.flatMap((result) => result.value.agents)).slice(0, MAX_AGENT_POOL_RESULTS);

  return {
    agents,
    diagnostics: {
      raw_count: fulfilled.reduce((sum, result) => sum + result.value.diagnostics.raw_count, 0),
      candidate_count: fulfilled.reduce((sum, result) => sum + result.value.diagnostics.candidate_count, 0),
      verified_count: agents.length,
      soft_verified_count: fulfilled.reduce((sum, result) => sum + (result.value.diagnostics.soft_verified_count || 0), 0),
      discovery_passes: fulfilled.length,
      search_result_count: Math.max(...fulfilled.map((result) => result.value.diagnostics.search_result_count || 0), 0),
      search_provider_errors: Array.from(new Set(fulfilled.flatMap((result) => result.value.diagnostics.search_provider_errors || []))).slice(0, 4),
      source_lanes: lanes.map((lane) => lane.id).join(","),
      source: "provider_pool",
    },
  };
}

async function generateAgents(env: Env, body: Record<string, unknown>) {
  if (!env.OPENAI_API_KEY) throw badRequest("Agent search is not configured yet. Missing OPENAI_API_KEY.", 503);
  const sourceCandidates = sourceCandidateList(body);
  if (sourceCandidates.length > ENRICHMENT_BATCH_SIZE) {
    const chunks = chunkArray(sourceCandidates, ENRICHMENT_BATCH_SIZE);
    const fulfilled: Array<{ agents: AgentRecord[]; diagnostics: AgentSearchDiagnostics }> = [];
    for (const chunk of chunks) {
      try {
        fulfilled.push(await generateAgents(env, { ...body, candidates: chunk }));
      } catch {
        // Keep building Agent Intel for the rest of the pool when one route batch is noisy or blocked.
      }
    }
    const agents = dedupeAgents(fulfilled.flatMap((result) => result.agents));
    return {
      agents,
      diagnostics: {
        raw_count: fulfilled.reduce((sum, result) => sum + result.diagnostics.raw_count, 0),
        candidate_count: fulfilled.reduce((sum, result) => sum + result.diagnostics.candidate_count, 0),
        verified_count: agents.length,
        source: "batched_guideline_enrichment",
      },
    };
  }
  const guidelineContext = sourceCandidates.length ? await buildGuidelineContext(sourceCandidates) : "";
  const targetDirective = sourceCandidates.length
    ? `Deep-index the exact submission requirements for every verified stage-one candidate supplied below. This is one internal batch from a larger saved pool; return every complete, usable enriched record in this batch, up to ${sourceCandidates.length}.`
    : "Find the broadest useful pool of currently open literary agents using current public web sources. Do not stop at 25 or 50 when more relevant agents exist. Build toward the full genre/subgenre lane.";
  const candidateDirective = sourceCandidates.length
    ? `\n\nDEEP-INDEX THESE VERIFIED STAGE-ONE CANDIDATES ONLY:
${sourceCandidates.map((agent, index) => `${index + 1}. ${agent.agent_name} — ${agent.agency} — ${submissionRouteUrl(agent)}`).join("\n")}

Readable source context gathered from their route/source pages:
${guidelineContext}

Do not add new agents in this stage. For each candidate, inspect the actual submission route and source snippets first, then use live web search only to fill gaps. Return enriched records with exact requirements, kit mapping, opener, and source notes.`
    : "";
  const prompt = `${targetDirective} Quality and live-open status matter more than volume, but do not under-return when valid candidates exist.

Genre: ${clean(body.genre)}
Subgenre: ${clean(body.subgenre)}
Category: ${clean(body.category)}

Prioritize agents currently open to query on QueryTracker, QueryManager, the agent's own personal website form, or the agency's own submission portal when the source evidence supports the user's exact genre and subgenre.
Return only records complete enough to save the writer time. No guarantees are made; include source-backed public research only.

SUBMISSION ROUTE RULE:
Every returned agent must have one actionable submission route, and it must be the route the agent's own public guidelines indicate:
- querytracker: use the agent's specific live QueryTracker submission page when the agent routes writers there
- querymanager: use the agent's specific live QueryManager page
- form: use the agent's specific live personal website form or agency-hosted web form, not a generic contact page
- portal: use the agent's specific live agency submission portal, not the agency homepage
- email: use the public submission email only when the agent's guidelines say to query by email
Do not return a general website URL as submission_url. Do not return a directory profile as submission_url unless that profile is the actual submission route. Do not treat a QueryTracker or QueryManager page as open just because it loads. If the page says the agent is not currently open, not accepting queries/submissions, temporarily closed, or outside a query window, exclude the agent. The route will be checked server-side; dead, closed, missing, or non-specific routes are discarded.

STRICT NUMBER ONE RULE:
Genre and subgenre accuracy come first. Do not return an agent merely because they accept a broad category. A returned agent must have source-backed evidence that they accept or are meaningfully aligned with BOTH the selected genre and the selected subgenre. If the evidence is broad, vague, stale, or only adjacent without a clear explanation, exclude the agent.

For every returned agent, fill:
- matched_genre: the exact genre/category wording you verified for this agent
- matched_subgenre: the exact subgenre/adjacent wording you verified for this agent
- genre_evidence: one sentence naming the source evidence for the genre match
- subgenre_evidence: one sentence naming the source evidence for the subgenre match
- fit_reason: why this agent belongs in this exact genre/subgenre result set
- wishlist_summary: one readable paragraph summarizing what this agent publicly says they want, including genre, subgenre, themes, age category, and any notable "send me this" signals found in source pages
- email_opener: 2 to 4 warm, specific sentences a writer can use at the top of a query email. It should sound human and professional, not fake-flattering. It should say why this agent was selected, reference their wishlist/preferences, and connect the user's genre/subgenre to the agent's stated interests.

Triangulate as much as possible before returning an agent. For each agent, check multiple public signals when available:
- the agency submission guidelines page
- the agent's agency profile page
- the live QueryManager, personal website form, agency web form, or portal page if used
- recent public wishlist/interview/MSWL-style pages when relevant
- public YouTube videos, podcasts, webinars, interviews, agency blog posts, or conference/query advice only when they are easy to verify quickly

Do not require every source for every agent. Do require a useful triangulation pattern:
- at least one current primary submission source, preferably agency profile/guidelines or live portal
- at least one genre/subgenre intent or directory signal
- one additional corroborating source when available
- if a paid or gated database is inaccessible, do not invent details; use public snippets only if clear and name that limitation in verification_notes

The requirements_summary must be practical and detailed enough for a writer to act on. Include the required query materials, page/chapter/sample requirements, synopsis requirements, email/form/portal method, and any notable formatting instructions found in the sources.

Required_materials is the kit map. Choose every Query Quick kit piece the agent asks for. Always include query_letter. If the agent asks for a concise description, description of the work, or brief description, include concise_description. If they ask for sample pages, first pages, first chapters, chapters, or sample chapters, include first_pages or sample_chapters as appropriate. If they ask for a synopsis, include synopsis. If they ask for a nonfiction proposal, include proposal. If they ask for relevant biographical information, bio, or author bio, include bio_paragraph. If they ask for previous publishing history, publishing credentials, or publication credits, include publishing_history. If they ask for a pitch/logline/comps/trigger warnings/why-this-book/about-you/prizes, include the matching kit keys.

Use source_url as the best primary source. Use source_urls for all public sources used to verify the row. Prefer 2 or more sources when available, but do not invent sources.
When available, include public media or interview sources in source_urls so the writer can open them from Agent Intel. Use verification_notes to briefly say what was cross-checked.

For required_materials, infer from the public submission requirements and choose only from:
query_letter, concise_description, synopsis, first_pages, sample_chapters, proposal, logline, short_pitch, bio_paragraph, publishing_history, comps, trigger_warnings, inspiration, more_about_you, prizes.${candidateDirective}`;

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["agents"],
    properties: {
      agents: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "agent_name",
            "agency",
            "genre_fit",
            "matched_genre",
            "matched_subgenre",
            "genre_evidence",
            "subgenre_evidence",
            "fit_reason",
            "wishlist_summary",
            "email_opener",
            "query_method",
            "submission_url",
            "public_email",
            "requirements_summary",
            "required_materials",
            "open_status",
            "source_url",
            "source_urls",
            "verification_notes",
            "last_verified",
            "confidence_score",
          ],
          properties: {
            agent_name: { type: "string" },
            agency: { type: "string" },
            genre_fit: { type: "string" },
            matched_genre: { type: "string" },
            matched_subgenre: { type: "string" },
            genre_evidence: { type: "string" },
            subgenre_evidence: { type: "string" },
            fit_reason: { type: "string" },
            wishlist_summary: { type: "string" },
            email_opener: { type: "string" },
            query_method: { type: "string", enum: ["email", "querytracker", "querymanager", "form", "portal"] },
            submission_url: { type: "string" },
            public_email: { type: "string" },
            requirements_summary: { type: "string" },
            required_materials: {
              type: "array",
              items: {
                type: "string",
                enum: [
                  "query_letter",
                  "concise_description",
                  "synopsis",
                  "first_pages",
                  "sample_chapters",
                  "proposal",
                  "logline",
                  "short_pitch",
                  "bio_paragraph",
                  "publishing_history",
                  "comps",
                  "trigger_warnings",
                  "inspiration",
                  "more_about_you",
                  "prizes",
                ],
              },
            },
            open_status: { type: "string", enum: ["open", "selective", "closed"] },
            source_url: { type: "string" },
            source_urls: {
              type: "array",
              items: { type: "string" },
            },
            verification_notes: { type: "string" },
            last_verified: { type: "string" },
            confidence_score: { type: "integer" },
          },
        },
      },
    },
  };

  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: clean(env.OPENAI_MODEL) || "gpt-5-mini",
        tools: [{ type: "web_search_preview" }],
        input: [
          {
            role: "system",
            content:
              "You generate Query Quick literary agent research records. Genre and subgenre accuracy is the first rule. Use current public sources and triangulate genre/subgenre fit plus submission details across multiple public pages whenever possible. Return JSON only. If required genre/subgenre evidence is missing, exclude the record. Do not guess.",
          },
          { role: "user", content: prompt },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "query_quick_agents",
            strict: true,
            schema,
          },
        },
      }),
    });
  } catch (error) {
    throw error;
  }
  const data = await response.json() as { error?: { message?: string } };
  if (!response.ok) throw badRequest(data.error?.message || "Agent research failed.", response.status);
  const parsed = JSON.parse(extractResponseText(data)) as { agents?: AgentRecord[] };
  const rawAgents = parsed.agents || [];
  const normalized = rawAgents.map(normalizeAgent);
  const candidates = filterAgents(normalized).map(normalizeAgent);
  if (!candidates.length) {
    return {
      agents: [],
      diagnostics: { raw_count: rawAgents.length, candidate_count: 0, verified_count: 0 },
    };
  }
  const verified = filterAgents(await verifySubmissionRoutes(candidates)).map(normalizeAgent);
  if (!verified.length) {
    const softVerified = filterAgents(await softVerifySubmissionRoutes(candidates)).map(normalizeAgent);
    return {
      agents: softVerified,
      diagnostics: {
        raw_count: rawAgents.length,
        candidate_count: candidates.length,
        verified_count: softVerified.length,
        soft_verified_count: softVerified.length,
      },
    };
  }
  return {
    agents: verified,
    diagnostics: {
      raw_count: rawAgents.length,
      candidate_count: candidates.length,
      verified_count: verified.length,
    },
  };
}

function discoveryTimeout(body: Record<string, unknown>, timeoutMs: number) {
  return {
    agents: [],
    diagnostics: {
      raw_count: 0,
      candidate_count: 0,
      verified_count: 0,
      discovery_passes: 0,
      source_lanes: clean(body.discovery_lane),
      source: "live_discovery_timeout",
      error: `Live discovery did not finish within ${Math.round(timeoutMs / 1000)} seconds. Showing saved agents first; search again to keep expanding.`,
    } satisfies AgentSearchDiagnostics,
  };
}

async function generateLiveCandidatePoolForResponse(env: Env, body: Record<string, unknown>, timeoutMs: number) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ agents: AgentRecord[]; diagnostics: AgentSearchDiagnostics }>((resolve) => {
    timeoutId = setTimeout(() => resolve(discoveryTimeout(body, timeoutMs)), timeoutMs);
  });

  try {
    return await Promise.race([generateLiveCandidatePool(env, body), timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function submissionRequirementsForAgent(agent: AgentRecord) {
  const schema = agent.submission_schema || submissionSchemaForAgent(agent);
  return {
    query_method: agent.query_method,
    submission_url: agent.submission_url || "",
    public_email: agent.public_email || "",
    route_url: submissionRouteUrl(agent),
    route_verified: Boolean(agent.submission_route_verified),
    route_status: Number(agent.submission_route_status || 0),
    required_materials: agent.required_materials || ["query_letter"],
    submission_schema: schema,
    open_status: agent.open_status,
    last_verified: agent.last_verified,
    verification_notes: clean(agent.verification_notes),
  };
}

async function saveAgentSubmissionSchema(env: Env, agentId: string, agent: AgentRecord, now: string) {
  const schema = agent.submission_schema || submissionSchemaForAgent(agent);
  try {
    await run(
      env.DB,
      `INSERT INTO quick_agent_submission_schema (
         agent_id, submission_method, submission_url, requires_query_letter, requires_synopsis,
         synopsis_type, requires_bio, sample_pages, attachment_rules_json, form_fields_json,
         querymanager_enabled, email_submission_enabled, last_verified, confidence, schema_json, updated_at
       )
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
       ON CONFLICT(agent_id) DO UPDATE SET
         submission_method = excluded.submission_method,
         submission_url = excluded.submission_url,
         requires_query_letter = excluded.requires_query_letter,
         requires_synopsis = excluded.requires_synopsis,
         synopsis_type = excluded.synopsis_type,
         requires_bio = excluded.requires_bio,
         sample_pages = excluded.sample_pages,
         attachment_rules_json = excluded.attachment_rules_json,
         form_fields_json = excluded.form_fields_json,
         querymanager_enabled = excluded.querymanager_enabled,
         email_submission_enabled = excluded.email_submission_enabled,
         last_verified = excluded.last_verified,
         confidence = excluded.confidence,
         schema_json = excluded.schema_json,
         updated_at = excluded.updated_at`,
      [
        agentId,
        schema.method,
        schema.submission_url,
        schema.requires_query_letter ? 1 : 0,
        schema.requires_synopsis ? 1 : 0,
        schema.synopsis_type,
        schema.requires_bio ? 1 : 0,
        schema.sample_pages,
        JSON.stringify(schema.attachments_required),
        JSON.stringify(schema.form_fields || {}),
        schema.querymanager_enabled ? 1 : 0,
        schema.email_submission_enabled ? 1 : 0,
        schema.last_verified || agent.last_verified || now,
        Number(schema.confidence || agent.confidence_score || 0),
        JSON.stringify(schema),
        now,
      ]
    );
  } catch {
    // Older local databases may not have the schema table until migrations run.
  }
}

async function saveAgentMasterFacets(env: Env, agentId: string, body: Record<string, unknown>, agent: AgentRecord, now: string) {
  const category = clean(body.category);
  const genre = clean(agent.matched_genre) || clean(body.genre) || clean(agent.genre_fit);
  const subgenre = clean(agent.matched_subgenre) || clean(body.subgenre);
  const normalizedGenre = normalizeSearchText(genre);
  const normalizedSubgenre = normalizeSearchText(subgenre);

  if (normalizedGenre) {
    await run(
      env.DB,
      `INSERT INTO quick_agent_genres (
         agent_id, category, genre, subgenre, normalized_genre, normalized_subgenre,
         genre_evidence, subgenre_evidence, fit_reason, source_url, confidence_score,
         active, first_seen_at, last_seen_at
       )
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1, ?12, ?13)
       ON CONFLICT(agent_id, normalized_genre, normalized_subgenre, category) DO UPDATE SET
         genre = excluded.genre,
         subgenre = excluded.subgenre,
         genre_evidence = excluded.genre_evidence,
         subgenre_evidence = excluded.subgenre_evidence,
         fit_reason = excluded.fit_reason,
         source_url = excluded.source_url,
         confidence_score = excluded.confidence_score,
         active = 1,
         last_seen_at = excluded.last_seen_at`,
      [
        agentId,
        category,
        genre,
        subgenre,
        normalizedGenre,
        normalizedSubgenre,
        agent.genre_evidence || "",
        agent.subgenre_evidence || "",
        agent.fit_reason || "",
        agent.source_url,
        Number(agent.confidence_score || 0),
        now,
        now,
      ]
    );
  }

  await run(
    env.DB,
    `INSERT INTO quick_agent_requirements (
       agent_id, query_method, submission_url, public_email, requirements_summary,
       required_materials_json, wishlist_summary, submission_requirements_json,
       email_opener, source_url, source_urls_json, verification_notes, updated_at
     )
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
     ON CONFLICT(agent_id) DO UPDATE SET
       query_method = excluded.query_method,
       submission_url = excluded.submission_url,
       public_email = excluded.public_email,
       requirements_summary = excluded.requirements_summary,
       required_materials_json = excluded.required_materials_json,
       wishlist_summary = excluded.wishlist_summary,
       submission_requirements_json = excluded.submission_requirements_json,
       email_opener = excluded.email_opener,
       source_url = excluded.source_url,
       source_urls_json = excluded.source_urls_json,
       verification_notes = excluded.verification_notes,
       updated_at = excluded.updated_at`,
    [
      agentId,
      agent.query_method,
      agent.submission_url || "",
      agent.public_email || "",
      agent.requirements_summary,
      JSON.stringify(agent.required_materials || ["query_letter"]),
      wishlistSummaryForAgent(agent),
      JSON.stringify(submissionRequirementsForAgent(agent)),
      agent.email_opener || "",
      agent.source_url,
      JSON.stringify(agent.source_urls || [agent.source_url]),
      agent.verification_notes || "",
      now,
    ]
  );

  const sourceUrls = Array.from(new Set([
    agent.source_url,
    submissionRouteUrl(agent),
    ...(agent.source_urls || []),
  ].map(clean).filter(validUrl)));
  for (const sourceUrl of sourceUrls) {
    const sourceKind = sourceUrl === submissionRouteUrl(agent) ? "submission_route" : "profile";
    await run(
      env.DB,
      `INSERT INTO quick_agent_sources (
         id, agent_id, source_url, source_kind, title, notes, last_status,
         last_checked_at, first_seen_at, last_seen_at
       )
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT(agent_id, source_url) DO UPDATE SET
         source_kind = excluded.source_kind,
         notes = excluded.notes,
         last_status = excluded.last_status,
         last_checked_at = excluded.last_checked_at,
         last_seen_at = excluded.last_seen_at`,
      [
        crypto.randomUUID(),
        agentId,
        sourceUrl,
        sourceKind,
        sourceKind === "submission_route" ? routeName(agent) : "",
        sourceKind === "submission_route" ? agent.submission_route_notes || "" : agent.verification_notes || "",
        sourceKind === "submission_route" ? Number(agent.submission_route_status || 0) : 0,
        sourceKind === "submission_route" ? agent.submission_route_verified_at || now : "",
        now,
        now,
      ]
    );
  }
}

async function recordAgentStatusCheck(
  env: Env,
  agentId: string,
  checkedUrl: string,
  openStatus: AgentRecord["open_status"],
  routeVerified: boolean,
  statusCode: number,
  notes: string,
  checkedAt: string
) {
  await run(
    env.DB,
    `INSERT INTO quick_agent_status_checks (
       id, agent_id, checked_url, open_status, route_verified, status_code, notes, checked_at
     )
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    [
      crypto.randomUUID(),
      agentId,
      checkedUrl,
      openStatus,
      routeVerified ? 1 : 0,
      Number(statusCode || 0),
      notes,
      checkedAt,
    ]
  );
}

function sourceTypeFromUrl(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (host.includes("querymanager")) return "querymanager";
    if (host.includes("querytracker")) return "querytracker";
    if (host.includes("manuscriptwishlist")) return "mswl";
    if (host.includes("aalitagents")) return "aala";
    if (host.includes("literaryagencies")) return "literaryagencies";
    if (host.includes("thewordling")) return "wordling";
    if (host.includes("1000literaryagents")) return "1000literaryagents";
    if (host.includes("regionaldirectory")) return "regionaldirectory";
    if (host.includes("agency") || host.includes("literary") || host.includes("lit")) return "agency";
    return "public-web";
  } catch {
    return "public-web";
  }
}

function pathKeyFromUrl(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean).slice(0, 3);
    return [host, ...parts].join("/");
  } catch {
    return normalizeSearchText(value).slice(0, 140) || "unknown-path";
  }
}

async function promoteValidatedAgentPaths(env: Env, agentId: string, body: Record<string, unknown>, agent: AgentRecord, now: string) {
  const genre = clean(agent.matched_genre) || clean(body.genre) || clean(agent.genre_fit);
  const subgenre = clean(agent.matched_subgenre) || clean(body.subgenre);
  const normalizedGenre = normalizeSearchText(genre);
  const normalizedSubgenre = normalizeSearchText(subgenre);
  const sourceUrls = Array.from(new Set([
    agent.source_url,
    submissionRouteUrl(agent),
    ...(agent.source_urls || []),
  ].map(clean).filter(validUrl)));

  for (const sourceUrl of sourceUrls) {
    const sourceType = sourceTypeFromUrl(sourceUrl);
    const pathKey = pathKeyFromUrl(sourceUrl);
    const confidence = clampScore(Number(agent.confidence_score || 0) + (agent.submission_route_verified ? 10 : 0));
    const priority = clampScore(confidence + (agent.open_status === "open" ? 10 : 0));
    try {
      await run(
        env.DB,
        `INSERT INTO quick_validated_agent_paths (
           id, source_type, path_key, source_url, genre_lane, normalized_genre,
           normalized_subgenre, status, priority, useful_agent_count, open_agent_yield,
           false_positive_count, last_agent_id, last_useful_at, next_check_at,
           confidence_score, notes, created_at, updated_at
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'watching', ?8, 1, ?9, 0, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT(path_key, normalized_genre, normalized_subgenre) DO UPDATE SET
           source_url = excluded.source_url,
           status = 'watching',
           priority = max(priority, excluded.priority),
           useful_agent_count = useful_agent_count + 1,
           open_agent_yield = open_agent_yield + excluded.open_agent_yield,
           last_agent_id = excluded.last_agent_id,
           last_useful_at = excluded.last_useful_at,
           next_check_at = excluded.next_check_at,
           confidence_score = max(confidence_score, excluded.confidence_score),
           notes = excluded.notes,
           updated_at = excluded.updated_at`,
        [
          crypto.randomUUID(),
          sourceType,
          pathKey,
          sourceUrl,
          [genre, subgenre].filter(Boolean).join(" / "),
          normalizedGenre,
          normalizedSubgenre,
          priority,
          agent.open_status === "open" ? 1 : 0,
          agentId,
          now,
          new Date(Date.now() + 1000 * 60 * 60 * (sourceType === "querymanager" || sourceType === "aala" ? 12 : 24)).toISOString(),
          confidence,
          `${sourceType} path produced ${agent.agent_name} for ${genre || "this genre"}.`,
          now,
          now,
        ]
      );
    } catch {
      // Older local databases may not have the operational path table until migrations run.
    }
  }
}

async function refreshAgentScore(env: Env, agentId: string) {
  try {
    const row = await one<{
      id: string;
      open_status: string;
      confidence_score: number;
      last_verified: string;
      submission_route_verified: number;
      requirements_summary: string;
      required_materials_json: string;
      wishlist_summary: string;
      genre_confidence: number;
    }>(
      env.DB,
      `SELECT qa.id,
              qa.open_status,
              qa.confidence_score,
              qa.last_verified,
              qa.submission_route_verified,
              COALESCE(qr.requirements_summary, qa.requirements_summary) AS requirements_summary,
              COALESCE(qr.required_materials_json, qa.required_materials_json) AS required_materials_json,
              COALESCE(qr.wishlist_summary, '') AS wishlist_summary,
              COALESCE(max(qag.confidence_score), qa.confidence_score) AS genre_confidence
       FROM quick_agents qa
       LEFT JOIN quick_agent_requirements qr ON qr.agent_id = qa.id
       LEFT JOIN quick_agent_genres qag ON qag.agent_id = qa.id AND qag.active = 1
       WHERE qa.id = ?1
       GROUP BY qa.id`,
      [agentId]
    );
    if (!row) return;
    const verifiedTime = Date.parse(row.last_verified || "");
    const ageDays = Number.isFinite(verifiedTime) ? Math.max(0, (Date.now() - verifiedTime) / (1000 * 60 * 60 * 24)) : 30;
    const materials = safeJsonArray(row.required_materials_json, []);
    const summary = clean(row.requirements_summary);
    const wishlist = clean(row.wishlist_summary);
    const openScore = row.open_status === "open" ? 100 : row.open_status === "selective" ? 45 : 0;
    const genreFitScore = clampScore(Number(row.genre_confidence || row.confidence_score || 0));
    const wishlistFitScore = clampScore((wishlist ? 70 : 35) + Math.min(25, wishlist.length / 80));
    const freshnessScore = clampScore(100 - ageDays * 6);
    const confidenceScore = clampScore(Number(row.confidence_score || 0));
    const submissionReadyScore = clampScore(
      (row.submission_route_verified ? 45 : 0) +
      (summary && !summary.toLowerCase().includes("building agent intel") ? 35 : 0) +
      (materials.length ? 20 : 0)
    );
    const finalRankScore = clampScore(
      openScore * 0.26 +
      genreFitScore * 0.22 +
      wishlistFitScore * 0.18 +
      freshnessScore * 0.14 +
      confidenceScore * 0.1 +
      submissionReadyScore * 0.1
    );
    await run(
      env.DB,
      `INSERT INTO quick_agent_scores (
         agent_id, open_score, genre_fit_score, wishlist_fit_score, freshness_score,
         confidence_score, submission_ready_score, final_rank_score, score_reason, updated_at
       )
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT(agent_id) DO UPDATE SET
         open_score = excluded.open_score,
         genre_fit_score = excluded.genre_fit_score,
         wishlist_fit_score = excluded.wishlist_fit_score,
         freshness_score = excluded.freshness_score,
         confidence_score = excluded.confidence_score,
         submission_ready_score = excluded.submission_ready_score,
         final_rank_score = excluded.final_rank_score,
         score_reason = excluded.score_reason,
         updated_at = excluded.updated_at`,
      [
        agentId,
        openScore,
        genreFitScore,
        wishlistFitScore,
        freshnessScore,
        confidenceScore,
        submissionReadyScore,
        finalRankScore,
        `open ${openScore}; genre ${genreFitScore}; wishlist ${wishlistFitScore}; freshness ${freshnessScore}; ready ${submissionReadyScore}`,
        nowIso(),
      ]
    );
  } catch {
    // Ranking is supportive. A failed score refresh should not block ingestion or search.
  }
}

async function saveAgentToMaster(env: Env, body: Record<string, unknown>, agent: AgentRecord, now: string) {
  const normalizedKey = normalizedAgentKey(agent);
  const agentId = `agent_${normalizedKey}`;
  await run(
    env.DB,
    `INSERT INTO quick_agents (
       id, normalized_key, agent_name, agency, genre_fit, query_method, submission_url, public_email,
       requirements_summary, email_opener, open_status, source_url, last_verified, confidence_score, first_seen_at, last_seen_at,
       matched_genre, matched_subgenre, genre_evidence, subgenre_evidence, fit_reason, required_materials_json,
       source_urls_json, verification_notes, submission_route_verified, submission_route_verified_at,
       submission_route_status, submission_route_notes, refresh_status, refresh_error, next_refresh_at
     )
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
       ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31)
     ON CONFLICT(normalized_key) DO UPDATE SET
       agent_name = excluded.agent_name,
       agency = excluded.agency,
       genre_fit = excluded.genre_fit,
       query_method = excluded.query_method,
       submission_url = excluded.submission_url,
       public_email = excluded.public_email,
       requirements_summary = excluded.requirements_summary,
       email_opener = excluded.email_opener,
       open_status = excluded.open_status,
       source_url = excluded.source_url,
       last_verified = excluded.last_verified,
       confidence_score = excluded.confidence_score,
       last_seen_at = excluded.last_seen_at,
       matched_genre = excluded.matched_genre,
       matched_subgenre = excluded.matched_subgenre,
       genre_evidence = excluded.genre_evidence,
       subgenre_evidence = excluded.subgenre_evidence,
       fit_reason = excluded.fit_reason,
       required_materials_json = excluded.required_materials_json,
       source_urls_json = excluded.source_urls_json,
       verification_notes = excluded.verification_notes,
       submission_route_verified = excluded.submission_route_verified,
       submission_route_verified_at = excluded.submission_route_verified_at,
       submission_route_status = excluded.submission_route_status,
       submission_route_notes = excluded.submission_route_notes,
       refresh_status = excluded.refresh_status,
       refresh_error = excluded.refresh_error,
       next_refresh_at = excluded.next_refresh_at`,
    [
      agentId,
      normalizedKey,
      agent.agent_name,
      agent.agency,
      agent.genre_fit,
      agent.query_method,
      agent.submission_url || "",
      agent.public_email || "",
      agent.requirements_summary,
      agent.email_opener || "",
      agent.open_status,
      agent.source_url,
      agent.last_verified,
      Number(agent.confidence_score || 0),
      now,
      now,
      agent.matched_genre || agent.genre_fit,
      agent.matched_subgenre || clean(body.subgenre),
      agent.genre_evidence || "",
      agent.subgenre_evidence || "",
      agent.fit_reason || "",
      JSON.stringify(agent.required_materials || ["query_letter"]),
      JSON.stringify(agent.source_urls || [agent.source_url]),
      agent.verification_notes || "",
      agent.submission_route_verified ? 1 : 0,
      agent.submission_route_verified_at || "",
      Number(agent.submission_route_status || 0),
      agent.submission_route_notes || "",
      agentNeedsIntel(agent) ? "candidate" : "fresh",
      "",
      new Date(Date.now() + 1000 * 60 * (agentNeedsIntel(agent) ? 30 : 60 * 6)).toISOString(),
    ]
  );

  await saveAgentMasterFacets(env, agentId, body, agent, now);
  await saveAgentSubmissionSchema(env, agentId, agent, now);
  if (agent.submission_route_verified_at || agent.submission_route_status) {
    await recordAgentStatusCheck(
      env,
      agentId,
      submissionRouteUrl(agent),
      agent.open_status,
      Boolean(agent.submission_route_verified),
      Number(agent.submission_route_status || 0),
      agent.submission_route_notes || agent.verification_notes || "",
      agent.submission_route_verified_at || now
    );
  }
  await promoteValidatedAgentPaths(env, agentId, body, agent, now);
  await refreshAgentScore(env, agentId);
  return { agentId, normalizedKey };
}

async function saveAgentResearch(
  env: Env,
  userId: string,
  key: string,
  body: Record<string, unknown>,
  agents: AgentRecord[]
) {
  const now = new Date().toISOString();
  const searchId = crypto.randomUUID();
  await run(
    env.DB,
    `INSERT INTO quick_agent_searches (id, user_id, cache_key, genre, subgenre, category, result_count, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    [searchId, userId, key, clean(body.genre), clean(body.subgenre), clean(body.category), agents.length, now]
  );

  for (let index = 0; index < agents.length; index += 1) {
    const agent = agents[index];
    const { normalizedKey } = await saveAgentToMaster(env, body, agent, now);
    await run(
      env.DB,
      `INSERT OR IGNORE INTO quick_agent_search_results (search_id, agent_id, rank, created_at)
       VALUES (?1, (SELECT id FROM quick_agents WHERE normalized_key = ?2), ?3, ?4)`,
      [searchId, normalizedKey, index + 1, now]
    );
  }
}

function rowToIntelAgent(row: {
  agent_name: string;
  agency: string;
  genre_fit: string;
  matched_genre: string;
  matched_subgenre: string;
  genre_evidence: string;
  subgenre_evidence: string;
  fit_reason: string;
  query_method: AgentRecord["query_method"];
  submission_url: string;
  public_email: string;
  requirements_summary: string;
  email_opener: string;
  open_status: AgentRecord["open_status"];
  source_url: string;
  source_urls_json: string;
  verification_notes: string;
  required_materials_json: string;
  wishlist_summary?: string;
  submission_requirements_json?: string;
  schema_json?: string;
  schema_method?: AgentRecord["query_method"];
  schema_submission_url?: string;
  schema_requires_query_letter?: number;
  schema_requires_synopsis?: number;
  schema_synopsis_type?: AgentSubmissionSchema["synopsis_type"];
  schema_requires_bio?: number;
  schema_sample_pages?: number;
  schema_attachment_rules_json?: string;
  schema_form_fields_json?: string;
  schema_querymanager_enabled?: number;
  schema_email_submission_enabled?: number;
  schema_last_verified?: string;
  schema_confidence?: number;
  submission_route_verified: number;
  submission_route_verified_at: string;
  submission_route_status: number;
  submission_route_notes: string;
  last_verified: string;
  confidence_score: number;
}): AgentRecord {
  const baseAgent = normalizeAgent({
    agent_name: row.agent_name,
    agency: row.agency,
    genre_fit: row.genre_fit,
    matched_genre: row.matched_genre || row.genre_fit,
    matched_subgenre: row.matched_subgenre || row.genre_fit,
    genre_evidence: row.genre_evidence || "Matched from Query Quick's stored agent database.",
    subgenre_evidence: row.subgenre_evidence || "Matched from Query Quick's stored agent database.",
    fit_reason: row.fit_reason || "Stored match for this profile.",
    email_opener: row.email_opener || "",
    query_method: row.query_method,
    submission_url: row.submission_url,
    public_email: row.public_email,
    requirements_summary: row.requirements_summary,
    required_materials: safeJsonArray(row.required_materials_json, ["query_letter"]) as AgentRecord["required_materials"],
    wishlist_summary: row.wishlist_summary || "",
    submission_requirements: (() => {
      try {
        return JSON.parse(row.submission_requirements_json || "{}") as Record<string, unknown>;
      } catch {
        return {};
      }
    })(),
    open_status: row.open_status,
    source_url: row.source_url,
    source_urls: safeJsonArray(row.source_urls_json, [row.source_url]),
    verification_notes: row.verification_notes,
    submission_route_verified: Boolean(row.submission_route_verified),
    submission_route_verified_at: row.submission_route_verified_at,
    submission_route_status: row.submission_route_status,
    submission_route_notes: row.submission_route_notes,
    last_verified: row.last_verified,
    confidence_score: row.confidence_score,
  });
  if (row.schema_json) {
    try {
      const parsed = JSON.parse(row.schema_json) as AgentSubmissionSchema;
      return { ...baseAgent, submission_schema: parsed };
    } catch {
      // Fall back to the typed columns below.
    }
  }
  if (row.schema_method) {
    const attachments = safeJsonArray(row.schema_attachment_rules_json || "[]", baseAgent.required_materials || ["query_letter"]);
    return {
      ...baseAgent,
      submission_schema: {
        method: row.schema_method,
        requires_query_letter: row.schema_requires_query_letter !== 0,
        requires_synopsis: Boolean(row.schema_requires_synopsis),
        synopsis_type: row.schema_synopsis_type || "",
        requires_bio: Boolean(row.schema_requires_bio),
        sample_pages: Number(row.schema_sample_pages || 0),
        attachments_required: attachments,
        form_fields: (() => {
          try {
            return JSON.parse(row.schema_form_fields_json || "{}") as Record<string, unknown>;
          } catch {
            return {};
          }
        })(),
        querymanager_enabled: Boolean(row.schema_querymanager_enabled),
        email_submission_enabled: Boolean(row.schema_email_submission_enabled),
        submission_url: row.schema_submission_url || submissionRouteUrl(baseAgent),
        last_verified: row.schema_last_verified || baseAgent.last_verified,
        confidence: Number(row.schema_confidence || baseAgent.confidence_score || 0),
      },
    };
  }
  return baseAgent;
}

async function storedOpenAgentPool(env: Env, body: Record<string, unknown>) {
  const genre = clean(body.genre);
  if (!genre) return [];
  const masterRows = await storedOpenAgentPoolFromMaster(env, body);
  if (masterRows.length) return masterRows;
  return storedOpenAgentPoolFromLegacyFields(env, body);
}

async function storedOpenAgentPoolFromMaster(env: Env, body: Record<string, unknown>) {
  const terms = storedPoolTerms(body).map(normalizeSearchText).filter(Boolean);
  if (!terms.length) return [];
  const fields = [
    "qag.normalized_genre",
    "qag.normalized_subgenre",
    "lower(qag.genre_evidence)",
    "lower(qag.subgenre_evidence)",
    "lower(qag.fit_reason)",
    "lower(qa.genre_fit)",
  ];
  const maxTerms = Math.floor(90 / fields.length);
  const params: string[] = [];
  const termClauses = terms.slice(0, maxTerms).map((term) => {
    const fieldClauses = fields.map((field) => {
      params.push(`%${term}%`);
      return `${field} LIKE ?${params.length}`;
    });
    return `(${fieldClauses.join(" OR ")})`;
  });
  params.push(String(TARGET_AGENT_POOL_SIZE));
  try {
    const rows = await all<Parameters<typeof rowToIntelAgent>[0]>(
      env.DB,
      `SELECT qa.agent_name,
              qa.agency,
              qa.genre_fit,
              COALESCE(NULLIF(qag.genre, ''), qa.matched_genre) AS matched_genre,
              COALESCE(NULLIF(qag.subgenre, ''), qa.matched_subgenre) AS matched_subgenre,
              COALESCE(NULLIF(qag.genre_evidence, ''), qa.genre_evidence) AS genre_evidence,
              COALESCE(NULLIF(qag.subgenre_evidence, ''), qa.subgenre_evidence) AS subgenre_evidence,
              COALESCE(NULLIF(qag.fit_reason, ''), qa.fit_reason) AS fit_reason,
              COALESCE(qr.query_method, qa.query_method) AS query_method,
              COALESCE(qr.submission_url, qa.submission_url) AS submission_url,
              COALESCE(qr.public_email, qa.public_email) AS public_email,
              COALESCE(qr.requirements_summary, qa.requirements_summary) AS requirements_summary,
              COALESCE(qr.email_opener, qa.email_opener) AS email_opener,
              qa.open_status,
              COALESCE(qr.source_url, qa.source_url) AS source_url,
              COALESCE(qr.source_urls_json, qa.source_urls_json) AS source_urls_json,
              COALESCE(qr.verification_notes, qa.verification_notes) AS verification_notes,
              COALESCE(qr.required_materials_json, qa.required_materials_json) AS required_materials_json,
              COALESCE(qr.wishlist_summary, '') AS wishlist_summary,
              COALESCE(qr.submission_requirements_json, '{}') AS submission_requirements_json,
              qss.schema_json AS schema_json,
              qss.submission_method AS schema_method,
              qss.submission_url AS schema_submission_url,
              qss.requires_query_letter AS schema_requires_query_letter,
              qss.requires_synopsis AS schema_requires_synopsis,
              qss.synopsis_type AS schema_synopsis_type,
              qss.requires_bio AS schema_requires_bio,
              qss.sample_pages AS schema_sample_pages,
              qss.attachment_rules_json AS schema_attachment_rules_json,
              qss.form_fields_json AS schema_form_fields_json,
              qss.querymanager_enabled AS schema_querymanager_enabled,
              qss.email_submission_enabled AS schema_email_submission_enabled,
              qss.last_verified AS schema_last_verified,
              qss.confidence AS schema_confidence,
              qa.submission_route_verified,
              qa.submission_route_verified_at,
              qa.submission_route_status,
              qa.submission_route_notes,
              qa.last_verified,
              qa.confidence_score
       FROM quick_agent_genres qag
       JOIN quick_agents qa ON qa.id = qag.agent_id
       LEFT JOIN quick_agent_requirements qr ON qr.agent_id = qa.id
       LEFT JOIN quick_agent_submission_schema qss ON qss.agent_id = qa.id
       WHERE qa.open_status IN ('open', 'selective')
         AND qag.active = 1
         AND (${termClauses.join(" OR ")})
       ORDER BY qa.submission_route_verified DESC, qa.confidence_score DESC, qag.last_seen_at DESC
       LIMIT ?${params.length}`,
      params
    );
    return rows.map(rowToIntelAgent);
  } catch {
    return [];
  }
}

async function storedOpenAgentPoolFromLegacyFields(env: Env, body: Record<string, unknown>) {
  const fields = [
    "genre_fit",
    "matched_genre",
    "matched_subgenre",
    "genre_evidence",
    "subgenre_evidence",
    "fit_reason",
  ];
  const maxTerms = Math.floor(99 / fields.length);
  const terms = storedPoolTerms(body).slice(0, maxTerms);
  if (!terms.length) return [];
  const params: string[] = [];
  const termClauses = terms.map((term) => {
    const fieldClauses = fields.map((field) => {
      params.push(`%${term}%`);
      return `lower(${field}) LIKE ?${params.length}`;
    });
    return `(${fieldClauses.join(" OR ")})`;
  });
  params.push(String(TARGET_AGENT_POOL_SIZE));
  const rows = await all<Parameters<typeof rowToIntelAgent>[0]>(
    env.DB,
    `SELECT agent_name, agency, genre_fit, matched_genre, matched_subgenre, genre_evidence, subgenre_evidence,
            fit_reason, query_method, submission_url, public_email, requirements_summary, email_opener,
            open_status, source_url, source_urls_json, verification_notes, required_materials_json,
            submission_route_verified, submission_route_verified_at, submission_route_status,
            submission_route_notes, last_verified, confidence_score
     FROM quick_agents
     WHERE open_status IN ('open', 'selective')
       AND (${termClauses.join(" OR ")})
     ORDER BY submission_route_verified DESC, confidence_score DESC, last_seen_at DESC
     LIMIT ?${params.length}`,
    params
  );
  return rows.map(rowToIntelAgent);
}

function instantSearchTerms(body: Record<string, unknown>) {
  const terms = [
    ...storedPoolTerms(body),
    clean(body.tone),
    clean(body.audience),
  ];
  return Array.from(new Set(terms.map(normalizeSearchText).filter(Boolean))).slice(0, 18);
}

function agentIsPreparedForInstantSearch(agent: AgentRecord) {
  if (agent.open_status !== "open") return false;
  if (agentNeedsIntel(agent)) return false;
  if (agent.query_method === "email") return validEmail(agent.public_email);
  return validUrl(agent.submission_url || agent.source_url);
}

async function instantOpenAgentSearch(env: Env, body: Record<string, unknown>) {
  const terms = instantSearchTerms(body);
  if (!terms.length) return [];
  const fields = [
    "qag.normalized_genre",
    "qag.normalized_subgenre",
    "lower(qag.genre_evidence)",
    "lower(qag.subgenre_evidence)",
    "lower(qag.fit_reason)",
    "lower(qa.genre_fit)",
    "lower(COALESCE(qr.wishlist_summary, ''))",
    "lower(COALESCE(qr.requirements_summary, qa.requirements_summary))",
  ];
  const maxTerms = Math.max(1, Math.floor(88 / fields.length));
  const params: string[] = [];
  const termClauses = terms.slice(0, maxTerms).map((term) => {
    const fieldClauses = fields.map((field) => {
      params.push(`%${term}%`);
      return `${field} LIKE ?${params.length}`;
    });
    return `(${fieldClauses.join(" OR ")})`;
  });
  params.push(String(INSTANT_SEARCH_LIMIT));
  try {
    const rows = await all<Parameters<typeof rowToIntelAgent>[0] & { final_rank_score: number }>(
      env.DB,
      `SELECT qa.agent_name,
              qa.agency,
              qa.genre_fit,
              COALESCE(NULLIF(qag.genre, ''), qa.matched_genre) AS matched_genre,
              COALESCE(NULLIF(qag.subgenre, ''), qa.matched_subgenre) AS matched_subgenre,
              COALESCE(NULLIF(qag.genre_evidence, ''), qa.genre_evidence) AS genre_evidence,
              COALESCE(NULLIF(qag.subgenre_evidence, ''), qa.subgenre_evidence) AS subgenre_evidence,
              COALESCE(NULLIF(qag.fit_reason, ''), qa.fit_reason) AS fit_reason,
              COALESCE(qr.query_method, qa.query_method) AS query_method,
              COALESCE(qr.submission_url, qa.submission_url) AS submission_url,
              COALESCE(qr.public_email, qa.public_email) AS public_email,
              COALESCE(qr.requirements_summary, qa.requirements_summary) AS requirements_summary,
              COALESCE(qr.email_opener, qa.email_opener) AS email_opener,
              qa.open_status,
              COALESCE(qr.source_url, qa.source_url) AS source_url,
              COALESCE(qr.source_urls_json, qa.source_urls_json) AS source_urls_json,
              COALESCE(qr.verification_notes, qa.verification_notes) AS verification_notes,
              COALESCE(qr.required_materials_json, qa.required_materials_json) AS required_materials_json,
              COALESCE(qr.wishlist_summary, '') AS wishlist_summary,
              COALESCE(qr.submission_requirements_json, '{}') AS submission_requirements_json,
              qss.schema_json AS schema_json,
              qss.submission_method AS schema_method,
              qss.submission_url AS schema_submission_url,
              qss.requires_query_letter AS schema_requires_query_letter,
              qss.requires_synopsis AS schema_requires_synopsis,
              qss.synopsis_type AS schema_synopsis_type,
              qss.requires_bio AS schema_requires_bio,
              qss.sample_pages AS schema_sample_pages,
              qss.attachment_rules_json AS schema_attachment_rules_json,
              qss.form_fields_json AS schema_form_fields_json,
              qss.querymanager_enabled AS schema_querymanager_enabled,
              qss.email_submission_enabled AS schema_email_submission_enabled,
              qss.last_verified AS schema_last_verified,
              qss.confidence AS schema_confidence,
              qa.submission_route_verified,
              qa.submission_route_verified_at,
              qa.submission_route_status,
              qa.submission_route_notes,
              qa.last_verified,
              qa.confidence_score,
              COALESCE(qs.final_rank_score, qa.confidence_score) AS final_rank_score
       FROM quick_agent_genres qag
       JOIN quick_agents qa ON qa.id = qag.agent_id
       LEFT JOIN quick_agent_requirements qr ON qr.agent_id = qa.id
       LEFT JOIN quick_agent_submission_schema qss ON qss.agent_id = qa.id
       LEFT JOIN quick_agent_scores qs ON qs.agent_id = qa.id
       WHERE qa.open_status = 'open'
         AND qag.active = 1
         AND COALESCE(qr.requirements_summary, qa.requirements_summary) != ''
         AND lower(COALESCE(qr.requirements_summary, qa.requirements_summary)) NOT LIKE '%building agent intel%'
         AND (${termClauses.join(" OR ")})
       ORDER BY
         COALESCE(qs.final_rank_score, qa.confidence_score) DESC,
         qa.submission_route_verified DESC,
         qa.confidence_score DESC,
         qag.last_seen_at DESC
       LIMIT ?${params.length}`,
      params
    );
    return rows.map(rowToIntelAgent).filter(agentIsPreparedForInstantSearch);
  } catch {
    const fallback = await storedOpenAgentPool(env, body);
    return fallback.filter(agentIsPreparedForInstantSearch).slice(0, INSTANT_SEARCH_LIMIT);
  }
}

async function recordInstantAgentSearch(
  env: Env,
  userId: string,
  key: string,
  body: Record<string, unknown>,
  agents: AgentRecord[]
) {
  const now = nowIso();
  const searchId = crypto.randomUUID();
  await run(
    env.DB,
    `INSERT INTO quick_agent_searches (id, user_id, cache_key, genre, subgenre, category, result_count, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    [searchId, userId, key, clean(body.genre), clean(body.subgenre), clean(body.category), agents.length, now]
  );
  for (let index = 0; index < agents.length; index += 1) {
    await run(
      env.DB,
      `INSERT OR IGNORE INTO quick_agent_search_results (search_id, agent_id, rank, created_at)
       VALUES (?1, (SELECT id FROM quick_agents WHERE normalized_key = ?2), ?3, ?4)`,
      [searchId, normalizedAgentKey(agents[index]), index + 1, now]
    );
  }
}

export async function handleAgentIntelRefresh(env: Env) {
  const rows = await all<{
    id: string;
    normalized_key: string;
    agent_name: string;
    agency: string;
    genre_fit: string;
    matched_genre: string;
    matched_subgenre: string;
    genre_evidence: string;
    subgenre_evidence: string;
    fit_reason: string;
    query_method: AgentRecord["query_method"];
    submission_url: string;
    public_email: string;
    requirements_summary: string;
    email_opener: string;
    open_status: AgentRecord["open_status"];
    source_url: string;
    source_urls_json: string;
    verification_notes: string;
    required_materials_json: string;
    submission_route_verified: number;
    submission_route_verified_at: string;
    submission_route_status: number;
    submission_route_notes: string;
    last_verified: string;
    confidence_score: number;
  }>(
    env.DB,
    `SELECT id, normalized_key, agent_name, agency, genre_fit, matched_genre, matched_subgenre, genre_evidence,
            subgenre_evidence, fit_reason, query_method, submission_url, public_email, requirements_summary,
            email_opener, open_status, source_url, source_urls_json, verification_notes, required_materials_json,
            submission_route_verified, submission_route_verified_at, submission_route_status, submission_route_notes,
            last_verified, confidence_score
     FROM quick_agents
     WHERE next_refresh_at = '' OR datetime(next_refresh_at) <= datetime('now')
     ORDER BY
       CASE WHEN open_status = 'open' THEN 0 ELSE 1 END,
       datetime(next_refresh_at) ASC
     LIMIT 25`
  );

  const now = new Date().toISOString();
  for (const row of rows) {
    const agent = rowToIntelAgent(row);
    const result = await verifySubmissionRouteResult(agent);
    const nextRefreshAt = new Date(Date.now() + (result.agent ? 6 : 1) * 60 * 60 * 1000).toISOString();
    await run(
      env.DB,
      `UPDATE quick_agents
       SET open_status = ?1,
           last_verified = ?2,
           submission_route_verified = ?3,
           submission_route_verified_at = ?4,
           submission_route_status = ?5,
           submission_route_notes = ?6,
           refresh_status = ?7,
           refresh_error = ?8,
           next_refresh_at = ?9
       WHERE id = ?10`,
      [
        result.closed ? "closed" : row.open_status,
        result.agent ? now : row.last_verified,
        result.agent ? 1 : 0,
        result.agent?.submission_route_verified_at || row.submission_route_verified_at || "",
        result.status,
        result.agent?.submission_route_notes || result.notes,
        result.agent ? "fresh" : result.closed ? "closed" : "needs_review",
        result.agent ? "" : result.notes,
        nextRefreshAt,
        row.id,
      ]
    );
    await recordAgentStatusCheck(
      env,
      row.id,
      submissionRouteUrl(agent),
      result.closed ? "closed" : row.open_status,
      Boolean(result.agent),
      result.status,
      result.agent?.submission_route_notes || result.notes,
      now
    );
  }

  return { ok: true, checked: rows.length };
}

export async function handleWaitlist(request: Request, env: Env) {
  if (request.method !== "POST") return badRequest("Method not allowed.", 405);
  const body = await request.json() as Record<string, unknown>;
  const email = clean(body.email).toLowerCase();
  const product = clean(body.product) || "query_salon_pro";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return badRequest("A valid email is required.");
  await run(env.DB, `INSERT INTO waitlist (id, email, product, created_at) VALUES (?1, ?2, ?3, ?4)`, [
    crypto.randomUUID(),
    email,
    product,
    new Date().toISOString(),
  ]);
  return json({ ok: true });
}

async function requestAgentSearchBody(request: Request) {
  if (request.method === "GET") {
    const url = new URL(request.url);
    return {
      genre: url.searchParams.get("genre") || "",
      subgenre: url.searchParams.get("subgenre") || "",
      category: url.searchParams.get("category") || url.searchParams.get("audience") || "adult fiction",
      tone: url.searchParams.get("tone") || "",
      audience: url.searchParams.get("audience") || "",
    };
  }
  return await request.json() as Record<string, unknown>;
}

async function enqueueAgentEngineJob(env: Env, message: AgentEngineQueueMessage) {
  const job = canonicalJobPayload(message);
  const jobId = job.job_id || crypto.randomUUID();
  const queueName = queueNames[job.job_type];
  const queuedMessage = { ...job, job_id: jobId };
  try {
    await run(
      env.DB,
      `INSERT INTO quick_agent_engine_jobs (
         id, queue_name, job_type, status, priority, agent_id, source_url,
         genre, subgenre, reason, payload_json, scheduled_for, created_at
       )
       VALUES (?1, ?2, ?3, 'queued', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
       ON CONFLICT(id) DO UPDATE SET
         status = 'queued',
         priority = excluded.priority,
         scheduled_for = excluded.scheduled_for,
         payload_json = excluded.payload_json`,
      [
        jobId,
        queueName,
        job.job_type,
        Number(job.priority || 50),
        clean(job.agent_id),
        clean(job.source_url),
        clean(job.genre),
        clean(job.subgenre),
        clean(job.reason),
        JSON.stringify(job.payload || {}),
        "",
        job.created_at || nowIso(),
      ]
    );
  } catch {
    // The ledger appears after the operational migration; queue dispatch can still proceed.
  }
  const queue = queueBindingForJob(env, job.job_type);
  if (queue) await queue.send(queuedMessage);
}

async function enqueueSearchMaintenance(env: Env, body: Record<string, unknown>, resultCount: number) {
  const genre = clean(body.genre);
  const subgenre = clean(body.subgenre);
  const category = clean(body.category) || "adult fiction";
  const priority = resultCount < 10 ? 92 : resultCount < 25 ? 72 : 45;
  if (resultCount < 25) {
    for (const lane of queuedDiscoveryLanes(body, resultCount)) {
      await enqueueAgentEngineJob(env, {
        job_type: "agent-discovery",
        genre,
        subgenre,
        category,
        tone: clean(body.tone),
        audience: clean(body.audience),
        priority,
        reason: resultCount ? `search-low-coverage:${lane.id}` : `search-empty-lane:${lane.id}`,
        payload: {
          include_stored_pool: false,
          expanded_genres: genreExpansionTerms(body),
          discovery_lane: lane.id,
          discovery_source: lane.source,
          discovery_focus: lane.focus,
        },
      });
    }
  }
  await enqueueAgentEngineJob(env, {
    job_type: "ranking-refresh",
    genre,
    subgenre,
    category,
    priority: 40,
    reason: "post-search-rank-maintenance",
  });
}

export async function handleAgentSearch(request: Request, env: Env, ctx?: ExecutionContext) {
  if (request.method !== "POST" && request.method !== "GET") return badRequest("Method not allowed.", 405);
  const session = await requireSession(request, env);
  const body = await requestAgentSearchBody(request);
  if (!clean(body.genre) || !clean(body.category)) return badRequest("Genre and category are required.");

  const key = cacheKey(body);
  const seenKeys = await userSeenAgentKeys(env, session.user.id);
  const agents = markSeenBefore(dedupeAgents(await instantOpenAgentSearch(env, body)), seenKeys);
  await recordInstantAgentSearch(env, session.user.id, key, body, agents);
  const maintenance = enqueueSearchMaintenance(env, body, agents.length);
  if (ctx) {
    ctx.waitUntil(maintenance);
  } else {
    await maintenance;
  }
  return json({
    ok: true,
    cached: false,
    instant: true,
    agents,
    diagnostics: {
      raw_count: agents.length,
      candidate_count: agents.length,
      verified_count: agents.length,
      source: "precomputed_d1",
      background_refresh_queued: agents.length < 25,
    },
  });
}

export async function handleAgentDiscover(request: Request, env: Env, ctx?: ExecutionContext) {
  if (request.method !== "POST") return badRequest("Method not allowed.", 405);
  const session = await requireSession(request, env);
  const body = await request.json() as Record<string, unknown>;
  if (!clean(body.genre) || !clean(body.category)) return badRequest("Genre and category are required.");

  const key = cacheKey(body);
  const seenKeys = await userSeenAgentKeys(env, session.user.id);
  const agents = markSeenBefore(dedupeAgents(await instantOpenAgentSearch(env, body)), seenKeys);
  await recordInstantAgentSearch(env, session.user.id, key, body, agents);
  const discoveryFocus = clean(body.discovery_focus);
  const discoveryJobs = discoveryFocus
    ? [enqueueAgentEngineJob(env, {
      job_type: "agent-discovery",
      genre: clean(body.genre),
      subgenre: clean(body.subgenre),
      category: clean(body.category),
      tone: clean(body.tone),
      audience: clean(body.audience),
      reason: discoveryFocus,
      priority: Number(body.priority || 75),
      payload: {
        discovery_lane: clean(body.discovery_lane),
        discovery_source: clean(body.discovery_source),
        discovery_focus: discoveryFocus,
        expanded_genres: Array.isArray(body.expanded_genres) ? body.expanded_genres : genreExpansionTerms(body),
        include_stored_pool: false,
        exclude_agents: Array.isArray(body.exclude_agents) ? body.exclude_agents : [],
      },
    })]
    : queuedDiscoveryLanes(body, agents.length).map((lane) => enqueueAgentEngineJob(env, {
      job_type: "agent-discovery",
      genre: clean(body.genre),
      subgenre: clean(body.subgenre),
      category: clean(body.category),
      tone: clean(body.tone),
      audience: clean(body.audience),
      reason: `manual-background-discovery:${lane.id}`,
      priority: Number(body.priority || 75),
      payload: {
        discovery_lane: lane.id,
        discovery_source: lane.source,
        discovery_focus: lane.focus,
        expanded_genres: Array.isArray(body.expanded_genres) ? body.expanded_genres : genreExpansionTerms(body),
        include_stored_pool: false,
        exclude_agents: Array.isArray(body.exclude_agents) ? body.exclude_agents : [],
      },
    }));
  const discovery = Promise.all(discoveryJobs);
  if (ctx) {
    ctx.waitUntil(discovery);
  } else {
    await discovery;
  }
  return json({
    ok: true,
    cached: false,
    instant: true,
    agents,
    diagnostics: {
      raw_count: agents.length,
      candidate_count: agents.length,
      verified_count: agents.length,
      source: "precomputed_d1_background_discovery_queued",
    },
  });
}

async function markEngineJob(env: Env, jobId: string | undefined, status: string, patch: Record<string, unknown> = {}) {
  if (!jobId) return;
  const now = nowIso();
  try {
    if (status === "processing") {
      await run(
        env.DB,
        `UPDATE quick_agent_engine_jobs
         SET status = 'processing', attempts = attempts + 1, started_at = ?1, last_error = ''
         WHERE id = ?2`,
        [now, jobId]
      );
      return;
    }
    if (status === "failed") {
      await run(
        env.DB,
        `UPDATE quick_agent_engine_jobs
         SET status = 'failed', last_error = ?1, finished_at = ?2
         WHERE id = ?3`,
        [clean(patch.error).slice(0, 500), now, jobId]
      );
      return;
    }
    await run(
      env.DB,
      `UPDATE quick_agent_engine_jobs
       SET status = ?1, finished_at = ?2, last_error = ''
       WHERE id = ?3`,
      [status, now, jobId]
    );
  } catch {
    // Job ledger writes are useful for operations but should not poison queue retries.
  }
}

async function loadAgentById(env: Env, agentId: string) {
  if (!agentId) return null;
  const row = await one<Parameters<typeof rowToIntelAgent>[0]>(
    env.DB,
    `SELECT qa.agent_name,
            qa.agency,
            qa.genre_fit,
            qa.matched_genre,
            qa.matched_subgenre,
            qa.genre_evidence,
            qa.subgenre_evidence,
            qa.fit_reason,
            COALESCE(qr.query_method, qa.query_method) AS query_method,
            COALESCE(qr.submission_url, qa.submission_url) AS submission_url,
            COALESCE(qr.public_email, qa.public_email) AS public_email,
            COALESCE(qr.requirements_summary, qa.requirements_summary) AS requirements_summary,
            COALESCE(qr.email_opener, qa.email_opener) AS email_opener,
            qa.open_status,
            COALESCE(qr.source_url, qa.source_url) AS source_url,
            COALESCE(qr.source_urls_json, qa.source_urls_json) AS source_urls_json,
            COALESCE(qr.verification_notes, qa.verification_notes) AS verification_notes,
            COALESCE(qr.required_materials_json, qa.required_materials_json) AS required_materials_json,
            COALESCE(qr.wishlist_summary, '') AS wishlist_summary,
            COALESCE(qr.submission_requirements_json, '{}') AS submission_requirements_json,
            qa.submission_route_verified,
            qa.submission_route_verified_at,
            qa.submission_route_status,
            qa.submission_route_notes,
            qa.last_verified,
            qa.confidence_score
     FROM quick_agents qa
     LEFT JOIN quick_agent_requirements qr ON qr.agent_id = qa.id
     WHERE qa.id = ?1`,
    [agentId]
  );
  return row ? rowToIntelAgent(row) : null;
}

function bodyFromQueueMessage(message: AgentEngineQueueMessage) {
  return {
    genre: clean(message.genre || message.payload?.genre),
    subgenre: clean(message.subgenre || message.payload?.subgenre),
    category: clean(message.category || message.payload?.category) || "adult fiction",
    tone: clean(message.tone || message.payload?.tone),
    audience: clean(message.audience || message.payload?.audience),
    discovery_lane: clean(message.payload?.discovery_lane),
    discovery_source: clean(message.payload?.discovery_source || message.source_url),
    discovery_focus: clean(message.payload?.discovery_focus),
    expanded_genres: Array.isArray(message.payload?.expanded_genres) ? message.payload?.expanded_genres : undefined,
    exclude_agents: Array.isArray(message.payload?.exclude_agents) ? message.payload?.exclude_agents : [],
    include_stored_pool: false,
  };
}

async function hashText(value: string) {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buffer)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function captureAgentSnapshots(env: Env, agentId: string, agent: AgentRecord) {
  if (!env.FILES) return;
  const urls = Array.from(new Set([
    agent.source_url,
    submissionRouteUrl(agent),
    ...(agent.source_urls || []),
  ].map(clean).filter(validUrl))).slice(0, 4);
  for (const sourceUrl of urls) {
    const text = await fetchSourceSnippet(sourceUrl);
    if (!text) continue;
    const hash = await hashText(text);
    const id = crypto.randomUUID();
    const created = nowIso();
    const expiresAt = new Date(Date.now() + SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const key = `agent-engine/snapshots/${created.slice(0, 10)}/${agentId}/${id}.txt`;
    await env.FILES.put(key, text, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: { source_url: sourceUrl, agent_id: agentId, expires_at: expiresAt },
    });
    try {
      await run(
        env.DB,
        `INSERT INTO quick_agent_snapshots (
           id, agent_id, source_url, r2_key, snapshot_kind, content_hash, expires_at, created_at
         )
         VALUES (?1, ?2, ?3, ?4, 'source-text', ?5, ?6, ?7)`,
        [id, agentId, sourceUrl, key, hash, expiresAt, created]
      );
    } catch {
      // Snapshot object retention can still be governed by R2 lifecycle while the ledger migrates.
    }
  }
}

async function openAiEmbedding(env: Env, text: string) {
  if (!env.OPENAI_API_KEY || !text.trim()) return null;
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: clean(env.OPENAI_EMBEDDING_MODEL) || "text-embedding-3-small",
      input: text.slice(0, 6000),
    }),
  });
  const data = await response.json() as { data?: Array<{ embedding?: number[] }>; error?: { message?: string } };
  if (!response.ok) throw new Error(data.error?.message || "Embedding generation failed.");
  return data.data?.[0]?.embedding || null;
}

async function upsertWishlistVector(env: Env, agentId: string, agent: AgentRecord) {
  if (!env.WISHLIST_INDEX || !env.OPENAI_API_KEY) return;
  const text = wishlistSummaryForAgent(agent);
  if (!text) return;
  const embedding = await openAiEmbedding(env, text);
  if (!embedding) return;
  const contentHash = await hashText(text);
  await env.WISHLIST_INDEX.upsert([{
    id: agentId,
    values: embedding,
    namespace: "wishlist",
    metadata: {
      agent_id: agentId,
      agent_name: agent.agent_name,
      agency: agent.agency,
      genre: normalizeSearchText(agent.matched_genre || agent.genre_fit),
      subgenre: normalizeSearchText(agent.matched_subgenre || ""),
      open_status: agent.open_status,
    },
  }]);
  try {
    await run(
      env.DB,
      `INSERT INTO quick_agent_vectors (
         agent_id, vector_id, namespace, content_hash, embedded_at, updated_at
       )
       VALUES (?1, ?2, 'wishlist', ?3, ?4, ?5)
       ON CONFLICT(agent_id) DO UPDATE SET
         vector_id = excluded.vector_id,
         content_hash = excluded.content_hash,
         embedded_at = excluded.embedded_at,
         updated_at = excluded.updated_at`,
      [agentId, agentId, contentHash, nowIso(), nowIso()]
    );
  } catch {
    // Vectorize remains usable even when the D1 vector ledger is still migrating.
  }
}

async function processAgentDiscoveryJob(env: Env, message: AgentEngineQueueMessage) {
  const body = bodyFromQueueMessage(message);
  const result = await generateLiveCandidatePoolForResponse(env, body, EMPTY_POOL_DISCOVERY_BUDGET_MS);
  const now = nowIso();
  for (const agent of result.agents) {
    const saved = await saveAgentToMaster(env, body, agent, now);
    await enqueueAgentEngineJob(env, {
      job_type: agentNeedsIntel(agent) ? "wishlist-extraction" : "ranking-refresh",
      agent_id: saved.agentId,
      genre: clean(body.genre),
      subgenre: clean(body.subgenre),
      category: clean(body.category),
      priority: agentNeedsIntel(agent) ? 76 : 55,
      reason: "discovery-result",
    });
    await enqueueAgentEngineJob(env, {
      job_type: "genre-normalization",
      agent_id: saved.agentId,
      genre: clean(body.genre),
      subgenre: clean(body.subgenre),
      category: clean(body.category),
      priority: 50,
      reason: "discovery-genre-fit",
    });
  }
}

async function processOneAgentVerification(env: Env, agentId: string) {
  const agent = await loadAgentById(env, agentId);
  if (!agent) return;
  const result = await verifySubmissionRouteResult(agent);
  const now = nowIso();
  await run(
    env.DB,
    `UPDATE quick_agents
     SET open_status = ?1,
         last_verified = ?2,
         submission_route_verified = ?3,
         submission_route_verified_at = ?4,
         submission_route_status = ?5,
         submission_route_notes = ?6,
         refresh_status = ?7,
         refresh_error = ?8,
         next_refresh_at = ?9
     WHERE id = ?10`,
    [
      result.closed ? "closed" : result.agent ? "open" : agent.open_status,
      result.agent ? now : agent.last_verified,
      result.agent ? 1 : 0,
      result.agent?.submission_route_verified_at || agent.submission_route_verified_at || "",
      result.status,
      result.agent?.submission_route_notes || result.notes,
      result.agent ? "fresh" : result.closed ? "closed" : "needs_review",
      result.agent ? "" : result.notes,
      new Date(Date.now() + (result.agent ? 6 : 1) * 60 * 60 * 1000).toISOString(),
      agentId,
    ]
  );
  await recordAgentStatusCheck(
    env,
    agentId,
    submissionRouteUrl(agent),
    result.closed ? "closed" : result.agent ? "open" : agent.open_status,
    Boolean(result.agent),
    result.status,
    result.agent?.submission_route_notes || result.notes,
    now
  );
  await refreshAgentScore(env, agentId);
  if (result.agent) {
    await enqueueAgentEngineJob(env, {
      job_type: "notification-check",
      agent_id: agentId,
      genre: result.agent.matched_genre || result.agent.genre_fit,
      subgenre: result.agent.matched_subgenre || "",
      priority: 60,
      reason: "status-open",
    });
  }
}

async function processWishlistExtractionJob(env: Env, message: AgentEngineQueueMessage) {
  const agentId = clean(message.agent_id);
  const agent = await loadAgentById(env, agentId);
  if (!agent) return;
  const body = {
    genre: clean(message.genre) || agent.matched_genre || agent.genre_fit,
    subgenre: clean(message.subgenre) || agent.matched_subgenre,
    category: clean(message.category) || "adult fiction",
    candidates: [agent],
  };
  const enriched = await generateAgents(env, body);
  const next = enriched.agents[0] || agent;
  await saveAgentToMaster(env, body, next, nowIso());
  await captureAgentSnapshots(env, agentId, next);
  await upsertWishlistVector(env, agentId, next);
}

async function processGenreNormalizationJob(env: Env, message: AgentEngineQueueMessage) {
  const agent = clean(message.agent_id) ? await loadAgentById(env, clean(message.agent_id)) : null;
  const genre = clean(message.genre) || agent?.matched_genre || agent?.genre_fit || "";
  const subgenre = clean(message.subgenre) || agent?.matched_subgenre || "";
  const category = clean(message.category) || "adult fiction";
  const aliases = Array.from(new Set([
    genre,
    subgenre,
    ...(agent ? [agent.genre_fit, agent.matched_genre, agent.matched_subgenre] : []),
  ].map(clean).filter(Boolean)));
  const now = nowIso();
  for (const alias of aliases) {
    await run(
      env.DB,
      `INSERT INTO quick_genre_aliases (
         id, alias, normalized_alias, canonical_genre, canonical_subgenre,
         audience, confidence_score, source, active, created_at, updated_at
       )
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 70, 'engine', 1, ?7, ?8)
       ON CONFLICT(alias) DO UPDATE SET
         normalized_alias = excluded.normalized_alias,
         canonical_genre = excluded.canonical_genre,
         canonical_subgenre = excluded.canonical_subgenre,
         audience = excluded.audience,
         confidence_score = max(confidence_score, excluded.confidence_score),
         active = 1,
         updated_at = excluded.updated_at`,
      [crypto.randomUUID(), alias, normalizeSearchText(alias), genre, subgenre, category, now, now]
    );
  }
}

async function processRankingRefreshJob(env: Env, message: AgentEngineQueueMessage) {
  const agentId = clean(message.agent_id);
  if (agentId) {
    await refreshAgentScore(env, agentId);
    return;
  }
  const rows = await all<{ id: string }>(
    env.DB,
    `SELECT qa.id
     FROM quick_agents qa
     LEFT JOIN quick_agent_scores qs ON qs.agent_id = qa.id
     WHERE qa.open_status = 'open'
       AND (qs.updated_at IS NULL OR datetime(qs.updated_at) <= datetime('now', '-6 hours'))
     ORDER BY qa.confidence_score DESC, qa.last_seen_at DESC
     LIMIT 100`
  );
  for (const row of rows) await refreshAgentScore(env, row.id);
}

async function processNotificationCheckJob(env: Env, message: AgentEngineQueueMessage) {
  const agentId = clean(message.agent_id);
  if (!agentId) return;
  const agent = await loadAgentById(env, agentId);
  if (!agent || agent.open_status !== "open") return;
  const genre = normalizeSearchText(agent.matched_genre || agent.genre_fit);
  const subgenre = normalizeSearchText(agent.matched_subgenre || "");
  const watches = await all<{ id: string }>(
    env.DB,
    `SELECT id
     FROM quick_notification_watches
     WHERE active = 1
       AND normalized_genre = ?1
       AND (normalized_subgenre = '' OR normalized_subgenre = ?2)
     LIMIT 100`,
    [genre, subgenre]
  );
  for (const watch of watches) {
    await run(
      env.DB,
      `INSERT INTO quick_agent_notifications (
         id, watch_id, agent_id, notification_type, message, created_at, sent_at
       )
       SELECT ?1, ?2, ?3, 'agent-opened', ?4, ?5, ''
       WHERE NOT EXISTS (
         SELECT 1 FROM quick_agent_notifications
         WHERE watch_id = ?2 AND agent_id = ?3 AND notification_type = 'agent-opened'
       )`,
      [
        crypto.randomUUID(),
        watch.id,
        agentId,
        `${agent.agent_name} at ${agent.agency} is open for ${agent.matched_genre || agent.genre_fit}.`,
        nowIso(),
      ]
    );
  }
}

async function processAgentEngineMessage(env: Env, message: AgentEngineQueueMessage) {
  switch (message.job_type) {
    case "agent-discovery":
      await processAgentDiscoveryJob(env, message);
      return;
    case "agent-verification":
    case "open-status-refresh":
      if (clean(message.agent_id)) {
        await processOneAgentVerification(env, clean(message.agent_id));
      } else {
        await handleAgentIntelRefresh(env);
      }
      return;
    case "wishlist-extraction":
      await processWishlistExtractionJob(env, message);
      return;
    case "genre-normalization":
      await processGenreNormalizationJob(env, message);
      return;
    case "ranking-refresh":
      await processRankingRefreshJob(env, message);
      return;
    case "notification-check":
      await processNotificationCheckJob(env, message);
      return;
  }
}

export async function handleAgentEngineQueue(batch: MessageBatch<AgentEngineQueueMessage>, env: Env) {
  for (const message of batch.messages) {
    try {
      await markEngineJob(env, message.body.job_id, "processing");
      await processAgentEngineMessage(env, message.body);
      await markEngineJob(env, message.body.job_id, "done");
      message.ack();
    } catch (error) {
      const failureMessage = await errorMessage(error, "Queue job failed.");
      await markEngineJob(env, message.body.job_id, "failed", {
        error: failureMessage,
      });
      message.retry({ delaySeconds: Math.min(3600, 60 * Math.max(1, message.attempts)) });
    }
  }
}

async function enqueueDueOpenStatusJobs(env: Env, reason: string, limit: number) {
  const rows = await all<{ id: string; matched_genre: string; matched_subgenre: string; genre_fit: string }>(
    env.DB,
    `SELECT id, matched_genre, matched_subgenre, genre_fit
     FROM quick_agents
     WHERE open_status IN ('open', 'selective')
       AND (next_refresh_at = '' OR datetime(next_refresh_at) <= datetime('now'))
     ORDER BY
       CASE WHEN open_status = 'open' THEN 0 ELSE 1 END,
       datetime(next_refresh_at) ASC,
       confidence_score DESC
     LIMIT ?1`,
    [limit]
  );
  for (const row of rows) {
    await enqueueAgentEngineJob(env, {
      job_type: "open-status-refresh",
      agent_id: row.id,
      genre: row.matched_genre || row.genre_fit,
      subgenre: row.matched_subgenre || "",
      reason,
      priority: 80,
    });
  }
}

async function enqueueMediumConfidenceJobs(env: Env) {
  const rows = await all<{ id: string; matched_genre: string; matched_subgenre: string; genre_fit: string }>(
    env.DB,
    `SELECT id, matched_genre, matched_subgenre, genre_fit
     FROM quick_agents
     WHERE open_status IN ('open', 'selective')
       AND (confidence_score BETWEEN 35 AND 74 OR refresh_status IN ('candidate', 'needs_review'))
     ORDER BY confidence_score ASC, last_seen_at DESC
     LIMIT 50`
  );
  for (const row of rows) {
    await enqueueAgentEngineJob(env, {
      job_type: "wishlist-extraction",
      agent_id: row.id,
      genre: row.matched_genre || row.genre_fit,
      subgenre: row.matched_subgenre || "",
      reason: "medium-confidence-refresh",
      priority: 70,
    });
  }
}

async function enqueueValidatedPathDiscoveryJobs(env: Env, reason: string, limit: number) {
  const rows = await all<{
    source_url: string;
    normalized_genre: string;
    normalized_subgenre: string;
    genre_lane: string;
    priority: number;
  }>(
    env.DB,
    `SELECT source_url, normalized_genre, normalized_subgenre, genre_lane, priority
     FROM quick_validated_agent_paths
     WHERE status = 'watching'
       AND (next_check_at = '' OR datetime(next_check_at) <= datetime('now'))
     ORDER BY priority DESC, open_agent_yield DESC, updated_at DESC
     LIMIT ?1`,
    [limit]
  );
  for (const row of rows) {
    await enqueueAgentEngineJob(env, {
      job_type: "agent-discovery",
      genre: row.normalized_genre,
      subgenre: row.normalized_subgenre,
      source_url: row.source_url,
      reason,
      priority: Math.max(60, Number(row.priority || 50)),
      payload: {
        discovery_source: row.source_url,
        discovery_focus: row.genre_lane || `validated source path for ${row.normalized_genre}`,
      },
    });
  }
}

async function enqueueLowCoverageDiscoveryJobs(env: Env) {
  const rows = await all<{ genre: string; subgenre: string; category: string; result_count: number }>(
    env.DB,
    `SELECT genre, subgenre, category, min(result_count) AS result_count
     FROM quick_agent_searches
     WHERE datetime(created_at) >= datetime('now', '-7 days')
     GROUP BY genre, subgenre, category
     HAVING min(result_count) < 15
     ORDER BY min(result_count) ASC, max(created_at) DESC
     LIMIT 20`
  );
  for (const row of rows) {
    const laneBody = {
      genre: row.genre,
      subgenre: row.subgenre,
      category: row.category,
    };
    for (const lane of queuedDiscoveryLanes(laneBody, Number(row.result_count || 0)).slice(0, 3)) {
      await enqueueAgentEngineJob(env, {
        job_type: "agent-discovery",
        genre: row.genre,
        subgenre: row.subgenre,
        category: row.category,
        reason: `recent-search-low-coverage:${lane.id}`,
        priority: row.result_count < 5 ? 90 : 72,
        payload: {
          discovery_lane: lane.id,
          discovery_source: lane.source,
          discovery_focus: lane.focus,
          expanded_genres: genreExpansionTerms(laneBody),
        },
      });
    }
  }
}

async function cleanupExpiredSnapshots(env: Env) {
  if (!env.FILES) return;
  const rows = await all<{ id: string; r2_key: string }>(
    env.DB,
    `SELECT id, r2_key
     FROM quick_agent_snapshots
     WHERE datetime(expires_at) <= datetime('now')
     ORDER BY expires_at ASC
     LIMIT 100`
  );
  for (const row of rows) {
    await env.FILES.delete(row.r2_key);
    await run(env.DB, `DELETE FROM quick_agent_snapshots WHERE id = ?1`, [row.id]);
  }
}

export async function handleAgentEngineScheduled(controller: ScheduledController, env: Env) {
  const cron = controller.cron;
  if (cron === "0 * * * *") {
    await enqueueDueOpenStatusJobs(env, "hourly-open-status", 80);
    await cleanupExpiredSnapshots(env);
    return;
  }
  if (cron === "17 */6 * * *") {
    await enqueueMediumConfidenceJobs(env);
    await enqueueDueOpenStatusJobs(env, "six-hour-medium-confidence", 40);
    return;
  }
  if (cron === "30 8 * * *") {
    await enqueueLowCoverageDiscoveryJobs(env);
    await enqueueValidatedPathDiscoveryJobs(env, "daily-validated-path-refresh", 30);
    return;
  }
  if (cron === "45 8 * * *") {
    await enqueueAgentEngineJob(env, { job_type: "ranking-refresh", reason: "daily-ranking-recompute", priority: 65 });
    await enqueueDueOpenStatusJobs(env, "daily-stale-agent-sweep", 120);
    return;
  }
  if (cron === "0 9 * * 1") {
    await enqueueValidatedPathDiscoveryJobs(env, "weekly-full-source-verification", 100);
    await enqueueDueOpenStatusJobs(env, "weekly-full-status-verification", 200);
  }
}

export async function handleQuickProfile(request: Request, env: Env) {
  const session = await requireSession(request, env);
  if (request.method === "GET") {
    const rows = await all(env.DB, `SELECT * FROM quick_profiles WHERE user_id = ?1`, [session.user.id]);
    return json({ ok: true, profile: rows[0] || null });
  }
  if (request.method !== "POST") return badRequest("Method not allowed.", 405);
  const body = await request.json() as Record<string, unknown>;
  await run(
    env.DB,
    `INSERT OR REPLACE INTO quick_profiles (user_id, name, book_title, genre, subgenre, category, word_count, query_text, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    [
      session.user.id,
      clean(body.name),
      clean(body.book_title),
      clean(body.genre),
      clean(body.subgenre),
      clean(body.category),
      clean(body.word_count),
      String(body.query_text || ""),
      new Date().toISOString(),
    ]
  );
  return json({ ok: true });
}

export async function handleQuickFileUpload(request: Request, env: Env) {
  if (request.method !== "POST") return badRequest("Method not allowed.", 405);
  const session = await requireSession(request, env);
  if (session.user.role !== "writer") return badRequest("Writer access required.", 403);
  const formData = await request.formData();
  const kind = String(formData.get("kind") || "").trim();
  const file = formData.get("file");
  if (!allowedFileKinds.has(kind)) return badRequest("A valid file kind is required.");
  if (!(file instanceof File)) return badRequest("A file is required.");
  const maxBytes = 12 * 1024 * 1024;
  if (file.size > maxBytes) return badRequest("Files must be 12 MB or smaller.");

  const safeName = file.name.replace(/[^\w.\- ]+/g, "").trim() || "submission-file";
  const id = crypto.randomUUID();
  const key = `quick/${session.user.id}/${kind}/${id}-${safeName}`;
  if (env.FILES) {
    await env.FILES.put(key, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type || "application/octet-stream" },
    });
  }
  await run(
    env.DB,
    `INSERT INTO quick_submission_files (id, user_id, kind, file_name, file_key, content_type, size_bytes, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    [id, session.user.id, kind, safeName, key, file.type || "", file.size, new Date().toISOString()]
  );
  return json({ ok: true, uploaded: true, kind, file_name: safeName });
}

export async function handleMarkSent(request: Request, env: Env) {
  if (request.method !== "POST") return badRequest("Method not allowed.", 405);
  const session = await requireSession(request, env);
  const body = await request.json() as Record<string, unknown>;
  await run(
    env.DB,
    `INSERT INTO quick_submissions (id, user_id, agent_name, agency, book_title, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    [
      crypto.randomUUID(),
      session.user.id,
      clean(body.agent_name),
      clean(body.agency),
      clean(body.book_title),
      new Date().toISOString(),
    ]
  );
  return json({ ok: true });
}

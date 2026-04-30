import { requireSession } from "../lib/auth";
import { all, badRequest, json, run } from "../lib/db";

type Env = {
  DB: D1Database;
  FILES?: R2Bucket;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
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
  source_lanes?: string;
  source?: string;
  error?: string;
};

type RouteVerificationResult = {
  agent: AgentRecord | null;
  status: number;
  notes: string;
  closed: boolean;
};

const MAX_AGENT_POOL_RESULTS = 750;
const ENRICHMENT_BATCH_SIZE = 12;
const MAX_DISCOVERY_PASSES = 4;
const DISCOVERY_PROVIDER_TIMEOUT_MS = 65000;

const coreDiscoverySources = [
  "QueryTracker-style public search results",
  "Reedsy public agent directory pages",
  "agency websites and agency submission pages",
  "Manuscript Wish List and public agent profile pages",
  "agent interviews, podcast notes, and video guidance",
];

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

function cacheKey(body: Record<string, unknown>) {
  return ["v8", body.genre, body.subgenre, body.category].map((value) => clean(value).toLowerCase()).join("::");
}

function normalizedAgentKey(agent: AgentRecord) {
  return `${agent.agent_name}::${agent.agency}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
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

function fallbackAgentSourceUrl(agentName: string, agency: string) {
  const query = encodeURIComponent([agentName, agency, "literary agent submissions"].filter(Boolean).join(" "));
  return `https://www.google.com/search?q=${query}`;
}

function filterAgents(agents: AgentRecord[]) {
  return agents.filter((agent) => {
    if (!agent.agent_name || !agent.agency || !agent.genre_fit || !agent.requirements_summary) return false;
    if (!agent.matched_genre || !agent.matched_subgenre || !agent.genre_evidence || !agent.subgenre_evidence || !agent.fit_reason) return false;
    if (!["email", "querytracker", "querymanager", "form", "portal"].includes(agent.query_method)) return false;
    if (!["open", "selective", "closed"].includes(agent.open_status)) return false;
    if (agent.open_status === "closed") return false;
    if (!validUrl(agent.source_url)) return false;
    if (!agent.last_verified || Number.isNaN(Date.parse(agent.last_verified))) return false;
    if (Number(agent.confidence_score || 0) < 80) return false;
    if (!Array.isArray(agent.required_materials) || !agent.required_materials.includes("query_letter")) return false;
    if (agent.query_method === "email") return /\S+@\S+\.\S+/.test(agent.public_email || "");
    return validUrl(agent.submission_url);
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

function normalizeAgent(agent: AgentRecord): AgentRecord {
  const requirementText = [
    agent.requirements_summary,
    agent.verification_notes,
    agent.genre_evidence,
    agent.subgenre_evidence,
    agent.fit_reason,
  ].map(clean).join(" ");
  const inferredMaterials = inferRequiredMaterials(requirementText);
  return {
    ...agent,
    matched_genre: clean(agent.matched_genre),
    matched_subgenre: clean(agent.matched_subgenre),
    genre_evidence: clean(agent.genre_evidence),
    subgenre_evidence: clean(agent.subgenre_evidence),
    fit_reason: clean(agent.fit_reason),
    email_opener: clean(agent.email_opener),
    source_urls: Array.isArray(agent.source_urls) && agent.source_urls.length ? agent.source_urls : [agent.source_url],
    verification_notes: clean(agent.verification_notes),
    submission_route_verified: agent.submission_route_verified !== false,
    submission_route_verified_at: clean(agent.submission_route_verified_at),
    submission_route_status: Number(agent.submission_route_status || 0),
    submission_route_notes: clean(agent.submission_route_notes),
    required_materials: Array.from(new Set([
      "query_letter",
      ...inferredMaterials,
      ...(Array.isArray(agent.required_materials) ? agent.required_materials : []),
    ])),
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

function candidateToAgent(candidate: AgentCandidate): AgentRecord {
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
    query_method: candidate.query_method,
    submission_url: candidate.submission_url || "",
    public_email: candidate.public_email || "",
    requirements_summary: "Building Agent Intel...",
    required_materials: ["query_letter"],
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
  const combined = `${genre} ${subgenre}`.toLowerCase();
  const terms = [
    genre,
    subgenre,
    clean(body.category),
  ].filter(Boolean);
  if (/upmarket|women|woman|book club|rom-?com|romance|literary|commercial/.test(combined)) {
    terms.push("women's fiction", "book club fiction", "upmarket fiction", "literary fiction", "commercial fiction", "crossover fiction");
  }
  if (/fantasy|speculative|sci[- ]?fi|science fiction|horror|paranormal/.test(combined)) {
    terms.push("speculative fiction", "fantasy", "science fiction", "horror", "crossover fiction");
  }
  if (/thriller|mystery|crime|suspense|noir/.test(combined)) {
    terms.push("thriller", "mystery", "crime fiction", "suspense", "commercial fiction");
  }
  if (/memoir|narrative nonfiction|nonfiction|self-help|business|history|essay/.test(combined)) {
    terms.push("narrative nonfiction", "memoir", "nonfiction", "prescriptive nonfiction", "proposal-driven nonfiction");
  }
  return Array.from(new Set(terms.map((term) => term.toLowerCase()))).slice(0, 12);
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
  const exclusionText = alreadySeen.length
    ? `\nAvoid returning these already-seen agents unless there are no alternatives:\n${alreadySeen.map((agent) => `- ${agent}`).join("\n")}\nKeep searching deeper for different agents beyond this list.`
    : "";
  return `Find currently open literary agent submission candidates for this project.

Genre: ${clean(body.genre)}
Subgenre: ${clean(body.subgenre)}
Category: ${clean(body.category)}
Discovery focus: ${discoveryFocus || "broad genre/subgenre pool"}
Discovery lane: ${discoveryLane || "general"}
Preferred source lane: ${discoverySource || coreDiscoverySources.join(", ")}
Expanded genre boundaries: ${expandedTerms.join(", ")}

Return as many unique agents as you can for this specific focus, aiming for 40-75 useful records in this pass when the public sources support it. Do not stop after a handful of obvious names.
This is stage one only: discovery and live submission route candidates. Agent Intel will fill missing requirements later.
Include an agent when you can identify the agent name, agency, genre/subgenre fit, and either a specific submission route, public query email, or a reliable public source/profile page that can lead Agent Intel to the route.
Do not include closed agents. Do not include QueryTracker/QueryManager pages that say not open, temporarily closed, or not accepting queries.
Use current public web sources. Prefer the source lane above, then expand to ${coreDiscoverySources.join("; ")}.
Search beyond the obvious top results and keep going through directories/profile pages so we can build depth over time. Treat adjacent categories as valid when the evidence supports the user's project.
Do not write long explanations. Keep evidence to one short sentence per field.${exclusionText}

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

async function candidatesFromRaw(rawAgents: AgentCandidate[]) {
  const candidates = rawAgents.map(candidateToAgent);
  const filtered = candidates.filter((agent) => {
    if (!agent.agent_name || !agent.agency) return false;
    if (!["open", "selective"].includes(agent.open_status)) return false;
    if (Number(agent.confidence_score || 0) < 20) return false;
    if (agent.query_method === "email") return /\S+@\S+\.\S+/.test(agent.public_email || "");
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
    },
  };
}

async function generateAgentCandidates(env: Env, body: Record<string, unknown>) {
  if (!env.OPENAI_API_KEY) throw badRequest("Agent search is not configured yet. Missing OPENAI_API_KEY.", 503);
  const prompt = candidateDiscoveryPrompt(body);

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
            "query_method",
            "submission_url",
            "public_email",
            "open_status",
            "source_url",
            "source_urls",
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
            query_method: { type: "string", enum: ["email", "querytracker", "querymanager", "form", "portal"] },
            submission_url: { type: "string" },
            public_email: { type: "string" },
            open_status: { type: "string", enum: ["open", "selective"] },
            source_url: { type: "string" },
            source_urls: { type: "array", items: { type: "string" } },
            last_verified: { type: "string" },
            confidence_score: { type: "integer" },
          },
        },
      },
    },
  };

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
        model: clean(env.OPENAI_MODEL) || "gpt-5-mini",
        tools: [{ type: "web_search_preview" }],
        input: [
          {
            role: "system",
            content: "You discover currently open literary agent candidates and source-backed submission routes. Return JSON only. Do not include closed agents.",
          },
          { role: "user", content: prompt },
        ],
        max_output_tokens: 8000,
        text: {
          format: {
            type: "json_schema",
            name: "query_quick_agent_candidates",
            strict: true,
            schema,
          },
        },
      }),
    });
  } catch (error) {
    throw error;
  } finally {
    timeout.clear();
  }
  const data = await response.json() as { error?: { message?: string } };
  if (!response.ok) throw badRequest(data.error?.message || "Agent discovery failed.", response.status);
  const parsed = JSON.parse(extractResponseText(data)) as { agents?: AgentCandidate[] };
  const rawAgents = parsed.agents || [];
  return candidatesFromRaw(rawAgents);
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
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  if (!response.ok) throw badRequest(data.error?.message || "Gemini discovery failed.", response.status);
  const text = (data.candidates || [])
    .flatMap((candidate) => candidate.content?.parts || [])
    .map((part) => part.text || "")
    .join("\n");
  const parsed = JSON.parse(extractJsonText(text)) as { agents?: AgentCandidate[] };
  return candidatesFromRaw(parsed.agents || []);
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
  const parsed = JSON.parse(extractJsonText(text)) as { agents?: AgentCandidate[] };
  return candidatesFromRaw(parsed.agents || []);
}

function discoveryLanes(body: Record<string, unknown>): DiscoveryLane[] {
  const genre = clean(body.genre) || "this genre";
  const subgenre = clean(body.subgenre) || "this subgenre";
  const category = clean(body.category) || "this category";
  const expanded = genreExpansionTerms(body).join(", ");
  return [
    { id: "broad", source: "public web search across literary agent profiles and directories", focus: `broad current ${category} ${genre} literary agents accepting ${subgenre}; include adjacent fit terms: ${expanded}` },
    { id: "querytracker", source: "QueryTracker-style public search results and public query-status snippets", focus: `QueryTracker agents open to ${genre}, ${subgenre}, and adjacent subscriber-specific fit terms` },
    { id: "querymanager", source: "QueryManager public submission pages and agency links", focus: `QueryManager submission forms for literary agents accepting ${genre}, ${subgenre}, or adjacent terms` },
    { id: "mswl", source: "Manuscript Wish List and public agent wishlist/profile pages", focus: `Manuscript Wish List agents seeking ${genre}, ${subgenre}, and adjacent fit terms` },
    { id: "agency", source: "agency websites, staff pages, and submission guidelines", focus: `agency submission pages naming agents open to ${genre}, ${subgenre}, and adjacent fit terms` },
    { id: "newer-agents", source: "new agent announcements, agency staff pages, interviews, and public profiles", focus: `newer and associate literary agents building lists in ${genre}, ${subgenre}, or adjacent fit terms` },
    { id: "boutique", source: "boutique and independent agency websites", focus: `independent agencies and boutique agencies accepting ${genre}, ${subgenre}, or adjacent fit terms` },
    { id: "deep-directory", source: "deep public directory/profile search", focus: `deep directory pass for additional open ${genre}, ${subgenre}, and adjacent agents not already found` },
  ].slice(0, MAX_DISCOVERY_PASSES);
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
  const passResults = await Promise.allSettled(lanes.map((lane) => generateDiscoveryPass(env, {
    ...body,
    discovery_lane: lane.id,
    discovery_source: lane.source,
    discovery_focus: lane.focus,
    expanded_genres: genreExpansionTerms(body),
    exclude_agents: baseExcludeAgents.slice(0, 450),
  })));
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
  return {
    agents: verified,
    diagnostics: {
      raw_count: rawAgents.length,
      candidate_count: candidates.length,
      verified_count: verified.length,
    },
  };
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
  submission_route_verified: number;
  submission_route_verified_at: string;
  submission_route_status: number;
  submission_route_notes: string;
  last_verified: string;
  confidence_score: number;
}) {
  return normalizeAgent({
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
}

async function storedOpenAgentPool(env: Env, body: Record<string, unknown>) {
  const genre = clean(body.genre).toLowerCase();
  if (!genre) return [];
  const genreLike = `%${genre}%`;
  const rows = await all<Parameters<typeof rowToIntelAgent>[0]>(
    env.DB,
    `SELECT agent_name, agency, genre_fit, matched_genre, matched_subgenre, genre_evidence, subgenre_evidence,
            fit_reason, query_method, submission_url, public_email, requirements_summary, email_opener,
            open_status, source_url, source_urls_json, verification_notes, required_materials_json,
            submission_route_verified, submission_route_verified_at, submission_route_status,
            submission_route_notes, last_verified, confidence_score
     FROM quick_agents
     WHERE open_status IN ('open', 'selective')
       AND (
         lower(genre_fit) LIKE ?1 OR
         lower(matched_genre) LIKE ?1 OR
         lower(genre_evidence) LIKE ?1 OR
         lower(subgenre_evidence) LIKE ?1 OR
         lower(fit_reason) LIKE ?1
       )
     ORDER BY submission_route_verified DESC, last_seen_at DESC
     LIMIT 250`,
    [genreLike]
  );
  return rows.map(rowToIntelAgent);
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

export async function handleAgentSearch(request: Request, env: Env) {
  if (request.method !== "POST") return badRequest("Method not allowed.", 405);
  const session = await requireSession(request, env);
  const body = await request.json() as Record<string, unknown>;
  if (!clean(body.genre) || !clean(body.category)) return badRequest("Genre and category are required.");

  const key = cacheKey(body);
  const seenKeys = await userSeenAgentKeys(env, session.user.id);
  const sourceCandidates = sourceCandidateList(body);
  if (!sourceCandidates.length) return badRequest("At least one downloaded agent candidate is required for Agent Intel.", 400);
  const generated = await generateAgents(env, { ...body, candidates: sourceCandidates.slice(0, ENRICHMENT_BATCH_SIZE) });
  const agents = markSeenBefore(dedupeAgents(generated.agents), seenKeys);
  if (!agents.length) {
    await saveAgentResearch(env, session.user.id, key, body, agents);
    return json({ ok: true, cached: false, agents, diagnostics: generated.diagnostics });
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 7).toISOString();
  await run(
    env.DB,
    `INSERT OR REPLACE INTO quick_agent_cache (cache_key, genre, subgenre, category, agents_json, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    [key, clean(body.genre), clean(body.subgenre), clean(body.category), JSON.stringify(agents), now.toISOString(), expiresAt]
  );
  await saveAgentResearch(env, session.user.id, key, body, agents);
  return json({ ok: true, cached: false, agents, diagnostics: generated.diagnostics });
}

export async function handleAgentDiscover(request: Request, env: Env) {
  if (request.method !== "POST") return badRequest("Method not allowed.", 405);
  const session = await requireSession(request, env);
  const body = await request.json() as Record<string, unknown>;
  if (!clean(body.genre) || !clean(body.category)) return badRequest("Genre and category are required.");

  const key = cacheKey(body);
  const seenKeys = await userSeenAgentKeys(env, session.user.id);
  const storedAgents = body.include_stored_pool === false ? [] : await storedOpenAgentPool(env, body);
  let liveDiscovered: { agents: AgentRecord[]; diagnostics: AgentSearchDiagnostics };
  try {
    liveDiscovered = await generateLiveCandidatePool(env, body);
  } catch (error) {
    liveDiscovered = {
      agents: [],
      diagnostics: {
        raw_count: 0,
        candidate_count: 0,
        verified_count: 0,
        discovery_passes: 0,
        source_lanes: clean(body.discovery_lane),
        source: "live_discovery_failed",
        error: await errorMessage(error, "Live discovery failed before returning candidates."),
      },
    };
  }
  const discovered: { agents: AgentRecord[]; diagnostics: AgentSearchDiagnostics } = {
    agents: dedupeAgents([...storedAgents, ...liveDiscovered.agents]),
    diagnostics: {
      ...liveDiscovered.diagnostics,
      verified_count: dedupeAgents([...storedAgents, ...liveDiscovered.agents]).length,
      source: storedAgents.length ? "stored_plus_live_pool" : "live_full_pool",
    },
  };
  const agents = markSeenBefore(dedupeAgents(discovered.agents), seenKeys).map((agent) => ({
    ...agent,
    intel_pending: true,
    seen_before: agent.seen_before,
  }));
  await saveAgentResearch(env, session.user.id, key, body, agents);
  return json({ ok: true, cached: false, agents, diagnostics: discovered.diagnostics });
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

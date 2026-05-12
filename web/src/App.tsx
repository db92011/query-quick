import { useEffect, useMemo, useState } from "react";
import { Navigate, Route, Routes, useNavigate, useSearchParams } from "react-router-dom";
import { api, AuthProvider, type Session, uploadFile, useAuth } from "./lib";

type AgentRecord = {
  id?: string;
  agent_name: string;
  agency: string;
  genre_fit: string;
  matched_genre?: string;
  matched_subgenre?: string;
  genre_evidence?: string;
  subgenre_evidence?: string;
  fit_reason?: string;
  email_opener?: string;
  query_method: "email" | "querytracker" | "querymanager" | "form" | "portal";
  submission_url?: string;
  public_email?: string;
  requirements_summary: string;
  required_materials?: string[];
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

type Profile = {
  name: string;
  book_title: string;
  genre: string;
  subgenre: string;
  category: string;
  word_count: string;
};

type SubmissionKit = {
  manuscript_complete: boolean;
  data_paragraph: string;
  plot_paragraph: string;
  bio_paragraph: string;
  concise_description: string;
  publishing_history: string;
  synopsis: string;
  first_pages: string;
  sample_chapters: string;
  proposal: string;
  logline: string;
  short_pitch: string;
  comps: string;
  trigger_warnings: string;
  inspiration: string;
  more_about_you: string;
  prizes: string;
};

type SubmissionFileKey =
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
  | "prizes";

type PacketKey = SubmissionFileKey | "manuscript_status";
type WorkspaceView = "kit" | "search" | "profile" | "saved";
type SubmissionFiles = Record<SubmissionFileKey, string>;
type QueriedAgentStatus = "sent" | "full_manuscript_requested" | "denied" | "no_response" | "closed";
type QueriedAgentRecord = {
  id: string;
  agent_name: string;
  agency: string;
  book_title: string;
  sent_at: string;
  method: string;
  route: string;
  materials: string[];
  status: QueriedAgentStatus;
  denied_reason: string;
  follow_up_notes: string;
};

const emptyProfile: Profile = {
  name: "",
  book_title: "",
  genre: "upmarket fiction",
  subgenre: "book club / women's fiction / rom-com adjacent",
  category: "adult fiction",
  word_count: "",
};

const emptySubmissionKit: SubmissionKit = {
  manuscript_complete: false,
  data_paragraph: "",
  plot_paragraph: "",
  bio_paragraph: "",
  concise_description: "",
  publishing_history: "",
  synopsis: "",
  first_pages: "",
  sample_chapters: "",
  proposal: "",
  logline: "",
  short_pitch: "",
  comps: "",
  trigger_warnings: "",
  inspiration: "",
  more_about_you: "",
  prizes: "",
};

const emptySubmissionFiles: SubmissionFiles = {
  query_letter: "",
  concise_description: "",
  synopsis: "",
  first_pages: "",
  sample_chapters: "",
  proposal: "",
  logline: "",
  short_pitch: "",
  bio_paragraph: "",
  publishing_history: "",
  comps: "",
  trigger_warnings: "",
  inspiration: "",
  more_about_you: "",
  prizes: "",
};

const materialLabels: Record<string, string> = {
  query_letter: "Query letter",
  concise_description: "Concise description",
  synopsis: "Synopsis",
  first_pages: "First pages",
  sample_chapters: "Sample chapters",
  proposal: "Nonfiction proposal",
  logline: "Logline",
  short_pitch: "Short pitch",
  bio_paragraph: "Bio paragraph",
  publishing_history: "Publishing history",
  comps: "Comps",
  trigger_warnings: "Trigger warnings",
  inspiration: "Why this story",
  more_about_you: "About you",
  prizes: "Writing prizes",
  manuscript_status: "Manuscript status",
};

const packetOrder: PacketKey[] = [
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
  "manuscript_status",
];

const maxConcurrentIntel = 2;
const targetAgentPoolSize = 337;

const agentSearchActivity = [
  "Opening public agent records.",
  "Checking live submission paths.",
  "Scanning agency profile pages.",
  "Matching your genre criteria.",
  "Matching your subgenre language.",
  "Checking Manuscript Wish List.",
  "Reviewing wishlist signals.",
  "Checking QueryTracker routes.",
  "Checking QueryManager routes.",
  "Checking public email signals.",
  "Looking for agent interviews.",
  "Checking podcast guidance.",
  "Checking video guidance.",
  "Removing closed records.",
  "Removing stale records.",
  "Downloading source-backed agent rows.",
  "Preparing Intel-ready results.",
];

type DiscoveryLane = {
  id: string;
  source: string;
  focus: string;
};

type AgentSearchDiagnostics = {
  raw_count?: number;
  candidate_count?: number;
  verified_count?: number;
  search_result_count?: number;
  search_context_used?: boolean;
  discovery_passes?: number;
  source_lanes?: string;
  source?: string;
  error?: string;
};

function genreExpansionTerms(profile: Profile) {
  const genre = profile.genre.trim() || "this genre";
  const subgenre = profile.subgenre.trim() || "this subgenre";
  const category = profile.category.trim() || "this category";
  const combined = `${genre} ${subgenre}`.toLowerCase();
  const terms = [genre, subgenre, category];
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

function discoveryLanes(profile: Profile): DiscoveryLane[] {
  const genre = profile.genre.trim() || "this genre";
  const subgenre = profile.subgenre.trim() || "this subgenre";
  const category = profile.category.trim() || "this category";
  const expanded = genreExpansionTerms(profile).join(", ");
  return [
    { id: "broad", source: "public web search across literary agent profiles and directories", focus: `broad current ${category} ${genre} literary agents accepting ${subgenre}; include adjacent fit terms: ${expanded}` },
    { id: "querytracker", source: "QueryTracker-style public search results and public query-status snippets", focus: `QueryTracker agents open to ${genre}, ${subgenre}, and adjacent subscriber-specific fit terms` },
    { id: "querymanager", source: "QueryManager public submission pages and agency links", focus: `QueryManager submission forms for literary agents accepting ${genre}, ${subgenre}, or adjacent terms` },
    { id: "mswl", source: "Manuscript Wish List and public agent wishlist/profile pages", focus: `Manuscript Wish List agents seeking ${genre}, ${subgenre}, and adjacent fit terms` },
    { id: "agency", source: "agency websites, staff pages, and submission guidelines", focus: `agency submission pages naming agents open to ${genre}, ${subgenre}, and adjacent fit terms` },
    { id: "newer-agents", source: "new agent announcements, agency staff pages, interviews, and public profiles", focus: `newer and associate literary agents building lists in ${genre}, ${subgenre}, or adjacent fit terms` },
    { id: "boutique", source: "boutique and independent agency websites", focus: `independent agencies and boutique agencies accepting ${genre}, ${subgenre}, or adjacent fit terms` },
    { id: "deep-directory", source: "deep public directory/profile search", focus: `deep directory pass for additional open ${genre}, ${subgenre}, and adjacent agents not already found` },
    { id: "google", source: "Google Programmable Search source snippets", focus: `Google search pass for additional ${category} ${genre} literary agents accepting ${subgenre}; prioritize profile, guideline, and directory pages not already found` },
    { id: "bing", source: "Bing Web Search source snippets", focus: `Bing search pass for additional ${category} ${genre} literary agents accepting ${subgenre}; prioritize profile, guideline, and directory pages not already found` },
  ];
}

function mergeAgentPools(current: AgentRecord[], incoming: AgentRecord[]) {
  const seen = new Set<string>();
  return [...current, ...incoming].filter((agent) => {
    const key = `${agent.agent_name}::${agent.agency}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function discoveryProgressText(total: number, lane: DiscoveryLane, diagnostics?: AgentSearchDiagnostics) {
  const raw = diagnostics?.raw_count || 0;
  const candidates = diagnostics?.candidate_count || 0;
  const accepted = diagnostics?.verified_count || 0;
  const snippets = diagnostics?.search_result_count || 0;
  if (diagnostics?.error) {
    return `${total} agents showing. ${lane.id} live discovery is blocked: ${diagnostics.error}`;
  }
  if (raw || candidates || accepted) {
    const sourceText = snippets ? ` using ${snippets} search-engine leads` : "";
    return `${total} agents showing. ${lane.id} found ${raw} raw${sourceText}, kept ${candidates}, added ${accepted}. Continuing source checks...`;
  }
  return `${total} agents showing. ${lane.id} did not return usable names yet; checking the next source.`;
}

function countWords(value: string) {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function wordCountText(value: string, max?: number) {
  const count = countWords(value);
  return max ? `${count} / ${max} words` : `${count} words`;
}

function cleanEvidenceText(value: string) {
  return value
    .replace(/\s*\((https?:\/\/[^)]+)\)/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function validPacketKey(value: string): value is PacketKey {
  return packetOrder.includes(value as PacketKey);
}

function Header({ workspace = false }: { workspace?: boolean }) {
  const { session, logout } = useAuth();
  const navigate = useNavigate();

  async function startCheckout() {
    const response = await api<{ url: string }>("/api/billing/checkout", { method: "POST" });
    window.location.href = response.url;
  }

  async function openBilling() {
    if (!session) return;
    const response = await api<{ url: string }>("/api/billing/portal", { method: "POST" }, session.token);
    window.location.href = response.url;
  }

  return (
    <header className="topbar">
      <button className="brand" type="button" onClick={() => navigate("/")}>Query Quick</button>
      <nav className="topbar-actions">
        {workspace && session ? (
          <>
            <button className="text-button" type="button" onClick={openBilling}>Manage Billing</button>
            <button className="secondary-button" type="button" onClick={logout}>Sign out</button>
          </>
        ) : (
          <>
            <button className="text-button" type="button" onClick={() => navigate("/quick")}>Login</button>
            <button className="primary-button" type="button" onClick={startCheckout}>Get Started</button>
          </>
        )}
      </nav>
    </header>
  );
}

function Home() {
  const [waitlistEmail, setWaitlistEmail] = useState("");
  const [waitlistError, setWaitlistError] = useState("");
  const [checkoutError, setCheckoutError] = useState("");
  const [showHow, setShowHow] = useState(false);
  const [showWaitlistThanks, setShowWaitlistThanks] = useState(false);

  async function checkout() {
    setCheckoutError("");
    try {
      const response = await api<{ url: string }>("/api/billing/checkout", { method: "POST" });
      window.location.href = response.url;
    } catch (error) {
      setCheckoutError(error instanceof Error ? error.message : "Could not open checkout.");
    }
  }

  useEffect(() => {
    if (!showHow && !showWaitlistThanks) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setShowHow(false);
        setShowWaitlistThanks(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showHow, showWaitlistThanks]);

  async function joinWaitlist(event: React.FormEvent) {
    event.preventDefault();
    if (!waitlistEmail.trim()) return;
    setWaitlistError("");
    try {
      await api("/api/waitlist", {
        method: "POST",
        body: JSON.stringify({ email: waitlistEmail, product: "query_salon_pro" }),
      });
      setWaitlistEmail("");
      setShowWaitlistThanks(true);
    } catch (error) {
      setWaitlistError(error instanceof Error ? error.message : "Could not join the waitlist.");
    }
  }

  return (
    <main>
      <Header />
      <section className="hero">
        <h1>Find agents. Send queries. Done in minutes.</h1>
        <p className="hero-copy">
          Querying is a slog. An hour on a single agent - researching guidelines, status, and fit. Thats the old way. We do it differently.
          We match every relevant agent to your genre and criteria in minutes - using a live, up-to-date list you can act on immediately.
        </p>
        <div className="hero-actions">
          <button className="primary-button large" type="button" onClick={checkout}>Start Query Quick - $9.95/mo</button>
          <button className="secondary-button large" type="button" onClick={() => setShowHow(true)}>See how it works</button>
        </div>
        {checkoutError ? <p className="status-line">{checkoutError}</p> : null}
        <p className="fine-print">Payments are handled by Stripe.<br />We only store what's required to keep your account working.</p>
      </section>

      <section className="value-strip" id="how" aria-label="Query Quick benefits">
        <div>Stop triangulating agent requirements the old way.</div>
        <div>Keep all of your documents together in one location.</div>
        <div>Accurately query several agents in minutes instead of hours.</div>
      </section>

      <section className="pro-band">
        <div>
          <p className="kicker">Future workspace</p>
          <h2>Query Salon Pro</h2>
          <p>Coming soon.</p>
        </div>
        <form className="waitlist-form" onSubmit={joinWaitlist}>
          <input
            aria-label="Email for Query Salon Pro waitlist"
            value={waitlistEmail}
            onChange={(event) => setWaitlistEmail(event.target.value)}
            placeholder="Email address"
            type="email"
          />
          <button className="secondary-button" type="submit">Join waitlist</button>
          {waitlistError ? <span>{waitlistError}</span> : null}
        </form>
      </section>

      <footer className="public-footer">
        <p>
          Along with this amazing new tool, we recommend you having a Query Tracker subscription.
          Together both tools ensure your success. Happy Querying!
        </p>
        <a href="https://circlethepeople.com" target="_blank" rel="noreferrer">
          Created by Circle the People - tools built for clarity, not noise.
        </a>
      </footer>

      {showHow ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowHow(false)}>
          <section
            className="how-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="how-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button className="modal-close" type="button" aria-label="Close" onClick={() => setShowHow(false)}>Close</button>
            <p className="kicker">How Query Quick works</p>
            <h2 id="how-title">Build your kit. Find the right agents. Keep moving.</h2>
            <div className="how-steps">
              <article>
                <span className="step-badge">1</span>
                <h3>Build your submission kit.</h3>
                <p>In your writer portal, add your book details and paste or upload the materials agents ask for: query letter, synopsis, first pages, logline, pitch, comps, trigger warnings, bio details, inspiration, and prizes.</p>
              </article>
              <article>
                <span className="step-badge">2</span>
                <h3>Query Quick system does a deep search.</h3>
                <p>Query Quick looks for source-backed matches and shows genre fit, subgenre evidence, submission method, requirements, source links, and open-status language.</p>
              </article>
              <article>
                <span className="step-badge">3</span>
                <h3>Submit immediately in one click.</h3>
                <p>That&apos;s it!</p>
              </article>
              <article className="outcome-card">
                <span className="step-badge">4</span>
                <h3>Keep your query moving.</h3>
                <p>Track who you sent to, what method you used, and what happened next - without rebuilding your list every time you sit down to query.</p>
              </article>
            </div>
            <p className="modal-note">Hours of research—now reduced to a single click.</p>
            <div className="modal-actions">
              <button className="primary-button" type="button" onClick={checkout}>Start Query Quick - $9.95/mo</button>
            </div>
          </section>
        </div>
      ) : null}

      {showWaitlistThanks ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowWaitlistThanks(false)}>
          <section
            className="thanks-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="waitlist-thanks-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button className="modal-close" type="button" aria-label="Close" onClick={() => setShowWaitlistThanks(false)}>Close</button>
            <p className="kicker">Query Salon Pro</p>
            <h2 id="waitlist-thanks-title">You’re on the waitlist.</h2>
            <p>Thank you for joining. We’ll notify you when Query Salon Pro is ready and the next exciting event happens.</p>
            <button className="primary-button" type="button" onClick={() => setShowWaitlistThanks(false)}>Got it</button>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function VerifyMagicLink() {
  const [params] = useSearchParams();
  const { setSession } = useAuth();
  const navigate = useNavigate();
  const [message, setMessage] = useState("Signing you in...");

  useEffect(() => {
    const token = params.get("token") || "";
    if (!token) {
      setMessage("This sign-in link is missing a token.");
      return;
    }
    api<{ session: Session }>("/api/auth/magic/verify", {
      method: "POST",
      body: JSON.stringify({ token }),
    })
      .then((response) => {
        setSession(response.session);
        navigate("/quick", { replace: true });
      })
      .catch((error) => setMessage(error.message || "This sign-in link could not be used."));
  }, [navigate, params, setSession]);

  return (
    <main>
      <Header />
      <section className="auth-panel">
        <h1>{message}</h1>
      </section>
    </main>
  );
}

function SubscribeInstructions() {
  return (
    <main>
      <Header />
      <section className="auth-panel">
        <p className="kicker">Subscription received</p>
        <h1>Check your email for your Query Quick magic link.</h1>
        <p className="auth-copy">
          Your sign-in link opens your writer workspace and stays live for six hours.
          After that, enter your email again and we’ll send a fresh link.
        </p>
        <a className="primary-button auth-action" href="/quick">Open login</a>
      </section>
    </main>
  );
}

function LoginGate() {
  const { session, setSession } = useAuth();
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("");
  const [devLink, setDevLink] = useState("");
  const checkoutSuccess = params.get("checkout") === "success";

  if (session) return <Workspace />;

  async function requestMagicLink(event: React.FormEvent) {
    event.preventDefault();
    setStatus("Sending sign-in link...");
    setDevLink("");
    try {
      const response = await api<{ ok: boolean; dev_magic_link?: string }>("/api/auth/magic/request", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setStatus("Check your email for the sign-in link. It will stay live for six hours.");
      if (response.dev_magic_link) setDevLink(response.dev_magic_link);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not send sign-in link.");
    }
  }

  return (
    <main>
      <Header workspace />
      <section className="auth-panel">
        <p className="kicker">{checkoutSuccess ? "Subscription received" : "Magic link login"}</p>
        <h1>{checkoutSuccess ? "Check your email for your Query Quick magic link." : "Open your Query Quick workspace."}</h1>
        <p className="auth-copy">
          Magic links stay live for six hours. After that, enter your email here and we’ll send another one.
        </p>
        <form className="login-form" onSubmit={requestMagicLink}>
          <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" type="email" />
          <button className="primary-button" type="submit">Send login link</button>
        </form>
        {status ? <p className="status-line">{status}</p> : null}
        {devLink ? (
          <button
            className="text-button dev-link"
            type="button"
            onClick={async () => {
              const token = new URL(devLink).searchParams.get("token") || "";
              const response = await api<{ session: Session }>("/api/auth/magic/verify", {
                method: "POST",
                body: JSON.stringify({ token }),
              });
              setSession(response.session);
            }}
          >
            Use local dev link
          </button>
        ) : null}
      </section>
    </main>
  );
}

function Workspace() {
  const { session, logout } = useAuth();
  const [activeView, setActiveView] = useState<WorkspaceView>("kit");
  const [profile, setProfile] = useState<Profile>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem("query-quick.profile") || "{}") as Partial<Profile>;
      return {
        ...emptyProfile,
        ...stored,
        genre: typeof stored.genre === "string" ? stored.genre : emptyProfile.genre,
        subgenre: typeof stored.subgenre === "string" ? stored.subgenre : emptyProfile.subgenre,
        category: typeof stored.category === "string" ? stored.category : emptyProfile.category,
      };
    } catch {
      return emptyProfile;
    }
  });
  const [submissionKit, setSubmissionKit] = useState<SubmissionKit>(() => {
    try {
      return { ...emptySubmissionKit, ...JSON.parse(localStorage.getItem("query-quick.submission-kit") || "{}") };
    } catch {
      return emptySubmissionKit;
    }
  });
  const [submissionFiles, setSubmissionFiles] = useState<SubmissionFiles>(() => {
    try {
      return { ...emptySubmissionFiles, ...JSON.parse(localStorage.getItem("query-quick.submission-files") || "{}") };
    } catch {
      return emptySubmissionFiles;
    }
  });
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [queriedAgents, setQueriedAgents] = useState<QueriedAgentRecord[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("query-quick.queried-agents") || "[]") as QueriedAgentRecord[];
    } catch {
      return [];
    }
  });
  const [sentCount, setSentCount] = useState(() => Number(localStorage.getItem("query-quick.sent") || "0"));
  const [status, setStatus] = useState("Ready.");
  const [isSearching, setIsSearching] = useState(false);
  const [intelLoadingKeys, setIntelLoadingKeys] = useState<string[]>([]);
  const [activityIndex, setActivityIndex] = useState(0);
  const [kitSaved, setKitSaved] = useState(() => localStorage.getItem("query-quick.kit-saved") === "true");
  const [intelAgent, setIntelAgent] = useState<AgentRecord | null>(null);
  const [showCopySpecific, setShowCopySpecific] = useState(false);
  const [specificMaterials, setSpecificMaterials] = useState<PacketKey[]>([]);
  const searchCriteria = [
    { label: "Genre", value: profile.genre.trim() },
    { label: "Subgenre", value: profile.subgenre.trim() },
    { label: "Category", value: profile.category.trim() },
  ];
  const missingSearchCriteria = searchCriteria.filter((item) => !item.value).map((item) => item.label.toLowerCase());
  const canSearch = missingSearchCriteria.length === 0;

  useEffect(() => {
    localStorage.setItem("query-quick.profile", JSON.stringify(profile));
  }, [profile]);

  useEffect(() => {
    localStorage.setItem("query-quick.submission-kit", JSON.stringify(submissionKit));
  }, [submissionKit]);

  useEffect(() => {
    localStorage.setItem("query-quick.submission-files", JSON.stringify(submissionFiles));
  }, [submissionFiles]);

  useEffect(() => {
    localStorage.setItem("query-quick.kit-saved", String(kitSaved));
  }, [kitSaved]);

  useEffect(() => {
    localStorage.setItem("query-quick.queried-agents", JSON.stringify(queriedAgents));
  }, [queriedAgents]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    api<{ profile: Partial<Profile> | null }>("/api/profile", undefined, session.token)
      .then((response) => {
        if (cancelled || !response.profile) return;
        setProfile((current) => {
          const hasLocalProfile = Boolean(current.genre.trim() || current.subgenre.trim() || current.category.trim() || current.book_title.trim());
          return hasLocalProfile ? current : { ...emptyProfile, ...response.profile };
        });
      })
      .catch(() => {
        // Local profile storage remains usable if the saved server profile cannot be loaded.
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  useEffect(() => {
    if (!isSearching) return;
    setActivityIndex(0);
    const timer = window.setInterval(() => {
      setActivityIndex((current) => {
        if (current >= agentSearchActivity.length) return current;
        return current + 1;
      });
    }, 500);
    return () => window.clearInterval(timer);
  }, [isSearching]);

  function updateProfile(key: keyof Profile, value: string) {
    setProfile((current) => ({ ...current, [key]: value }));
  }

  async function saveProfile() {
    localStorage.setItem("query-quick.profile", JSON.stringify(profile));
    if (!session) {
      setStatus("Profile saved locally. Sign in to save it to Query Quick.");
      setActiveView("search");
      return;
    }
    try {
      await api("/api/profile", {
        method: "POST",
        body: JSON.stringify(profile),
      }, session.token);
      setStatus("Profile saved. Ready to search.");
      setActiveView("search");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Profile saved locally, but could not sync to Query Quick.");
      setActiveView("search");
    }
  }

  function updateSubmissionKit(key: keyof SubmissionKit, value: string | boolean) {
    setKitSaved(false);
    setSubmissionKit((current) => ({ ...current, [key]: value }));
  }

  async function updateSubmissionFile(key: SubmissionFileKey, fileList: FileList | null) {
    const file = fileList?.[0];
    if (!file) return;
    setStatus(`Uploading ${file.name}...`);
    try {
      if (session) {
        const formData = new FormData();
        formData.set("kind", key);
        formData.set("file", file);
        await uploadFile("/api/submission-kit/file", formData, session.token);
      }
      setKitSaved(false);
      setSubmissionFiles((current) => ({ ...current, [key]: file.name }));
      setStatus(`Uploaded ${file.name}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not upload file.");
    }
  }

  function buildQuery(agent: AgentRecord) {
    const body = buildEmailBody(agent);
    return `Subject: ${emailSubject(agent)}

${body}`;
  }

  function emailSubject(agent: AgentRecord) {
    return `Query - ${profile.book_title || "your project"} - ${profile.genre}${agent.agent_name ? ` for ${agent.agent_name}` : ""}`;
  }

  function buildPersonalizedOpener(agent: AgentRecord) {
    if (agent.email_opener?.trim()) {
      return cleanEvidenceText(agent.email_opener);
    }
    const matchParts = [
      agent.matched_genre || agent.genre_fit,
      agent.matched_subgenre || profile.subgenre,
    ].filter(Boolean).join(" and ");
    const wishlist = cleanEvidenceText(agent.subgenre_evidence || agent.genre_evidence || agent.fit_reason || "");
    const bookTitle = profile.book_title?.trim() || "my project";
    const projectShape = [profile.genre, profile.subgenre].filter(Boolean).join(" / ");
    return [
      `I’m reaching out because your public wishlist and submission guidance point directly toward ${matchParts || projectShape}.`,
      wishlist ? `What stood out to me is ${wishlist.charAt(0).toLowerCase()}${wishlist.slice(1)}` : "",
      `I’m hoping to find representation from someone who understands both the creative promise of a book and the business of bringing it to the right readers, and ${bookTitle} feels closely aligned with the kind of work you’ve said you want to see.`,
    ].filter(Boolean).join(" ");
  }

  function requiredPacketKeys(agent: AgentRecord) {
    const keys = (agent.required_materials || []).filter(validPacketKey);
    const unique = Array.from(new Set<PacketKey>(["query_letter", ...keys]));
    return packetOrder.filter((key) => unique.includes(key));
  }

  function validHttpUrl(value?: string) {
    if (!value) return false;
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }

  function canOpenSubmissionRoute(agent: AgentRecord) {
    return (agent.query_method === "email" && Boolean(agent.public_email)) || (validHttpUrl(agent.submission_url) && agent.submission_route_verified !== false);
  }

  function agentKey(agent: AgentRecord) {
    return `${agent.agent_name}-${agent.agency}`;
  }

  function agentReadyForSubmission(agent: AgentRecord) {
    if (agent.intel_pending) return false;
    const hasMappedMaterials = Array.isArray(agent.required_materials) && agent.required_materials.length > 0;
    const summaryText = agent.requirements_summary?.toLowerCase() || "";
    const hasUsableSummary = Boolean(agent.requirements_summary && !summaryText.includes("indexing") && !summaryText.includes("building agent intel"));
    return hasMappedMaterials && hasUsableSummary && canOpenSubmissionRoute(agent);
  }

  function agentNeedsIntel(agent: AgentRecord) {
    return agent.intel_pending || !agentReadyForSubmission(agent);
  }

  function submissionRouteLabel(agent: AgentRecord) {
    const routeUrl = agent.query_method === "email" ? agent.source_url || "" : agent.submission_url || "";
    if (agent.query_method === "email") return "Email per agent guidelines";
    if (agent.query_method === "querytracker" || routeUrl.includes("querytracker.net")) return "QueryTracker submission page";
    if (agent.query_method === "querymanager") return "QueryManager page";
    if (agent.query_method === "form") return "Personal website submission form";
    return "Agent submission portal";
  }

  function routeActionLabel(agent: AgentRecord) {
    if (agent.query_method === "querytracker" || (agent.submission_url || "").includes("querytracker.net")) return "Open QueryTracker";
    if (agent.query_method === "querymanager") return "Open QueryManager";
    if (agent.query_method === "form") return "Open Website Form";
    return "Open Portal";
  }

  function routeActionWithKitLabel(agent: AgentRecord) {
    if (agent.query_method === "querytracker" || (agent.submission_url || "").includes("querytracker.net")) return "Open QueryTracker + Copy Kit";
    if (agent.query_method === "querymanager") return "Open QueryManager + Copy Kit";
    if (agent.query_method === "form") return "Open Website Form + Copy Kit";
    return "Open Portal + Copy Kit";
  }

  function verifiedRouteText(agent: AgentRecord) {
    if (agent.submission_route_verified === false) return "Source-backed route. Open before sending.";
    if (!agent.submission_route_verified_at) return "Submission route verified.";
    return `Submission route verified ${new Date(agent.submission_route_verified_at).toLocaleDateString()}.`;
  }

  async function copyRequiredKit(agent: AgentRecord) {
    return copyPacket(requiredPacketKeys(agent));
  }

  function buildEmailBody(agent: AgentRecord) {
    const requiredKeys = requiredPacketKeys(agent);
    const packetSections = requiredKeys.map(formatPacketMaterial).filter(Boolean);
    const extraKeys = requiredKeys.filter((key) => key !== "query_letter");
    const materialList = requiredKeys.map((key) => materialLabels[key] || key);
    const includedLine = materialList.length
      ? `Based on your guidelines, I’ve included ${formatReadableList(materialList)} below.`
      : "";
    const extraLine = extraKeys.length
      ? "I separated each requested item by heading so the materials are easy to review."
      : "";
    const packetBlock = packetSections.length ? `\n\n${packetSections.join("\n\n")}` : "";

    return `Dear ${agent.agent_name},

${buildPersonalizedOpener(agent)}

${includedLine}
${extraLine ? `\n${extraLine}` : ""}
${packetBlock}

Best,
${profile.name || ""}`;
  }

  function formatReadableList(items: string[]) {
    if (items.length <= 1) return items[0] || "";
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
  }

  function getPacketMaterialText(key: PacketKey) {
    if (key === "manuscript_status") {
      return submissionKit.manuscript_complete ? "Complete manuscript: Yes" : "";
    }
    if (key === "query_letter") {
      return "";
    }
    return String(submissionKit[key] || "").trim();
  }

  function getPacketMaterialFile(key: PacketKey) {
    if (key === "manuscript_status") return "";
    return submissionFiles[key] || "";
  }

  function formatPacketMaterial(key: PacketKey) {
    const title = materialLabels[key] || key;
    const text = getPacketMaterialText(key);
    const fileName = getPacketMaterialFile(key);
    const body = [
      text,
      fileName ? `[Uploaded file: ${fileName}]` : "",
      !text && !fileName && key === "query_letter" ? "[Query letter from Submission Kit]" : "",
    ].filter(Boolean).join("\n");
    if (!body) return "";
    return `${title}\n${"-".repeat(title.length)}\n${body}`;
  }

  async function copyPacketMaterial(key: PacketKey) {
    const material = formatPacketMaterial(key);
    if (!material) {
      setStatus(`${materialLabels[key]} is empty.`);
      return;
    }
    await navigator.clipboard.writeText(material);
    setStatus(`Copied ${materialLabels[key]}.`);
  }

  async function copyPacket(keys: PacketKey[]) {
    const packet = packetOrder
      .filter((key) => keys.includes(key))
      .map(formatPacketMaterial)
      .filter(Boolean)
      .join("\n\n");
    if (!packet) {
      setStatus("Nothing chosen has content yet.");
      return false;
    }
    await navigator.clipboard.writeText(packet);
    setStatus("Copied submission packet.");
    return true;
  }

  function availableSpecificMaterials() {
    return packetOrder.filter((key) => formatPacketMaterial(key));
  }

  function openCopySpecific() {
    const available = availableSpecificMaterials();
    setSpecificMaterials(available);
    setShowCopySpecific(true);
  }

  function toggleSpecificMaterial(value: PacketKey) {
    setSpecificMaterials((current) => (
      current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value]
    ));
  }

  async function copySpecificMaterials() {
    const copied = await copyPacket(specificMaterials);
    if (copied) setShowCopySpecific(false);
  }

  async function findAgents() {
    if (!session) return;
    if (!canSearch) {
      setStatus(`Add ${missingSearchCriteria.join(", ")} in Your Profile before searching.`);
      return;
    }
    setIsSearching(true);
    setStatus(agents.length
      ? `Expanding from ${agents.length} saved agents toward ${targetAgentPoolSize}.`
      : "Starting live agent discovery...");
    const lanes = discoveryLanes(profile);
    let downloaded: AgentRecord[] = agents;
    let successfulPasses = 0;
    let emptyLanes = 0;
    let lastDiscoveryError = "";
    try {
      for (const [index, lane] of lanes.entries()) {
        setStatus(`Searching ${lane.id} lane ${index + 1}/${lanes.length}. ${downloaded.length} agents showing so far.`);
        try {
          const discovered = await api<{
            agents: AgentRecord[];
            cached?: boolean;
            diagnostics?: AgentSearchDiagnostics;
          }>("/api/agents/discover", {
            method: "POST",
            body: JSON.stringify({
              ...profile,
              discovery_lane: lane.id,
              discovery_source: lane.source,
              discovery_focus: lane.focus,
              expanded_genres: genreExpansionTerms(profile),
              include_stored_pool: index === 0 || downloaded.length < targetAgentPoolSize,
              exclude_agents: downloaded.map((agent) => `${agent.agent_name} — ${agent.agency}`),
            }),
          }, session.token);
          successfulPasses += 1;
          if (discovered.diagnostics?.error) lastDiscoveryError = discovered.diagnostics.error;
          const beforeCount = downloaded.length;
          downloaded = mergeAgentPools(downloaded, discovered.agents);
          emptyLanes = downloaded.length === beforeCount ? emptyLanes + 1 : 0;
          setAgents(downloaded);
          setStatus(discoveryProgressText(downloaded.length, lane, discovered.diagnostics));
          if (downloaded.length >= targetAgentPoolSize) {
            setStatus(`${downloaded.length} agents found. Target pool is ready; run Agent Intel two at a time.`);
            break;
          }
          if (emptyLanes >= 4) setStatus(`${downloaded.length} agents showing. Still below ${targetAgentPoolSize}; checking deeper sources.`);
        } catch (error) {
          const reason = error instanceof Error ? error.message : "One source did not respond";
          setStatus(`${downloaded.length} agents showing. ${lane.id} needs another pass: ${reason}`);
        }
      }
      setStatus(downloaded.length
        ? `${downloaded.length} agents found. ${downloaded.length < targetAgentPoolSize ? "Search again to keep expanding the pool." : "Run Agent Intel two at a time when you are ready to prepare submissions."}`
        : lastDiscoveryError
          ? `Live discovery is blocked: ${lastDiscoveryError}`
          : "No matching agents came back yet. Try again in a moment.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Still checking live sources. Try again in a moment to pull in more agents.");
    } finally {
      setIsSearching(false);
    }
  }

  async function runAgentIntel(agent: AgentRecord) {
    if (!session) return;
    const key = agentKey(agent);
    if (intelLoadingKeys.includes(key)) return;
    if (intelLoadingKeys.length >= maxConcurrentIntel) {
      setStatus("Run Agent Intel two at a time so the search stays accurate and responsive.");
      return;
    }
    setIntelLoadingKeys((current) => current.includes(key) ? current : [...current, key].slice(0, maxConcurrentIntel));
    setStatus(`Building Agent Intel for ${agent.agent_name}...`);
    try {
      const response = await api<{
        agents: AgentRecord[];
        cached?: boolean;
        diagnostics?: { raw_count: number; candidate_count: number; verified_count: number };
      }>("/api/agents/search", {
        method: "POST",
        body: JSON.stringify({ ...profile, candidates: [agent] }),
      }, session.token);
      const enriched = response.agents[0] || agent;
      setAgents((current) => current.map((item) => (
        item.agent_name === agent.agent_name && item.agency === agent.agency ? enriched : item
      )));
      setIntelAgent(enriched);
      setStatus(agentReadyForSubmission(enriched)
        ? `Agent Intel ready for ${enriched.agent_name}.`
        : `Agent Intel updated for ${enriched.agent_name}. Review sources before sending.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `Could not build Agent Intel for ${agent.agent_name}.`);
    } finally {
      setIntelLoadingKeys((current) => current.filter((item) => item !== key));
    }
  }

  function emailAgent(agent: AgentRecord) {
    const subject = encodeURIComponent(emailSubject(agent));
    const body = encodeURIComponent(buildEmailBody(agent));
    window.location.href = `mailto:${agent.public_email}?subject=${subject}&body=${body}`;
  }

  async function openSubmissionWithKit(agent: AgentRecord) {
    const route = agent.submission_url || "";
    if (!validHttpUrl(route) || agent.submission_route_verified === false) {
      setStatus(`No verified live submission route is available for ${agent.agent_name}.`);
      return;
    }
    const target = window.open("about:blank", "_blank");
    const copied = await copyRequiredKit(agent);
    if (target) {
      target.opener = null;
      target.location.href = route;
    } else {
      window.location.href = route;
    }
    setStatus(copied
      ? `Opened ${submissionRouteLabel(agent)} and copied the required kit for ${agent.agent_name}.`
      : `Opened ${submissionRouteLabel(agent)}. Add kit content before pasting.`);
  }

  function markSent(agent: AgentRecord) {
    const id = `${agent.agent_name}-${agent.agency}-${profile.book_title || "untitled"}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const alreadySaved = queriedAgents.some((record) => record.id === id);
    const next = alreadySaved ? sentCount : sentCount + 1;
    setSentCount(next);
    localStorage.setItem("query-quick.sent", String(next));
    const materials = requiredPacketKeys(agent).map((key) => materialLabels[key] || key);
    setQueriedAgents((current) => {
      const existing = current.find((record) => record.id === id);
      const nextRecord: QueriedAgentRecord = {
        id,
        agent_name: agent.agent_name,
        agency: agent.agency,
        book_title: profile.book_title || "Untitled project",
        sent_at: existing?.sent_at || new Date().toISOString(),
        method: submissionRouteLabel(agent),
        route: agent.query_method === "email" ? agent.public_email || "" : agent.submission_url || agent.source_url,
        materials,
        status: existing?.status || "sent",
        denied_reason: existing?.denied_reason || "",
        follow_up_notes: existing?.follow_up_notes || "",
      };
      return [nextRecord, ...current.filter((record) => record.id !== id)];
    });
    setStatus(`Saved queried agent: ${agent.agent_name}.`);
    if (session) {
      void api("/api/submissions/mark-sent", {
        method: "POST",
        body: JSON.stringify({ agent_name: agent.agent_name, agency: agent.agency, book_title: profile.book_title }),
      }, session.token);
    }
  }

  function updateQueriedAgent(id: string, updates: Partial<QueriedAgentRecord>) {
    setQueriedAgents((current) => current.map((record) => (
      record.id === id ? { ...record, ...updates } : record
    )));
  }

  const sortedAgents = useMemo(() => agents.filter((agent) => agent.open_status !== "closed"), [agents]);

  useEffect(() => {
    if (!intelAgent) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setIntelAgent(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [intelAgent]);

  function intelLabel(source: string, index: number) {
    try {
      const url = new URL(source);
      const host = url.hostname.replace(/^www\./, "");
      const path = url.pathname.toLowerCase();
      if (host.includes("youtube.com") || host.includes("youtu.be")) return "YouTube";
      if (host.includes("spotify.com") || host.includes("podcasts.apple.com") || host.includes("podbean.com")) return "Podcast";
      if (host.includes("manuscriptwishlist.com")) return "MSWL";
      if (path.includes("interview")) return "Interview";
      if (path.includes("podcast")) return "Podcast";
      if (path.includes("video") || path.includes("webinar")) return "Video";
      if (path.includes("submission") || path.includes("querymanager")) return "Submission";
      if (host.includes("agency") || host.includes("literary") || host.includes("lit")) return "Agency";
    } catch {
      return `Source ${index + 1}`;
    }
    return `Source ${index + 1}`;
  }

  function intelSources(agent: AgentRecord) {
    const sources = [
      ...(agent.source_urls?.length ? agent.source_urls : [agent.source_url]),
      agent.submission_url || "",
    ].filter(Boolean);
    return Array.from(new Set(sources)).slice(0, 6);
  }

  async function openBilling() {
    if (!session) return;
    const response = await api<{ url: string }>("/api/billing/portal", { method: "POST" }, session.token);
    window.location.href = response.url;
  }

  function PacketTools({ id }: { id: PacketKey }) {
    return (
      <span className="packet-tools">
        <button className="text-button" type="button" onClick={() => copyPacketMaterial(id)}>Copy</button>
      </span>
    );
  }

  function UploadLink({ id, label = "Upload file" }: { id: SubmissionFileKey; label?: string }) {
    return (
      <span className="upload-link">
        {submissionFiles[id] ? "Replace file" : label}
        <input type="file" accept=".doc,.docx,.pdf,.txt,.rtf" onChange={(event) => updateSubmissionFile(id, event.target.files)} />
      </span>
    );
  }

  function FieldMeta({ value, max, fileName }: { value: string; max?: number; fileName?: string }) {
    return (
      <span className="field-meta">
        <small>{wordCountText(value, max)}</small>
        {fileName ? <small>{fileName}</small> : <small>&nbsp;</small>}
      </span>
    );
  }

  function saveKit() {
    setKitSaved(true);
    setStatus("Kit saved.");
    setActiveView("search");
  }

  return (
    <main className="workspace-shell">
      <aside className="sidebar">
        <button className="sidebar-brand" type="button">Query Quick</button>
        <nav className="sidebar-section" aria-label="Workspace navigation">
          <button className={`sidebar-item ${activeView === "kit" ? "active" : ""}`} type="button" onClick={() => setActiveView("kit")}>Submission Kit</button>
          <button className={`sidebar-item ${activeView === "search" ? "active" : ""}`} type="button" onClick={() => setActiveView("search")}>Agent Search</button>
          <button className={`sidebar-item ${activeView === "profile" ? "active" : ""}`} type="button" onClick={() => setActiveView("profile")}>Your Profile</button>
          <button className={`sidebar-item ${activeView === "saved" ? "active" : ""}`} type="button" onClick={() => setActiveView("saved")}>Saved Queried Agents</button>
        </nav>
        <div className="sidebar-footer">
          <button className="sidebar-item subtle" type="button" onClick={openBilling}>Manage Billing</button>
          <button className="sidebar-item subtle" type="button" onClick={logout}>Sign out</button>
        </div>
      </aside>

      <section className="main-content">
        <div className="main-header">
          <div>
            <p className="kicker">Query Quick</p>
            <h1>{activeView === "search" ? "Agent search" : activeView === "saved" ? "Saved queried agents" : activeView === "profile" ? "Your profile" : "Submission kit"}</h1>
            <p className="main-subheading">
              {activeView === "search" ? (
                <>
                  <strong>We’re doing the heavy lifting</strong>—checking multiple sources and matching agents to your criteria.{" "}
                  <strong>It may take a minute or two.</strong> Feel free to grab a coffee—we’ll have results ready shortly.
                </>
              ) : activeView === "kit" ? (
                "Build each submission item both ways: paste text for portal fields and upload the finished document when an agent asks for a file."
              ) : activeView === "profile" ? (
                "Your book details power everything—agent matching and query formatting. The more accurate your input, the better your results."
              ) : (
                "Track submitted agents, how they were queried, what was sent, and what happened next."
              )}
            </p>
          </div>
          {activeView === "search" ? (
            <div className="main-actions" aria-label="Agent search actions">
              <button className="primary-button action-button" type="button" disabled={isSearching} onClick={findAgents}>Find matching agents</button>
              <div className="agent-action-note">
                <p>Find matching agents builds a working list from your book profile and current public submission sources.</p>
                <p>Run Intel on an agent when you want Query Quick to prepare the exact submission route, required materials, and next action.</p>
              </div>
            </div>
          ) : null}
        </div>

        <div className={`main-grid ${activeView === "search" || activeView === "kit" || activeView === "saved" || activeView === "profile" ? "single-grid" : ""}`}>
          <div className="work-area">
            {activeView === "kit" ? (
              <>
            <section className="kit-section query-upload-section" aria-labelledby="query-upload-title">
              <div className="kit-heading">
                <div>
                  <p className="kicker">Submission Kit</p>
                  <h2 id="query-upload-title">Query letter</h2>
                </div>
                <span className="kit-heading-actions">
                  <PacketTools id="query_letter" />
                </span>
              </div>
              <div className="query-upload-card">
                <div>
                  <strong>Upload query letter here</strong>
                  <span>Use the finished query letter you want attached or referenced when an agent asks for a file.</span>
                </div>
                <UploadLink id="query_letter" />
              </div>
              {submissionFiles.query_letter ? <p className="file-name">{submissionFiles.query_letter}</p> : null}
            </section>

            <section className="kit-section" aria-labelledby="materials-title">
              <div className="kit-heading">
                <div>
                  <p className="kicker">Agent requests</p>
                  <h2 id="materials-title">Submission materials</h2>
                </div>
              </div>
              <div className="materials-list">
                <label className="kit-field">
                  <span className="material-title"><span>Synopsis</span><span className="material-actions"><UploadLink id="synopsis" /><PacketTools id="synopsis" /></span></span>
                  <textarea value={submissionKit.synopsis} onChange={(event) => updateSubmissionKit("synopsis", event.target.value)} placeholder="1000 words max." />
                  <FieldMeta value={submissionKit.synopsis} max={1000} fileName={submissionFiles.synopsis} />
                </label>
                <label className="kit-field">
                  <span className="material-title"><span>First 50 pages</span><span className="material-actions"><UploadLink id="first_pages" /><PacketTools id="first_pages" /></span></span>
                  <textarea value={submissionKit.first_pages} onChange={(event) => updateSubmissionKit("first_pages", event.target.value)} />
                  <FieldMeta value={submissionKit.first_pages} fileName={submissionFiles.first_pages} />
                </label>
                <label className="kit-field compact">
                  <span className="material-title"><span>Concise description</span><span className="material-actions"><UploadLink id="concise_description" /><PacketTools id="concise_description" /></span></span>
                  <textarea value={submissionKit.concise_description} onChange={(event) => updateSubmissionKit("concise_description", event.target.value)} />
                  <FieldMeta value={submissionKit.concise_description} fileName={submissionFiles.concise_description} />
                </label>
                <label className="kit-field compact">
                  <span className="material-title"><span>Bio paragraph</span><span className="material-actions"><UploadLink id="bio_paragraph" /><PacketTools id="bio_paragraph" /></span></span>
                  <textarea value={submissionKit.bio_paragraph} onChange={(event) => updateSubmissionKit("bio_paragraph", event.target.value)} />
                  <FieldMeta value={submissionKit.bio_paragraph} fileName={submissionFiles.bio_paragraph} />
                </label>
                <label className="kit-field compact">
                  <span className="material-title"><span>Publishing history</span><span className="material-actions"><UploadLink id="publishing_history" /><PacketTools id="publishing_history" /></span></span>
                  <textarea value={submissionKit.publishing_history} onChange={(event) => updateSubmissionKit("publishing_history", event.target.value)} />
                  <FieldMeta value={submissionKit.publishing_history} fileName={submissionFiles.publishing_history} />
                </label>
                <label className="kit-field compact">
                  <span className="material-title"><span>Sample chapters</span><span className="material-actions"><UploadLink id="sample_chapters" /><PacketTools id="sample_chapters" /></span></span>
                  <textarea value={submissionKit.sample_chapters} onChange={(event) => updateSubmissionKit("sample_chapters", event.target.value)} />
                  <FieldMeta value={submissionKit.sample_chapters} fileName={submissionFiles.sample_chapters} />
                </label>
                <label className="kit-field">
                  <span className="material-title"><span>Nonfiction proposal</span><span className="material-actions"><UploadLink id="proposal" /><PacketTools id="proposal" /></span></span>
                  <textarea value={submissionKit.proposal} onChange={(event) => updateSubmissionKit("proposal", event.target.value)} />
                  <FieldMeta value={submissionKit.proposal} fileName={submissionFiles.proposal} />
                </label>
                <label className="kit-field compact">
                  <span className="material-title"><span>Logline</span><span className="material-actions"><UploadLink id="logline" /><PacketTools id="logline" /></span></span>
                  <input value={submissionKit.logline} onChange={(event) => updateSubmissionKit("logline", event.target.value)} />
                  <FieldMeta value={submissionKit.logline} fileName={submissionFiles.logline} />
                </label>
                <label className="kit-field compact">
                  <span className="material-title"><span>One paragraph pitch</span><span className="material-actions"><UploadLink id="short_pitch" /><PacketTools id="short_pitch" /></span></span>
                  <textarea value={submissionKit.short_pitch} onChange={(event) => updateSubmissionKit("short_pitch", event.target.value)} placeholder="No more than 50 words." />
                  <FieldMeta value={submissionKit.short_pitch} max={50} fileName={submissionFiles.short_pitch} />
                </label>
                <label className="kit-field compact">
                  <span className="material-title"><span>Books in conversation with yours</span><span className="material-actions"><UploadLink id="comps" /><PacketTools id="comps" /></span></span>
                  <textarea value={submissionKit.comps} onChange={(event) => updateSubmissionKit("comps", event.target.value)} />
                  <FieldMeta value={submissionKit.comps} fileName={submissionFiles.comps} />
                </label>
                <label className="kit-field compact">
                  <span className="material-title"><span>Trigger warnings</span><span className="material-actions"><UploadLink id="trigger_warnings" /><PacketTools id="trigger_warnings" /></span></span>
                  <textarea value={submissionKit.trigger_warnings} onChange={(event) => updateSubmissionKit("trigger_warnings", event.target.value)} />
                  <FieldMeta value={submissionKit.trigger_warnings} fileName={submissionFiles.trigger_warnings} />
                </label>
                <label className="kit-field">
                  <span className="material-title"><span>Inspiration / why this story / why now</span><span className="material-actions"><UploadLink id="inspiration" /><PacketTools id="inspiration" /></span></span>
                  <textarea value={submissionKit.inspiration} onChange={(event) => updateSubmissionKit("inspiration", event.target.value)} />
                  <FieldMeta value={submissionKit.inspiration} fileName={submissionFiles.inspiration} />
                </label>
                <label className="kit-field">
                  <span className="material-title"><span>More about you</span><span className="material-actions"><UploadLink id="more_about_you" /><PacketTools id="more_about_you" /></span></span>
                  <textarea value={submissionKit.more_about_you} onChange={(event) => updateSubmissionKit("more_about_you", event.target.value)} />
                  <FieldMeta value={submissionKit.more_about_you} fileName={submissionFiles.more_about_you} />
                </label>
                <label className="kit-field compact">
                  <span className="material-title"><span>Writing prizes</span><span className="material-actions"><UploadLink id="prizes" /><PacketTools id="prizes" /></span></span>
                  <textarea value={submissionKit.prizes} onChange={(event) => updateSubmissionKit("prizes", event.target.value)} />
                  <FieldMeta value={submissionKit.prizes} fileName={submissionFiles.prizes} />
                </label>
              </div>
            </section>
            <div className="packet-bar">
              <span>{kitSaved ? "Kit saved" : "Kit has unsaved changes"}</span>
              <button className="secondary-button" type="button" onClick={openCopySpecific}>Copy specific</button>
              <button className="secondary-button" type="button" onClick={() => copyPacket(packetOrder)}>Copy full kit</button>
              <button className="primary-button" type="button" onClick={saveKit}>Save kit</button>
            </div>
              </>
            ) : null}

            {activeView === "search" ? (
              <>
            <div className="results-head">
              <p>{status}</p>
              <span>Sent: {sentCount}</span>
            </div>
            <div className="criteria-strip" aria-label="Search criteria">
              {searchCriteria.map((item) => (
                <span className={item.value ? "" : "missing"} key={item.label}>
                  <strong>{item.label}</strong>
                  {item.value || "Missing"}
                </span>
              ))}
            </div>
            {isSearching ? (
              <div className="activity-monitor" role="status" aria-live="polite">
                <span className="activity-pulse" aria-hidden="true" />
                {activityIndex < agentSearchActivity.length ? (
                  <p>{agentSearchActivity[activityIndex]}</p>
                ) : (
                  <p className="searching-wait">
                    Searching<span aria-hidden="true" />
                  </p>
                )}
              </div>
            ) : null}

            {sortedAgents.length ? (
              <>
                <div className="research-note">
                  <span>Agents are listed first. Run Intel when you want submission-ready details.</span>
                  <strong>Agent Intel running: {intelLoadingKeys.length}/{maxConcurrentIntel}</strong>
                </div>
                <div className="agent-list">
                  {sortedAgents.map((agent) => {
                    const isIntelLoading = intelLoadingKeys.includes(agentKey(agent));
                    const intelLimitReached = intelLoadingKeys.length >= maxConcurrentIntel && !isIntelLoading;
                    const needsIntel = agentNeedsIntel(agent);
                    const intelBlocked = needsIntel && intelLimitReached;
                    const intelState = isIntelLoading ? "running" : needsIntel ? "pending" : "ready";
                    return (
                    <article className="agent-row" key={agentKey(agent)}>
                      <div className="agent-main">
                        <div className="agent-title">
                          <div>
                            <h2>{agent.agent_name}</h2>
                            <p>{agent.agency}</p>
                          </div>
                          <span className={`open-status ${agent.open_status}`}>{agent.open_status}</span>
                        </div>
                        <div className="match-pills" aria-label="Agent match signals">
                          <span>Genre Match</span>
                          <span>Sub-Genre Match</span>
                          {agent.seen_before ? <span className="seen-before">Seen Before</span> : null}
                          <button
                            className={`intel-pill intel-${intelState}`}
                            type="button"
                            disabled={isIntelLoading || intelBlocked}
                            onClick={() => needsIntel ? runAgentIntel(agent) : setIntelAgent(agent)}
                          >
                            {isIntelLoading ? "Intel running" : needsIntel ? "Run Intel" : "Intel Ready"}
                          </button>
                        </div>
                        {agent.fit_reason ? <p className="fit-reason">{agent.fit_reason}</p> : null}
                        <p className="requirements-summary">{agent.requirements_summary}</p>
                        <div className="submission-route-card">
                          <span>{agent.submission_route_verified === false ? "Submission route" : "Verified submission route"}</span>
                          <strong>{submissionRouteLabel(agent)}</strong>
                          <p>{agent.submission_route_notes || verifiedRouteText(agent)}</p>
                        </div>
                        {agent.required_materials?.length ? (
                          <div className="requirements-list" aria-label="Required materials">
                            {agent.required_materials.map((material) => (
                              <span key={material}>{materialLabels[material] || material}</span>
                            ))}
                          </div>
                        ) : null}
                        {agent.verification_notes ? <p className="verification-note">{agent.verification_notes}</p> : null}
                        <div className="agent-meta">
                          <span>Last checked {agent.last_verified}</span>
                          {agent.submission_route_verified ? <span>{verifiedRouteText(agent)}</span> : null}
                        </div>
                      </div>
                      <div className="agent-actions">
                        <button
                          className={`secondary-button intel-button intel-${intelState}`}
                          type="button"
                          disabled={isIntelLoading || intelBlocked}
                          onClick={() => needsIntel ? runAgentIntel(agent) : setIntelAgent(agent)}
                        >
                          {isIntelLoading ? "Intel..." : intelLimitReached ? "Two running" : needsIntel ? "Run Intel" : "View Intel"}
                        </button>
                        {agent.query_method === "email" && agent.public_email ? (
                          <button className="secondary-button" type="button" onClick={() => emailAgent(agent)}>Start Email</button>
                        ) : (
                          <button className="secondary-button" type="button" disabled={!canOpenSubmissionRoute(agent)} onClick={() => openSubmissionWithKit(agent)}>
                            {canOpenSubmissionRoute(agent) ? routeActionWithKitLabel(agent) : "Route unavailable"}
                          </button>
                        )}
                        <button className="secondary-button" type="button" onClick={() => markSent(agent)}>Mark Sent</button>
                      </div>
                    </article>
                  );})}
                </div>
              </>
            ) : (
              <div className="results-placeholder">
                <p>Find agents based on your profile.</p>
                <ul>
                  <li>Agent name, agency, and genre fit</li>
                  <li>Verified submission route: QueryTracker, online form, portal, or email</li>
                  <li>Required kit pieces selected from agent guidelines</li>
                  <li>Search requires genre, subgenre, and category from Your Profile</li>
                </ul>
              </div>
            )}
              </>
            ) : null}

            {activeView === "saved" ? (
              queriedAgents.length ? (
                <section className="queried-list" aria-label="Saved queried agents">
                  {queriedAgents.map((record) => (
                    <article className="queried-card" key={record.id}>
                      <div className="queried-card-header">
                        <div>
                          <h2>{record.agent_name}</h2>
                          <p>{record.agency}</p>
                        </div>
                        <span>{new Date(record.sent_at).toLocaleDateString()}</span>
                      </div>
                      <div className="queried-detail-grid">
                        <div>
                          <span>Project</span>
                          <strong>{record.book_title}</strong>
                        </div>
                        <div>
                          <span>Sent via</span>
                          <strong>{record.method}</strong>
                        </div>
                        <div>
                          <span>Route</span>
                          <strong>{record.route || "Saved with agent record"}</strong>
                        </div>
                      </div>
                      <div className="requirements-list" aria-label="Materials sent">
                        {record.materials.map((material) => <span key={material}>{material}</span>)}
                      </div>
                      <div className="queried-followup">
                        <label>
                          <span>Follow-up status</span>
                          <select
                            value={record.status}
                            onChange={(event) => updateQueriedAgent(record.id, { status: event.target.value as QueriedAgentStatus })}
                          >
                            <option value="sent">Sent</option>
                            <option value="full_manuscript_requested">Full manuscript requested</option>
                            <option value="denied">Denied</option>
                            <option value="no_response">No response yet</option>
                            <option value="closed">Closed</option>
                          </select>
                        </label>
                        {record.status === "denied" ? (
                          <label>
                            <span>Denied reason</span>
                            <textarea
                              value={record.denied_reason}
                              onChange={(event) => updateQueriedAgent(record.id, { denied_reason: event.target.value })}
                            />
                          </label>
                        ) : null}
                        <label>
                          <span>Follow-up notes</span>
                          <textarea
                            value={record.follow_up_notes}
                            onChange={(event) => updateQueriedAgent(record.id, { follow_up_notes: event.target.value })}
                          />
                        </label>
                      </div>
                    </article>
                  ))}
                </section>
              ) : (
                <section className="results-placeholder">
                  <p>Saved queried agents will appear here.</p>
                  <ul>
                    <li>Mark an agent sent from Agent Search</li>
                    <li>See what kit pieces were sent and how</li>
                    <li>Track full-manuscript requests, denials, and follow-up notes</li>
                  </ul>
                </section>
              )
            ) : null}

            {activeView === "profile" ? (
              <section className="profile-panel profile-page">
                <h2>Your Profile</h2>
                <label htmlFor="profile-name">Name</label>
                <input id="profile-name" value={profile.name} onChange={(event) => updateProfile("name", event.target.value)} />
                <label htmlFor="profile-title">Book title</label>
                <input id="profile-title" value={profile.book_title} onChange={(event) => updateProfile("book_title", event.target.value)} />
                <label htmlFor="profile-genre">Genre</label>
                <input id="profile-genre" value={profile.genre} onChange={(event) => updateProfile("genre", event.target.value)} />
                <label htmlFor="profile-subgenre">Subgenre</label>
                <textarea id="profile-subgenre" value={profile.subgenre} onChange={(event) => updateProfile("subgenre", event.target.value)} />
                <label htmlFor="profile-category">Category</label>
                <select id="profile-category" value={profile.category} onChange={(event) => updateProfile("category", event.target.value)}>
                  <option value="adult fiction">Adult fiction</option>
                  <option value="Fiction">Fiction</option>
                  <option value="Nonfiction">Nonfiction</option>
                </select>
                <label htmlFor="profile-word-count">Word count</label>
                <input id="profile-word-count" value={profile.word_count} onChange={(event) => updateProfile("word_count", event.target.value)} />
                <fieldset className="profile-status-group">
                  <legend>Do you have a complete manuscript?</legend>
                  <label>
                    <input
                      type="radio"
                      name="profile-manuscript-complete"
                      checked={submissionKit.manuscript_complete}
                      onChange={() => updateSubmissionKit("manuscript_complete", true)}
                    />
                    Yes
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="profile-manuscript-complete"
                      checked={!submissionKit.manuscript_complete}
                      onChange={() => updateSubmissionKit("manuscript_complete", false)}
                    />
                    No
                  </label>
                </fieldset>
                <button className="primary-button profile-save-button" type="button" onClick={saveProfile}>Save profile</button>
              </section>
            ) : null}
          </div>
        </div>
      </section>
      {intelAgent ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setIntelAgent(null)}>
          <section
            className="intel-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="intel-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button className="modal-close" type="button" aria-label="Close" onClick={() => setIntelAgent(null)}>Close</button>
            <p className="kicker">Agent Intel</p>
            <h2 id="intel-title">{intelAgent.agent_name}</h2>
            <p className="intel-summary">{intelAgent.verification_notes || intelAgent.fit_reason || "Open the public sources used for this agent record."}</p>
            <div className="intel-links">
              {intelSources(intelAgent).map((source, index) => (
                <a href={source} target="_blank" rel="noreferrer" key={source}>
                  {intelLabel(source, index)}
                </a>
              ))}
            </div>
            {intelAgent.required_materials?.length ? (
              <div className="requirements-list modal-requirements" aria-label="Agent Intel required materials">
                {intelAgent.required_materials.map((material) => (
                  <span key={material}>{materialLabels[material] || material}</span>
                ))}
              </div>
            ) : null}
            <div className="modal-actions intel-actions">
              <button className="secondary-button" type="button" onClick={() => copyRequiredKit(intelAgent)}>Copy Required Kit</button>
              {intelAgent.query_method === "email" && intelAgent.public_email ? (
                <button className="primary-button" type="button" onClick={() => emailAgent(intelAgent)}>Start Email</button>
              ) : (
                <button className="primary-button" type="button" disabled={!canOpenSubmissionRoute(intelAgent)} onClick={() => openSubmissionWithKit(intelAgent)}>
                  {canOpenSubmissionRoute(intelAgent) ? routeActionWithKitLabel(intelAgent) : "Route unavailable"}
                </button>
              )}
              <button className="secondary-button" type="button" onClick={() => markSent(intelAgent)}>Mark Sent</button>
            </div>
            <p className="modal-note">Use these public sources to check preferences and current submission instructions before sending. If a form blocks autofill, use Copy Required Kit, switch tabs, and paste each requested piece.</p>
          </section>
        </div>
      ) : null}
      {showCopySpecific ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowCopySpecific(false)}>
          <section
            className="copy-specific-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="copy-specific-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button className="modal-close" type="button" aria-label="Close" onClick={() => setShowCopySpecific(false)}>Close</button>
            <p className="kicker">Submission kit</p>
            <h2 id="copy-specific-title">Copy specific pieces</h2>
            <p className="modal-note">Choose the uploaded or filled-in kit pieces you want copied into one formatted packet for email, portals, QueryManager, QueryTracker, or personal website forms.</p>
            <div className="specific-list">
              {availableSpecificMaterials().length ? availableSpecificMaterials().map((key) => (
                <label className="specific-item" key={key}>
                  <input
                    type="checkbox"
                    checked={specificMaterials.includes(key)}
                    onChange={() => toggleSpecificMaterial(key)}
                  />
                  <span>
                    <strong>{materialLabels[key]}</strong>
                    <small>{getPacketMaterialFile(key) || wordCountText(getPacketMaterialText(key))}</small>
                  </span>
                </label>
              )) : <p className="specific-empty">Nothing has content or an uploaded file yet.</p>}
            </div>
            <div className="modal-actions specific-actions">
              <button className="secondary-button" type="button" onClick={() => setShowCopySpecific(false)}>Cancel</button>
              <button className="primary-button" type="button" onClick={copySpecificMaterials} disabled={!specificMaterials.length}>Copy</button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function ProtectedWorkspace() {
  return <LoginGate />;
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/quick" element={<ProtectedWorkspace />} />
        <Route path="/subscribed" element={<SubscribeInstructions />} />
        <Route path="/auth/verify" element={<VerifyMagicLink />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}

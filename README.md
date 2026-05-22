# Query Quick

Query Quick is the writer-facing agent research and query workflow product.

It is intentionally separated from Query Salon. Query Salon remains the future/platform product lineage; Query Quick owns the writer runtime, writer API behavior, writer storage, and Agent Intel workflow.

## Product Boundary

- Query Quick: writer-facing PWA, magic-link auth, billing, profile/submission kit, agent discovery, Agent Intel, sent tracking.
- Query Salon: future agent-facing/platform product. Do not add Query Quick route logic there.
- Master Agent Index: shared agent intelligence records and refresh logic that Query Quick can use.
- User Agent Lists: per-writer search history, seen/sent state, and subscriber-specific rows linked to master agent records.

## Local Build

### Web

```bash
cd web
npm install
npm run build
```

### API

```bash
cd api
npm install
npm run db:migrate:local
npm run check
```

For local end-to-end testing, run the API with `npm run dev` and the web app with
`npm run dev` in `web/`. The API accepts localhost origins during local development
and returns a local dev magic link when email delivery is not configured.

## Cloudflare Shape

- Worker name: `query-quick-api` (the single Query Quick Agent Intelligence Engine surface)
- D1 database: `query_quick`
- R2 bucket: `query-quick-files`
- API custom domain: `quick-api.querysalon.com`
- Pages project: `query-quick`

Do not deploy this through the old `query-salon-api` Worker. Do not reuse Query Salon storage for Query Quick user state.

## Agent Intelligence Engine

Query Quick is not a live scraper and the app shell must not make users wait on live research.

The existing `query-quick-api` Worker owns the full background intelligence engine:

- Cron decides which lanes need work.
- Queues process discovery, verification, wishlist extraction, genre normalization, ranking, open-status refresh, and notifications.
- D1 stores current operational truth and precomputed scores.
- R2 stores short-lived source snapshots under `agent-engine/snapshots/`.
- Vectorize stores wishlist embeddings for background semantic matching.

The user search path is intentionally short:

1. normalize the writer's genre/subgenre/category
2. read prepared `OPEN` agent records from D1
3. order by precomputed `final_rank_score`
4. return up to 50 records immediately
5. queue background refresh when coverage is thin

OpenAI, Gemini, Claude, web search, source parsing, and Vectorize embedding writes are background-only. They run during ingestion, refresh, verification, wishlist extraction, and ranking work. They do not run during `/api/agents/search`.

Validated source paths are treated as operational intelligence. When AALA, QueryManager, MSWL, agency pages, or other source paths produce usable open agents, they are promoted into `quick_validated_agent_paths` with genre lane, yield, priority, confidence, and next-check timing. Cron uses those validated paths before wandering into lower-yield research.

## Agent Discovery Frame

Query Quick is not a one-shot "find every agent" prompt. It is a subscriber-specific discovery and normalization engine.

## Master Agent Index

The master index is the durable truth layer behind discovery. `quick_agents` stores the canonical agent row, while the master facets split the record into:

- `quick_agent_genres`: genre, subgenre, category, and fit evidence, so one agent can belong to many lanes.
- `quick_agent_requirements`: submission route, required kit pieces, wishlist summary, opener guidance, and verification notes.
- `quick_agent_sources`: public source/profile/submission URLs used to support the row.
- `quick_agent_status_checks`: every open/closed route ping, including HTTP status and notes.

Runtime search should load the stored genre-matched pool first, then use live discovery only to fill gaps or refresh stale rows.

The runtime frame:

1. Start with the subscriber profile: genre, subgenre, category, and project language.
2. Expand only that subscriber's genre boundary into adjacent fit terms.
3. Load stored open/selective agents from the warm pool first.
4. Run source lanes one at a time:
   - AALA member directory and AALA profile pages
   - broad public agent/profile search
   - QueryTracker-style public search results
   - QueryManager public pages
   - Manuscript Wish List/public wishlist pages
   - agency websites and submission pages
   - newer/associate agent announcements and profiles
   - boutique/independent agency pages
   - LiteraryAgencies.com genre lead pages
   - The Wordling US literary agents list for agency/name coverage
   - 1000 Literary Agents US listing pages for query-status and genre leads
   - RegionalDirectory.us agency locator pages as low-confidence source leads
   - deep public directory/profile pass
5. Normalize each lane into structured agent records.
6. Deduplicate by agent plus agency.
7. Keep discovered agents in the master pool, even if they are not sent.
8. Mark `seen_before` only when the writer actually sends or marks a query sent.
9. Let cron refresh open/closed state so stored agents can re-enter future searches when their green light comes back on.
10. Stop a live run when source lanes stop producing new agents, then use Agent Intel as the second pass for requirements and route confidence.

The product value is not just finding agents. The product value is finding, verifying, structuring, refreshing, and making agents actionable from the writer's kit.

Source posture:

- AALA is the strongest directory source because it exposes member subject focus and open/closed submission status, but Query Quick still verifies exact submission requirements before treating an agent as ready.
- LiteraryAgencies.com, The Wordling, 1000 Literary Agents, and RegionalDirectory are lead sources. They help widen coverage; they do not by themselves prove current query status, wishlist fit, or submission requirements.

## Secrets

Use KeyMaster and the local lockbox for secret-bearing work. Do not put raw secrets into repo files.

Expected Worker secrets:

- `OPENAI_API_KEY`
- `GEMINI_API_KEY`
- `ANTHROPIC_API_KEY`
- optional `GOOGLE_SEARCH_API_KEY`
- optional `GOOGLE_SEARCH_CX`
- optional `BING_SEARCH_API_KEY`
- optional `BING_SEARCH_ENDPOINT` for a current Bing-compatible search endpoint; Microsoft's public Bing Search APIs retired in 2025
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `STRIPE_SECRET_KEY`
- `STRIPE_PRICE_ID`
- optional `EMAIL_WEBHOOK_URL`

Gemini is the primary Google-backed source lane. Query Quick uses `GEMINI_API_KEY` with Gemini Google Search grounding to gather live source leads and grounded agent candidates. The `GOOGLE_SEARCH_*` secrets are legacy/optional Custom Search JSON API settings and are not required for the Google AI path.

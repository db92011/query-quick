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
npm run check
```

## Cloudflare Shape

- Worker name: `query-quick-api`
- D1 database: `query_quick`
- R2 bucket: `query-quick-files`
- API custom domain: `quick-api.querysalon.com`
- Pages project: `query-quick`

Do not deploy this through the old `query-salon-api` Worker. Do not reuse Query Salon storage for Query Quick user state.

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
   - broad public agent/profile search
   - QueryTracker-style public search results
   - QueryManager public pages
   - Manuscript Wish List/public wishlist pages
   - agency websites and submission pages
   - newer/associate agent announcements and profiles
   - boutique/independent agency pages
   - deep public directory/profile pass
5. Normalize each lane into structured agent records.
6. Deduplicate by agent plus agency.
7. Keep discovered agents in the master pool, even if they are not sent.
8. Mark `seen_before` only when the writer actually sends or marks a query sent.
9. Let cron refresh open/closed state so stored agents can re-enter future searches when their green light comes back on.
10. Stop a live run when source lanes stop producing new agents, then use Agent Intel as the second pass for requirements and route confidence.

The product value is not just finding agents. The product value is finding, verifying, structuring, refreshing, and making agents actionable from the writer's kit.

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

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
- API route: `quick-api.querysalon.com`

Do not deploy this through the old `query-salon-api` Worker. Do not reuse Query Salon storage for Query Quick user state.

## Secrets

Use KeyMaster and the local lockbox for secret-bearing work. Do not put raw secrets into repo files.

Expected Worker secrets:

- `OPENAI_API_KEY`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `STRIPE_SECRET_KEY`
- `STRIPE_PRICE_ID`
- optional `EMAIL_WEBHOOK_URL`

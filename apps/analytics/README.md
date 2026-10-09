# Synara analytics and Beta diagnostics

This workspace owns the Cloudflare receiving Worker, private dashboard, D1
migrations, legacy ingestion forwarder and their tests. It includes Product
Overview, Providers, Tokens and Reliability, plus Beta release/crash diagnostics.

- Live: https://synara-beta-diagnostics.synara-orgs.workers.dev/#/product
- Privacy and client contract: [diagnostics](../../docs/diagnostics.md).
- Metrics and historical deployments: [ANALYTICS.md](ANALYTICS.md).
- Previous account migration: [MIGRATION.md](MIGRATION.md) (historical, not a setup requirement).

## From the Synara repository root

```bash
bun install --frozen-lockfile
bun run --cwd apps/analytics test
bun run --cwd apps/analytics typecheck
bun run --cwd apps/analytics build
```

Root Turbo tests/typechecks include this workspace. CI also builds the dashboard
and dry-runs the Worker bundle. The Worker imports the canonical
`@synara/shared/diagnosticsRedaction`; its regression tests remain in packages/shared.

## Local development

Create `apps/analytics/.dev.vars` (ignored) with local-only
`DASHBOARD_PASSWORD` and `DASHBOARD_SESSION_KEY`. From `apps/analytics`:

```bash
bunx wrangler d1 migrations apply synara-beta-diagnostics --local
bunx wrangler d1 execute synara-beta-diagnostics --local --file seed/local.sql
bun run dev --port 8787
```

Choose an unused port; local fixtures never belong in the production database.

## Deployment

From the root, with an authorized Synara Orgs Wrangler session:

```bash
bun run --cwd apps/analytics deploy
```

The script builds first. Existing Worker name, D1/R2 bindings, secrets and live URL
are preserved. Moving source into this monorepo requires no database migration,
new credentials or client endpoint change. Do not deploy from the former separate
repository: this workspace is the source of truth. For future schema changes,
review/apply pending D1 migrations separately before deploying dependent code.

`POST /v1/product-events` accepts bounded, consented desktop/iOS/iPadOS reports;
`GET /api/product` requires dashboard authentication. Raw product events expire
after 30 days. Provider turns and token samples currently describe observed
desktop completions, not account-wide billing or globally deduplicated execution.
Native clients contribute lifecycle, feature, connection and request events under
their own consent. Beta `/v1/events` and `/v1/crash` keep their separate policy.

No local state, credentials, D1 data, R2 dumps or exports are tracked here.

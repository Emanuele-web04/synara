#!/usr/bin/env bash
# Load ./export (from scripts/export.sh) into the NEW account. The D1 database
# named in wrangler.toml must be freshly created and empty: the export carries
# the schema and the applied-migrations table, so do not run migrations first.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID to the new account}"
bucket=synara-beta-crash-dumps

npx wrangler d1 execute synara-beta-diagnostics --remote --file export/db.sql -y

while read -r key; do
  npx wrangler r2 object put "$bucket/$key" --remote --file "export/r2/$key" --content-type application/octet-stream
done <export/r2-keys.txt

# Should report no migrations to apply.
npx wrangler d1 migrations apply synara-beta-diagnostics --remote
npx wrangler d1 execute synara-beta-diagnostics --remote \
  --command "SELECT (SELECT COUNT(*) FROM events) AS events, (SELECT COUNT(*) FROM usage_providers) AS usage_rows, (SELECT COUNT(*) FROM issue_status) AS triage_rows"

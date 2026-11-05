#!/usr/bin/env bash
# Copy all diagnostics data (D1 schema + rows, every R2 object) out of the
# account in CLOUDFLARE_ACCOUNT_ID into ./export. Read-only on Cloudflare.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID to the account being exported}"
out=export
bucket=synara-beta-crash-dumps
if [ -e "$out" ]; then echo "$out/ already exists; move it away first" >&2; exit 1; fi
mkdir -p "$out/r2"

npx wrangler d1 export synara-beta-diagnostics --remote --output "$out/db.sql"

token=$(npx wrangler auth token --json | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).token')
list="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets/$bucket/objects?per_page=1000"
cursor=""
while :; do
  page=$(curl -fsS -H "Authorization: Bearer $token" "$list${cursor:+&cursor=$cursor}")
  node -e 'for (const o of JSON.parse(process.argv[1]).result) console.log(o.key)' "$page" >>"$out/r2-keys.txt"
  cursor=$(node -pe 'const i = JSON.parse(process.argv[1]).result_info ?? {}; i.is_truncated ? i.cursor : ""' "$page")
  [ -n "$cursor" ] || break
done

while read -r key; do
  mkdir -p "$out/r2/$(dirname "$key")"
  npx wrangler r2 object get "$bucket/$key" --remote --file "$out/r2/$key"
done <"$out/r2-keys.txt"

echo "exported $(grep -c '^INSERT INTO "events"' "$out/db.sql") events, $(wc -l <"$out/r2-keys.txt" | tr -d ' ') dumps to $out/"

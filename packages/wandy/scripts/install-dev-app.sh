#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_app="${repo_root}/dist/Wandy.app"
stable_dir="${SYNARA_WANDY_STABLE_APP_DIR:-${HOME}/.synara/wandy-app}"
target_app="${stable_dir}/Wandy.app"
launcher="${target_app}/Contents/MacOS/Wandy"

if [[ ! -d "${source_app}" ]]; then
  echo "Missing ${source_app}. Build first:" >&2
  echo "  cd ${repo_root} && bun run build:macos" >&2
  exit 1
fi

echo "Stopping running Wandy / app-agent processes..."
pgrep -f "Wandy.app/Contents/MacOS/Wandy" | xargs kill 2>/dev/null || true
sleep 1

mkdir -p "${stable_dir}"
rm -rf "${target_app}"
ditto "${source_app}" "${target_app}"

echo ""
echo "Installed stable dev app:"
echo "  ${target_app}"
echo ""
echo "macOS ties Screen Recording to the app binary signature."
echo "Grant permissions ONCE for this stable copy — not packages/wandy/dist."
echo ""
echo "After every rebuild, rerun this script and re-grant in System Settings."
echo ""

"${launcher}" doctor
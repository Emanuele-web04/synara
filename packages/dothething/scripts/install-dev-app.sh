#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_app="${repo_root}/dist/Do The Thing.app"
stable_dir="${SYNARA_DOTHETHING_STABLE_APP_DIR:-${HOME}/.synara/dothething-app}"
target_app="${stable_dir}/Do The Thing.app"
launcher="${target_app}/Contents/MacOS/DoTheThing"

if [[ ! -d "${source_app}" ]]; then
  echo "Missing ${source_app}. Build first:" >&2
  echo "  cd ${repo_root} && bun run build:macos" >&2
  exit 1
fi

echo "Stopping running Do The Thing / app-agent processes..."
pgrep -f "Do The Thing.app/Contents/MacOS/DoTheThing" | xargs kill 2>/dev/null || true
sleep 1

mkdir -p "${stable_dir}"
rm -rf "${target_app}"
ditto "${source_app}" "${target_app}"

echo ""
echo "Installed stable dev app:"
echo "  ${target_app}"
echo ""
echo "macOS ties Screen Recording to the app binary signature."
echo "Grant permissions ONCE for this stable copy — not packages/dothething/dist."
echo ""
echo "After every rebuild, rerun this script and re-grant in System Settings."
echo ""

"${launcher}" doctor
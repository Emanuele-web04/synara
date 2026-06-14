#!/usr/bin/env bash

set -euo pipefail

plugin_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${plugin_root}/../.." && pwd)"
candidate_binaries=(
  "${plugin_root}/Do The Thing.app/Contents/MacOS/DoTheThing"
  "${plugin_root}/Do The Thing (Dev).app/Contents/MacOS/DoTheThing"
  "${plugin_root}/DoTheThing.app/Contents/MacOS/DoTheThing"
  "${plugin_root}/dothething"
  "${plugin_root}/dothething.exe"
  "${repo_root}/dist/Do The Thing (Dev).app/Contents/MacOS/DoTheThing"
  "${repo_root}/dist/Do The Thing.app/Contents/MacOS/DoTheThing"
  "${repo_root}/dist/DoTheThing.app/Contents/MacOS/DoTheThing"
  "${repo_root}/dist/linux/arm64/dothething"
  "${repo_root}/dist/linux/amd64/dothething"
  "${repo_root}/dist/windows/arm64/dothething.exe"
  "${repo_root}/dist/windows/amd64/dothething.exe"
)

for app_binary in "${candidate_binaries[@]}"; do
  if [[ -x "${app_binary}" ]]; then
    if [[ "${app_binary}" == "${plugin_root}"/* ]]; then
      cd "${plugin_root}"
    else
      cd "${repo_root}"
    fi
    exec "${app_binary}" mcp
  fi
done

if command -v dothething >/dev/null 2>&1; then
  exec dothething mcp
fi

echo "dothething could not find a runnable native runtime." >&2
echo "Checked:" >&2
for app_binary in "${candidate_binaries[@]}"; do
  echo "  - ${app_binary}" >&2
done
echo "  - dothething on PATH" >&2
echo "Run ./scripts/install-codex-plugin.sh to populate the Codex plugin cache." >&2
exit 1

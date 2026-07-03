#!/usr/bin/env bash

set -euo pipefail

plugin_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${plugin_root}/../.." && pwd)"
candidate_binaries=(
  "${plugin_root}/Wandy.app/Contents/MacOS/Wandy"
  "${plugin_root}/Wandy (Dev).app/Contents/MacOS/Wandy"
  "${plugin_root}/Wandy.app/Contents/MacOS/Wandy"
  "${plugin_root}/wandy"
  "${plugin_root}/wandy.exe"
  "${repo_root}/dist/Wandy (Dev).app/Contents/MacOS/Wandy"
  "${repo_root}/dist/Wandy.app/Contents/MacOS/Wandy"
  "${repo_root}/dist/Wandy.app/Contents/MacOS/Wandy"
  "${repo_root}/dist/linux/arm64/wandy"
  "${repo_root}/dist/linux/amd64/wandy"
  "${repo_root}/dist/windows/arm64/wandy.exe"
  "${repo_root}/dist/windows/amd64/wandy.exe"
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

if command -v wandy >/dev/null 2>&1; then
  exec wandy mcp
fi

echo "wandy could not find a runnable native runtime." >&2
echo "Checked:" >&2
for app_binary in "${candidate_binaries[@]}"; do
  echo "  - ${app_binary}" >&2
done
echo "  - wandy on PATH" >&2
echo "Run ./scripts/install-codex-plugin.sh to populate the Codex plugin cache." >&2
exit 1

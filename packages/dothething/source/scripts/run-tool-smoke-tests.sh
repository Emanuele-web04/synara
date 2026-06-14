#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "${repo_root}"

swift build
DOTHETHING_VISUAL_CURSOR=0 ".build/debug/DoTheThingSmokeSuite"
".build/debug/DoTheThingSmokeSuite" --cursor-idle-only

#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "${repo_root}"

swift build
WANDY_VISUAL_CURSOR=0 ".build/debug/WandySmokeSuite"
".build/debug/WandySmokeSuite" --cursor-idle-only

#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPDATE_SOURCE=1

if [[ "${1:-}" == "--skip-source-update" ]]; then
  UPDATE_SOURCE=0
elif [[ $# -gt 0 ]]; then
  echo "用法：$0 [--skip-source-update]"
  exit 2
fi

cd "$ROOT"
if [[ "$UPDATE_SOURCE" -eq 1 ]]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "工作区有尚未提交的修改；为防止上游更新覆盖汉化，已停止。"
    echo "先提交当前改动；只打包当前源码则运行：$0 --skip-source-update"
    exit 1
  fi
  echo "正在同步 Synara 上游 main…"
  git fetch origin main
  git rebase origin/main
fi

echo "正在按 bun.lock 同步依赖…"
bun install --frozen-lockfile
"$ROOT/scripts/build-synara-zh.sh"
"$ROOT/scripts/install-synara-zh.sh"

echo "已完成：上游同步、汉化构建、签名校验和覆盖安装。"

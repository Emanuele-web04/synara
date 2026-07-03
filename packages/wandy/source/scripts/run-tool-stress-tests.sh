#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loops="${WANDY_STRESS_LOOPS:-20}"
include_cursor_idle="${WANDY_STRESS_CURSOR_IDLE:-1}"
configuration="${WANDY_STRESS_CONFIGURATION:-debug}"

case "${configuration}" in
  debug)
    build_args=()
    products_dir=".build/debug"
    ;;
  release)
    build_args=(-c release)
    products_dir=".build/release"
    ;;
  *)
    echo "Unsupported WANDY_STRESS_CONFIGURATION: ${configuration}" >&2
    exit 2
    ;;
esac

if ! [[ "${loops}" =~ ^[0-9]+$ ]] || [[ "${loops}" -lt 1 ]]; then
  echo "WANDY_STRESS_LOOPS must be a positive integer." >&2
  exit 2
fi

cd "${repo_root}"

swift build "${build_args[@]}"

started_at="$(date +%s)"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/wandy-stress.XXXXXX")"
trap 'rm -rf "${tmp_dir}"' EXIT

for loop in $(seq 1 "${loops}"); do
  printf 'WandySmokeSuite stress loop %s/%s\n' "${loop}" "${loops}"
  WANDY_VISUAL_CURSOR=0 "${products_dir}/WandySmokeSuite" >"${tmp_dir}/loop-${loop}.log"
  tail -n 1 "${tmp_dir}/loop-${loop}.log"
done

cursor_idle_ran=0
if [[ "${include_cursor_idle}" == "1" || "${include_cursor_idle}" == "true" || "${include_cursor_idle}" == "yes" ]]; then
  "${products_dir}/WandySmokeSuite" --cursor-idle-only >"${tmp_dir}/cursor-idle.log"
  tail -n 1 "${tmp_dir}/cursor-idle.log"
  cursor_idle_ran=1
fi

ended_at="$(date +%s)"
cat <<JSON
{
  "ok": true,
  "configuration": "${configuration}",
  "loops": ${loops},
  "fixtureOperations": $((loops * 10)),
  "cursorIdleSmoke": ${cursor_idle_ran},
  "durationSeconds": $((ended_at - started_at))
}
JSON

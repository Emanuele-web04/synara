#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cli="${DOTHETHING_E2E_CLI:-${repo_root}/.build/debug/DoTheThing}"
timeout_seconds="${DOTHETHING_E2E_TIMEOUT_SECONDS:-3}"
disable_app_agent_proxy="${DOTHETHING_E2E_DISABLE_APP_AGENT_PROXY:-1}"

cd "${repo_root}"

if [[ -z "${DOTHETHING_E2E_CLI:-}" ]]; then
  swift build --product DoTheThing
fi

if [[ ! -x "${cli}" ]]; then
  if command -v dothething >/dev/null 2>&1; then
    cli="$(command -v dothething)"
  else
    echo "Missing executable: ${cli}" >&2
    echo "Run swift build first, or set DOTHETHING_E2E_CLI=/path/to/dothething." >&2
    exit 1
  fi
fi

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/dothething-permission-e2e.XXXXXX")"
cleanup() {
  rm -rf "${tmpdir}"
}
trap cleanup EXIT

echo "Using CLI: ${cli}"
if [[ "${disable_app_agent_proxy}" == "1" || "${disable_app_agent_proxy}" == "true" || "${disable_app_agent_proxy}" == "yes" ]]; then
  echo "Using direct CLI permission checks (app-agent proxy disabled for this E2E)."
  run_cli() {
    DOTHETHING_DISABLE_APP_AGENT_PROXY=1 "${cli}" "$@"
  }
else
  echo "Using default CLI app-agent proxy behavior."
  run_cli() {
    "${cli}" "$@"
  }
fi

doctor_output="$(run_cli doctor)"
echo "${doctor_output}"

if [[ "${doctor_output}" != *"accessibility=granted"* ]] || [[ "${doctor_output}" != *"screenRecording=granted"* ]]; then
  echo "Expected doctor to report both permissions granted before running onboarding E2E." >&2
  exit 1
fi

stdout_file="${tmpdir}/onboarding.stdout"
stderr_file="${tmpdir}/onboarding.stderr"

run_cli >"${stdout_file}" 2>"${stderr_file}" &
pid="$!"

deadline=$((SECONDS + timeout_seconds))
exit_code=""
while (( SECONDS < deadline )); do
  if ! kill -0 "${pid}" 2>/dev/null; then
    if wait "${pid}"; then
      exit_code=0
    else
      exit_code="$?"
    fi
    break
  fi
  sleep 0.05
done

if [[ -z "${exit_code}" ]]; then
  kill "${pid}" 2>/dev/null || true
  wait "${pid}" 2>/dev/null || true
  echo "Permission onboarding did not exit within ${timeout_seconds}s even though doctor reported granted." >&2
  echo "--- stdout ---" >&2
  cat "${stdout_file}" >&2
  echo "--- stderr ---" >&2
  cat "${stderr_file}" >&2
  exit 1
fi

if [[ "${exit_code}" != "0" ]]; then
  echo "Permission onboarding command exited with ${exit_code}." >&2
  echo "--- stdout ---" >&2
  cat "${stdout_file}" >&2
  echo "--- stderr ---" >&2
  cat "${stderr_file}" >&2
  exit "${exit_code}"
fi

echo "Permission onboarding E2E passed: granted permissions do not leave onboarding running."

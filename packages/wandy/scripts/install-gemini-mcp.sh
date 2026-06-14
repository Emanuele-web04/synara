#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
config_helper="${script_dir}/install-config-helper.mjs"
server_name="wandy"
command_name="wandy"
scope="project"

usage() {
  cat <<'EOF'
Usage: ./scripts/install-gemini-mcp.sh [--scope project|user]

Install the wandy stdio MCP entry into Gemini CLI config.
Defaults to project scope, which writes ./.gemini/settings.json for the current project.
Set GEMINI_CONFIG_PATH to override the target file directly.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scope)
      if [[ $# -lt 2 ]]; then
        echo "--scope requires a value" >&2
        usage >&2
        exit 1
      fi
      scope="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

case "${scope}" in
  project)
    default_config_path="$(pwd -P)/.gemini/settings.json"
    ;;
  user)
    default_config_path="${HOME}/.gemini/settings.json"
    ;;
  *)
    echo "Unsupported Gemini scope: ${scope}" >&2
    usage >&2
    exit 1
    ;;
esac

config_path="${GEMINI_CONFIG_PATH:-${default_config_path}}"

node "${config_helper}" gemini-mcp "${config_path}" "${server_name}" "${command_name}"

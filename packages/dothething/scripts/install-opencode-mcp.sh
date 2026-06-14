#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
config_helper="${script_dir}/install-config-helper.mjs"
server_name="dothething"
command_name="dothething"
opencode_config_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/opencode"

usage() {
  cat <<'EOF'
Usage: ./scripts/install-opencode-mcp.sh

Install the dothething stdio MCP entry into opencode config.
Set OPENCODE_CONFIG_PATH to override the primary config file directly.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
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

if [[ -n "${OPENCODE_CONFIG_PATH:-}" ]]; then
  primary_config_path="${OPENCODE_CONFIG_PATH}"
  secondary_config_path=""
elif [[ -f "${opencode_config_dir}/opencode.json" ]]; then
  primary_config_path="${opencode_config_dir}/opencode.json"
  secondary_config_path="${opencode_config_dir}/config.json"
elif [[ -f "${opencode_config_dir}/config.json" ]]; then
  primary_config_path="${opencode_config_dir}/config.json"
  secondary_config_path="${opencode_config_dir}/opencode.json"
else
  primary_config_path="${opencode_config_dir}/opencode.json"
  secondary_config_path="${opencode_config_dir}/config.json"
fi

node "${config_helper}" opencode-mcp "${primary_config_path}" "${secondary_config_path}" "${server_name}" "${command_name}"

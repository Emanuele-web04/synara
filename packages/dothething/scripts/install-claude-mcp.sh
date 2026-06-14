#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
config_helper="${script_dir}/install-config-helper.mjs"
claude_config_path="${CLAUDE_CONFIG_PATH:-${HOME}/.claude.json}"
project_root="$(pwd -P)"
server_name="dothething"
command_name="dothething"

usage() {
  cat <<'EOF'
Usage: ./scripts/install-claude-mcp.sh

Install the dothething stdio MCP entry into ~/.claude.json for the current project.
The script is idempotent: if the same MCP server entry already exists, it leaves the file unchanged.
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

node "${config_helper}" claude-mcp "${claude_config_path}" "${project_root}" "${server_name}" "${command_name}"

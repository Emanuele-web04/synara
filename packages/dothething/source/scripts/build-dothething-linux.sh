#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
arch="arm64"
configuration="release"
out_dir="${repo_root}/dist/linux"

print_help() {
  cat <<'EOF'
Usage:
  scripts/build-dothething-linux.sh [options]

Options:
  --arch arm64|amd64       Linux target architecture. Defaults to arm64.
  --configuration release  Reserved for parity with the macOS build script.
  --out-dir <dir>          Output directory. Defaults to dist/linux.
  -h, --help               Show help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch)
      arch="${2:?--arch requires a value}"
      shift 2
      ;;
    --configuration)
      configuration="${2:?--configuration requires a value}"
      shift 2
      ;;
    --out-dir)
      out_dir="$(cd "${repo_root}" && mkdir -p "$2" && cd "$2" && pwd)"
      shift 2
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      print_help >&2
      exit 1
      ;;
  esac
done

case "${arch}" in
  arm64|amd64) ;;
  *)
    echo "Unsupported Linux arch: ${arch}" >&2
    exit 1
    ;;
esac

version="$(node -e "console.log(require('./plugins/dothething/.codex-plugin/plugin.json').version)")"
module_dir="${repo_root}/apps/DoTheThingLinux"
output_dir="${out_dir}/${arch}"
mkdir -p "${output_dir}"

(
  cd "${module_dir}"
  GOOS=linux GOARCH="${arch}" CGO_ENABLED=0 go build \
    -trimpath \
    -ldflags "-s -w -X main.version=${version}" \
    -o "${output_dir}/dothething" \
    .
)

echo "Built ${configuration} Linux runtime: ${output_dir}/dothething"

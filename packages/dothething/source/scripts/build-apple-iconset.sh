#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/build-apple-iconset.sh <master-1024.png> <output.iconset>

Build a macOS .iconset from a square 1024x1024 PNG master asset.
EOF
}

if [[ $# -ne 2 ]]; then
  usage >&2
  exit 1
fi

source_png="$1"
output_dir="$2"

if [[ ! -f "${source_png}" ]]; then
  echo "Missing source PNG: ${source_png}" >&2
  exit 1
fi

width="$(sips -g pixelWidth "${source_png}" 2>/dev/null | awk '/pixelWidth:/ { print $2 }')"
height="$(sips -g pixelHeight "${source_png}" 2>/dev/null | awk '/pixelHeight:/ { print $2 }')"

if [[ "${width}" != "1024" || "${height}" != "1024" ]]; then
  echo "Source PNG must be 1024x1024, got ${width}x${height}: ${source_png}" >&2
  exit 1
fi

mkdir -p "${output_dir}"

render_icon() {
  local size="$1"
  local destination="$2"

  sips -s format png -z "${size}" "${size}" "${source_png}" --out "${destination}" >/dev/null
}

render_icon 16 "${output_dir}/icon_16x16.png"
render_icon 32 "${output_dir}/icon_16x16@2x.png"
render_icon 32 "${output_dir}/icon_32x32.png"
render_icon 64 "${output_dir}/icon_32x32@2x.png"
render_icon 128 "${output_dir}/icon_128x128.png"
render_icon 256 "${output_dir}/icon_128x128@2x.png"
render_icon 256 "${output_dir}/icon_256x256.png"
render_icon 512 "${output_dir}/icon_256x256@2x.png"
render_icon 512 "${output_dir}/icon_512x512.png"
cp "${source_png}" "${output_dir}/icon_512x512@2x.png"

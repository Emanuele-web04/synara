#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
configuration="release"
arch_mode="native"
version=""
output_dir=""
codesign_mode="${CURSOR_MOTION_CODESIGN_MODE:-adhoc}"
codesign_identity="${CURSOR_MOTION_CODESIGN_IDENTITY:-}"
codesign_keychain="${CURSOR_MOTION_CODESIGN_KEYCHAIN:-}"

usage() {
  cat <<'EOF'
Usage: ./scripts/build-cursor-motion-dmg.sh [--configuration debug|release] [--arch native|arm64|x86_64|universal] [--version X.Y.Z] [--output-dir PATH]

Examples:
  ./scripts/build-cursor-motion-dmg.sh
  ./scripts/build-cursor-motion-dmg.sh --configuration release --arch universal --version 0.1.0

Environment:
  CURSOR_MOTION_CODESIGN_MODE=identity|adhoc|none
  CURSOR_MOTION_CODESIGN_IDENTITY="Developer ID Application: Example, Inc. (TEAMID)"
  CURSOR_MOTION_CODESIGN_KEYCHAIN=/path/to/signing.keychain-db
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --configuration)
      configuration="${2:-}"
      if [[ -z "${configuration}" ]]; then
        echo "--configuration requires a value" >&2
        exit 1
      fi
      shift 2
      ;;
    --arch)
      arch_mode="${2:-}"
      if [[ -z "${arch_mode}" ]]; then
        echo "--arch requires a value" >&2
        exit 1
      fi
      shift 2
      ;;
    --version)
      version="${2:-}"
      if [[ -z "${version}" ]]; then
        echo "--version requires a value" >&2
        exit 1
      fi
      shift 2
      ;;
    --output-dir)
      output_dir="${2:-}"
      if [[ -z "${output_dir}" ]]; then
        echo "--output-dir requires a value" >&2
        exit 1
      fi
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

if [[ "${configuration}" != "debug" && "${configuration}" != "release" ]]; then
  echo "Unsupported configuration: ${configuration}" >&2
  exit 1
fi

if [[ "${arch_mode}" != "native" && "${arch_mode}" != "arm64" && "${arch_mode}" != "x86_64" && "${arch_mode}" != "universal" ]]; then
  echo "Unsupported arch mode: ${arch_mode}" >&2
  exit 1
fi

if [[ "${codesign_mode}" != "identity" && "${codesign_mode}" != "adhoc" && "${codesign_mode}" != "none" ]]; then
  echo "Unsupported CURSOR_MOTION_CODESIGN_MODE: ${codesign_mode}" >&2
  exit 1
fi

if [[ -z "${version}" ]]; then
  if tag="$(git -C "${repo_root}" describe --tags --exact-match 2>/dev/null)"; then
    version="${tag#v}"
  else
    version="0.0.0-dev"
  fi
fi

if [[ -z "${output_dir}" ]]; then
  output_dir="${repo_root}/dist/release/cursor-motion"
fi

build_binary() {
  local triple="${1:-}"
  local scratch_path="${2:-}"
  local -a args=(-c "${configuration}")

  if [[ -n "${triple}" ]]; then
    args+=(--triple "${triple}")
  fi

  if [[ -n "${scratch_path}" ]]; then
    args+=(--scratch-path "${scratch_path}")
  fi

  local binary_dir
  binary_dir="$(swift build "${args[@]}" --show-bin-path)"
  swift build "${args[@]}" --product CursorMotion >&2
  printf '%s/CursorMotion\n' "${binary_dir}"
}

list_user_keychains() {
  security list-keychains -d user \
    | sed -n 's/^[[:space:]]*"\(.*\)"$/\1/p'
}

run_with_codesign_keychain() {
  local keychain_path="${1:-}"
  shift

  if [[ -z "${keychain_path}" ]]; then
    "$@"
    return
  fi

  local -a existing_keychains=()
  while IFS= read -r keychain; do
    if [[ -n "${keychain}" ]]; then
      existing_keychains+=("${keychain}")
    fi
  done < <(list_user_keychains)

  local -a desired_keychains=("${keychain_path}")
  local existing=""
  for existing in "${existing_keychains[@]}"; do
    if [[ "${existing}" != "${keychain_path}" ]]; then
      desired_keychains+=("${existing}")
    fi
  done

  security list-keychains -d user -s "${desired_keychains[@]}" >/dev/null

  local status=0
  "$@" || status=$?

  if [[ ${#existing_keychains[@]} -gt 0 ]]; then
    security list-keychains -d user -s "${existing_keychains[@]}" >/dev/null
  else
    security list-keychains -d user -s >/dev/null
  fi

  return "${status}"
}

resolve_codesign_identity() {
  case "${codesign_mode}" in
    none)
      return 1
      ;;
    adhoc)
      printf '%s\n' "-"
      return 0
      ;;
    identity)
      if [[ -z "${codesign_identity}" ]]; then
        echo "CURSOR_MOTION_CODESIGN_IDENTITY is required when CURSOR_MOTION_CODESIGN_MODE=identity" >&2
        exit 1
      fi
      printf '%s\n' "${codesign_identity}"
      return 0
      ;;
  esac
}

codesign_app_bundle() {
  local app_path="${1:-}"
  local identity=""

  if ! identity="$(resolve_codesign_identity)"; then
    echo "Skipping codesign for ${app_path} (CURSOR_MOTION_CODESIGN_MODE=none)" >&2
    return
  fi

  local -a args=(--force --deep --sign "${identity}")

  if [[ -n "${codesign_keychain}" && "${identity}" != "-" ]]; then
    args+=(--keychain "${codesign_keychain}")
  fi

  if [[ "${identity}" != "-" ]]; then
    args+=(--options runtime)
  fi

  run_with_codesign_keychain "${codesign_keychain}" \
    codesign "${args[@]}" "${app_path}" >/dev/null

  if [[ "${identity}" == "-" ]]; then
    echo "Signed ${app_path} with ad-hoc identity." >&2
  else
    echo "Signed ${app_path} with ${identity}" >&2
  fi
}

app_name="Cursor Motion.app"
bundle_identifier="com.ifuryst.cursormotion"
bundle_version="${CURSOR_MOTION_BUNDLE_VERSION:-${GITHUB_RUN_NUMBER:-$(git -C "${repo_root}" rev-list --count HEAD 2>/dev/null || echo 1)}}"
bundle_icon_name="CursorMotion.icns"
icon_master_png="${repo_root}/assets/app-icons/dothething-1024.png"
iconset_build_script="${repo_root}/scripts/build-apple-iconset.sh"
cursor_reference_source="${repo_root}/docs/references/codex-computer-use-reverse-engineering/assets/extracted-2026-04-19/official-software-cursor-window-252.png"
app_root="${output_dir}/${app_name}"
contents_dir="${app_root}/Contents"
macos_dir="${contents_dir}/MacOS"
resources_dir="${contents_dir}/Resources"
dmg_root="${output_dir}/dmg-root"
dmg_path="${output_dir}/CursorMotion-${version}.dmg"
icon_work_dir=""

rm -rf "${output_dir}"
mkdir -p "${macos_dir}" "${resources_dir}" "${dmg_root}"

cd "${repo_root}"

case "${arch_mode}" in
  native)
    cp "$(build_binary "" "")" "${macos_dir}/CursorMotion"
    ;;
  arm64)
    cp "$(build_binary "arm64-apple-macosx14.0" ".build/cursor-motion-arm64-${configuration}")" "${macos_dir}/CursorMotion"
    ;;
  x86_64)
    cp "$(build_binary "x86_64-apple-macosx14.0" ".build/cursor-motion-x86_64-${configuration}")" "${macos_dir}/CursorMotion"
    ;;
  universal)
    arm_binary="$(build_binary "arm64-apple-macosx14.0" ".build/cursor-motion-arm64-${configuration}")"
    x86_binary="$(build_binary "x86_64-apple-macosx14.0" ".build/cursor-motion-x86_64-${configuration}")"
    lipo -create -output "${macos_dir}/CursorMotion" "${arm_binary}" "${x86_binary}"
    ;;
esac

chmod +x "${macos_dir}/CursorMotion"

if [[ ! -f "${cursor_reference_source}" ]]; then
  echo "Missing cursor reference asset: ${cursor_reference_source}" >&2
  exit 1
fi

cp "${cursor_reference_source}" "${resources_dir}/official-software-cursor-window-252.png"

if [[ ! -f "${icon_master_png}" ]]; then
  echo "Missing icon master PNG: ${icon_master_png}" >&2
  exit 1
fi

if [[ ! -f "${iconset_build_script}" ]]; then
  echo "Missing iconset build script: ${iconset_build_script}" >&2
  exit 1
fi

cleanup() {
  if [[ -n "${icon_work_dir:-}" ]]; then
    rm -rf "${icon_work_dir}"
  fi
}
trap cleanup EXIT

icon_work_dir="$(mktemp -d "${TMPDIR:-/tmp}/cursor-motion-icon.XXXXXX")"
iconset_dir="${icon_work_dir}/CursorMotion.iconset"
mkdir -p "${iconset_dir}"
"${iconset_build_script}" "${icon_master_png}" "${iconset_dir}"
iconutil -c icns "${iconset_dir}" -o "${resources_dir}/${bundle_icon_name}"

cat > "${contents_dir}/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>CursorMotion</string>
  <key>CFBundleIconFile</key>
  <string>${bundle_icon_name}</string>
  <key>CFBundleIdentifier</key>
  <string>${bundle_identifier}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Cursor Motion</string>
  <key>CFBundleDisplayName</key>
  <string>Cursor Motion</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${bundle_version}</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
PLIST

plutil -lint "${contents_dir}/Info.plist" >/dev/null
codesign_app_bundle "${app_root}"

cp -R "${app_root}" "${dmg_root}/"
ln -s /Applications "${dmg_root}/Applications"

hdiutil create \
  -volname "Cursor Motion" \
  -srcfolder "${dmg_root}" \
  -ov \
  -format UDZO \
  "${dmg_path}" \
  >/dev/null

echo "${dmg_path}"

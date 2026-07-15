#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_DIR="$ROOT/artifacts"
RELEASE_DIR="$ROOT/release-zh"
PATCHED_APP="$ARTIFACT_DIR/Synara-zh-CN.app"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "此脚本仅支持 Apple Silicon Mac。"
  exit 1
fi

if ! grep -q 'installZhCnUiLocalization' "$ROOT/apps/web/src/main.tsx" || \
  ! grep -q 'What should we do in Grok?' "$ROOT/apps/web/src/localization/zhCN.ts"; then
  echo "汉化入口或核心词典缺失，已停止构建。"
  exit 1
fi

rm -rf "$PATCHED_APP" "$RELEASE_DIR"
mkdir -p "$ARTIFACT_DIR" "$RELEASE_DIR"

cd "$ROOT"
# The upstream package script invokes Node directly. Bun's workspace linker owns the
# prerelease Effect catalog dependencies, so execute the same upstream build script
# through Bun to keep its package resolution intact on this machine.
# `electron-builder` only emits the local macOS update manifest when it knows the
# repository slug. This does not publish anything (`--publish never` stays upstream's
# default); it simply lets the upstream finalizer validate the local zip it just built.
SYNARA_DESKTOP_OUTPUT_DIR="$RELEASE_DIR" \
SYNARA_DESKTOP_UPDATE_REPOSITORY="Emanuele-web04/synara" \
  bun scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64

ZIP_PATH="$(find "$RELEASE_DIR" -maxdepth 1 -type f -name 'Synara-*-arm64-mac.zip' -print -quit)"
if [[ -z "$ZIP_PATH" ]]; then
  ZIP_PATH="$(find "$RELEASE_DIR" -maxdepth 1 -type f -name '*.zip' -print -quit)"
fi
if [[ -z "$ZIP_PATH" ]]; then
  echo "未找到 macOS 更新压缩包，无法提取候选 App。"
  exit 1
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/synara-zh-build.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT
ditto -x -k "$ZIP_PATH" "$TMP_DIR"
BUILT_APP="$(find "$TMP_DIR" -maxdepth 2 -type d -name 'Synara.app' -print -quit)"
if [[ -z "$BUILT_APP" ]]; then
  echo "更新压缩包中未找到 Synara.app。"
  exit 1
fi

ditto "$BUILT_APP" "$PATCHED_APP"
codesign --force --deep --sign - "$PATCHED_APP"
codesign --verify --deep --strict --verbose=2 "$PATCHED_APP"

ASAR="$PATCHED_APP/Contents/Resources/app.asar"
if [[ ! -s "$ASAR" ]]; then
  echo "候选 App 缺少有效的 app.asar，已停止。"
  exit 1
fi

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PATCHED_APP/Contents/Info.plist")"
echo "已构建汉化候选 App：$PATCHED_APP"
echo "版本：$VERSION"

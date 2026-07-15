#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLED_APP="/Applications/Synara.app"
PATCHED_APP="$ROOT/artifacts/Synara-zh-CN.app"
BACKUP_APP="$ROOT/backup/Synara-original.app"

if [[ ! -d "$INSTALLED_APP" ]]; then
  echo "未找到已安装的 Synara：$INSTALLED_APP"
  exit 1
fi
if [[ ! -d "$PATCHED_APP" ]]; then
  echo "未找到候选 App；请先运行 scripts/build-synara-zh.sh。"
  exit 1
fi

installed_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$INSTALLED_APP/Contents/Info.plist")"
patched_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PATCHED_APP/Contents/Info.plist")"
if [[ "$installed_version" != "$patched_version" ]]; then
  echo "检测到 Synara 更新：$installed_version → $patched_version"
  echo "将以完整候选 App 替换旧版本；用户数据和中转 API 配置位于 ~/.synara，不会被覆盖。"
fi

if [[ ! -d "$BACKUP_APP" ]]; then
  mkdir -p "$(dirname "$BACKUP_APP")"
  ditto "$INSTALLED_APP" "$BACKUP_APP"
  echo "已保存唯一官方原始备份：$BACKUP_APP"
else
  echo "保留现有唯一原始备份：$BACKUP_APP"
fi

pkill -x Synara 2>/dev/null || true
for _ in {1..20}; do
  pgrep -x Synara >/dev/null || break
  sleep 0.25
done

STAGED_APP="${INSTALLED_APP}.new"
rm -rf "$STAGED_APP"
ditto "$PATCHED_APP" "$STAGED_APP"
codesign --verify --deep --strict --verbose=2 "$STAGED_APP"
rm -rf "$INSTALLED_APP"
mv "$STAGED_APP" "$INSTALLED_APP"
codesign --verify --deep --strict --verbose=2 "$INSTALLED_APP"

echo "已安装 Synara 简体中文版：$INSTALLED_APP"
echo "原始 App 备份：$BACKUP_APP"

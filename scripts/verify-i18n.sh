#!/usr/bin/env bash
# FILE: verify-i18n.sh
# Purpose: Quick sanity check for i18n locale files.
# Layer: Scripts
#
# Usage:
#   bash scripts/verify-i18n.sh
#
# Checks:
#   1. Both en.json and zh-CN.json are valid JSON
#   2. Counts total keys in each
#   3. Verifies same number of top-level sections

set -euo pipefail

cd "$(dirname "$0")/../apps/web/src/i18n/locales"

EN_FILE="en.json"
ZH_FILE="zh-CN.json"
HAS_ERROR=0

# ANSI colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

check_json() {
  local file="$1"
  if node -e "JSON.parse(require('fs').readFileSync('$file','utf8'))" 2>/dev/null; then
    echo -e "  ${GREEN}OK${NC}  $file is valid JSON"
    return 0
  else
    echo -e "  ${RED}FAIL${NC} $file is NOT valid JSON"
    return 1
  fi
}

count_keys() {
  local file="$1"
  node -e "
    const obj = JSON.parse(require('fs').readFileSync('$file','utf8'));
    const flatten = (o, p = '') =>
      Object.entries(o).flatMap(([k, v]) =>
        typeof v === 'string' ? [p + k] : flatten(v, p + k + '.')
      );
    console.log(flatten(obj).length);
  "
}

count_sections() {
  local file="$1"
  node -e "
    const obj = JSON.parse(require('fs').readFileSync('$file','utf8'));
    const sections = Object.keys(obj).filter(k => typeof obj[k] === 'object' && obj[k] !== null && !Array.isArray(obj[k]));
    console.log(sections.length);
  "
}

echo "============================================"
echo " i18n Locale Verification"
echo "============================================"
echo ""

# 1. Validate JSON
echo "[1/3] Validating JSON files..."
check_json "$EN_FILE" || HAS_ERROR=1
check_json "$ZH_FILE" || HAS_ERROR=1
echo ""

# 2. Count keys
echo "[2/3] Counting keys..."
EN_KEYS=$(count_keys "$EN_FILE")
ZH_KEYS=$(count_keys "$ZH_FILE")
echo "  en.json:    ${EN_KEYS} keys"
echo "  zh-CN.json: ${ZH_KEYS} keys"
echo ""

# 3. Compare section count
echo "[3/3] Comparing top-level sections..."
EN_SECTIONS=$(count_sections "$EN_FILE")
ZH_SECTIONS=$(count_sections "$ZH_FILE")
echo "  en.json:    ${EN_SECTIONS} sections"
echo "  zh-CN.json: ${ZH_SECTIONS} sections"

if [ "$EN_SECTIONS" -ne "$ZH_SECTIONS" ]; then
  echo -e "  ${RED}MISMATCH${NC} Section counts differ!"
  HAS_ERROR=1
else
  echo -e "  ${GREEN}MATCH${NC} Same number of top-level sections."
fi

# Show section names for manual comparison
echo ""
echo "  en.json sections:"
node -e "
  const obj = JSON.parse(require('fs').readFileSync('$EN_FILE','utf8'));
  Object.keys(obj).forEach(s => console.log('    - ' + s));
"

echo "  zh-CN.json sections:"
node -e "
  const obj = JSON.parse(require('fs').readFileSync('$ZH_FILE','utf8'));
  Object.keys(obj).forEach(s => console.log('    - ' + s));
"

echo ""
echo "============================================"
if [ "$HAS_ERROR" -eq 0 ]; then
  echo -e " ${GREEN}All checks passed.${NC}"
else
  echo -e " ${RED}Some checks failed.${NC}"
fi
echo "============================================"
exit "$HAS_ERROR"

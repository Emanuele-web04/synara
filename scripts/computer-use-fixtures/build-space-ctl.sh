#!/bin/sh
# Build the space-ctl helper used for managed-Space isolation probes.
set -eu
cd "$(dirname "$0")/../.."
mkdir -p /private/tmp/synara-cua-implementation
/usr/bin/clang -fobjc-arc -O2 -o /private/tmp/synara-cua-implementation/space-ctl \
  scripts/computer-use-fixtures/space_ctl.m \
  -framework CoreFoundation
echo "space-ctl build ok"

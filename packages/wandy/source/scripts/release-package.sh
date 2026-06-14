#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dist_dir="${repo_root}/dist"
release_dir="${dist_dir}/release"
staging_dir="${release_dir}/private-package-staging"
tarball_dir="${release_dir}/private-package"
build_args=(--configuration release --arch universal)

usage() {
  cat <<'EOF'
Usage: ./scripts/release-package.sh [--skip-build]

Build a private Synara package tarball for @t3tools/wandy.
Use --skip-build when dist/ already contains the native runtime artifacts.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build)
      build_args+=(--skip-build)
      shift
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

rm -rf "${release_dir}"
mkdir -p "${tarball_dir}"

node "${repo_root}/scripts/npm/build-packages.mjs" \
  "${build_args[@]}" \
  --out-dir "${staging_dir}"

while IFS= read -r package_dir; do
  npm pack "${package_dir}" --pack-destination "${tarball_dir}" >/dev/null
done < <(find "${staging_dir}" -mindepth 1 -maxdepth 1 -type d | sort)

python3 - "${release_dir}/release-manifest.json" "${repo_root}" "${tarball_dir}" <<'PY'
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

manifest_path = Path(sys.argv[1])
repo_root = Path(sys.argv[2])
tarball_dir = Path(sys.argv[3])

artifacts = []
for tarball in sorted(tarball_dir.glob("*.tgz")):
    artifacts.append({
        "name": tarball.name,
        "size_bytes": tarball.stat().st_size,
    })

git_sha = os.environ.get("GITHUB_SHA")
if not git_sha:
    try:
        git_sha = subprocess.check_output(
            ["git", "-C", str(repo_root), "rev-parse", "HEAD"],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except Exception:
        git_sha = "unknown"

manifest = {
    "repository": os.environ.get("GITHUB_REPOSITORY", "local"),
    "git_sha": git_sha,
    "generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "artifacts": artifacts,
    "distribution": {
        "type": "private-synara-package",
        "package_count": len(artifacts),
        "staging_dir": str(tarball_dir.relative_to(repo_root)),
        "public_publish": False,
    },
}

manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
PY

echo "${release_dir}"

// FILE: verify-release-source-provenance.ts
// Purpose: Fail closed unless release version/ref/commit/lockfile identify one committed source.
// Layer: Release preflight

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { serializeReleaseGithubOutput } from "./lib/release-github-output.ts";
import { releasePackageFiles } from "./update-release-package-versions.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [version, tag, publishRelease, expectedCommit, refType, refName] = process.argv.slice(2);

if (!version || !tag || !publishRelease || !expectedCommit) {
  throw new Error(
    "Usage: node scripts/verify-release-source-provenance.ts <version> <tag> <publish:true|false> <expected-commit> [ref-type] [ref-name]",
  );
}
if (publishRelease !== "true" && publishRelease !== "false") {
  throw new Error(`Invalid publication mode: ${publishRelease}`);
}
if (!/^[0-9a-f]{40}$/i.test(expectedCommit)) {
  throw new Error(`Expected a full 40-character source commit, got ${expectedCommit}.`);
}

const gitHead = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
});
if (gitHead.status !== 0) {
  throw new Error(`Unable to resolve release HEAD: ${gitHead.stderr.trim() || "git failed"}`);
}
const sourceCommit = gitHead.stdout.trim().toLowerCase();
if (sourceCommit !== expectedCommit.toLowerCase()) {
  throw new Error(`Release HEAD ${sourceCommit} does not match workflow commit ${expectedCommit}.`);
}

const gitStatus = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
  cwd: repoRoot,
  encoding: "utf8",
});
if (gitStatus.status !== 0) {
  throw new Error(`Unable to inspect release worktree: ${gitStatus.stderr.trim() || "git failed"}`);
}
if (gitStatus.stdout.trim().length > 0) {
  throw new Error(
    "Release source worktree is not clean; provenance must name committed bytes only.",
  );
}

for (const relativePath of releasePackageFiles) {
  const packageJson = JSON.parse(readFileSync(resolve(repoRoot, relativePath), "utf8")) as {
    version?: string;
  };
  if (packageJson.version !== version) {
    throw new Error(
      `${relativePath} version ${packageJson.version ?? "<missing>"} does not match release ${version}. Commit the aligned version before running the release.`,
    );
  }
}

let sourceTag = "";
if (refType === "tag" && refName === tag) {
  const tagCommitResult = spawnSync("git", ["rev-parse", `${tag}^{commit}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (tagCommitResult.status !== 0) {
    throw new Error(`Unable to resolve release tag ${tag}.`);
  }
  const tagCommit = tagCommitResult.stdout.trim().toLowerCase();
  if (tagCommit !== sourceCommit) {
    throw new Error(`Release tag ${tag} points to ${tagCommit}, not ${sourceCommit}.`);
  }
  sourceTag = tag;
} else if (publishRelease === "true") {
  throw new Error(
    `Publishing requires the workflow ref to be the exact release tag ${tag}; got ${refType || "<none>"}/${refName || "<none>"}.`,
  );
}

const lockfileSha256 = createHash("sha256")
  .update(readFileSync(resolve(repoRoot, "bun.lock")))
  .digest("hex");

const output = {
  source_commit: sourceCommit,
  source_tag: sourceTag,
  lockfile_sha256: lockfileSha256,
};
const githubOutput = process.env.GITHUB_OUTPUT;
if (githubOutput) {
  appendFileSync(githubOutput, serializeReleaseGithubOutput(output));
} else {
  console.log(JSON.stringify(output, null, 2));
}

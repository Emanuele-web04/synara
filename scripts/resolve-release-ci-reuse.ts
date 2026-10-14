import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { findReleaseCiRun, hasVerifiedReleaseCi } from "./lib/release-ci-reuse.ts";

function readGithubApi(path: string): unknown {
  return JSON.parse(
    execFileSync("gh", ["api", path], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    }),
  );
}

const sourceCommit = process.env.SOURCE_COMMIT ?? "";
const repository = process.env.GITHUB_REPOSITORY ?? "";
const output = process.env.GITHUB_OUTPUT;
if (!output) throw new Error("GITHUB_OUTPUT is required.");
let green = false;
if (/^[a-f0-9]{40}$/.test(sourceCommit) && /^[\w.-]+\/[\w.-]+$/.test(repository)) {
  try {
    const runsPath = `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sourceCommit}&event=push&branch=main&per_page=100`;
    const run = findReleaseCiRun(readGithubApi(runsPath), sourceCommit);
    if (run) {
      const jobs = readGithubApi(
        `repos/${repository}/actions/runs/${run.id}/attempts/${run.attempt}/jobs?per_page=100`,
      );
      // A rerun or newer run may have started while its job evidence was read.
      // Refreshed run metadata must still match every job's run and attempt.
      green = hasVerifiedReleaseCi(readGithubApi(runsPath), sourceCommit, jobs);
    }
  } catch {
    // An unavailable API or malformed response must run the release gates.
  }
}
appendFileSync(output, `green=${green}\n`);
console.log(
  green
    ? `CI passed for exact source ${sourceCommit}; reusing quality gates.`
    : "No verified CI for the exact source; running quality gates.",
);

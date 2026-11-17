// FILE: wait-for-release-job.ts
// Purpose: Blocks a release job until one named job of this run attempt has
//          completed successfully. Uses only Node built-ins, so it can run
//          before or after dependency installation.
// Usage: node scripts/wait-for-release-job.ts --job "<exact job name>" [--timeout-minutes 85]
import { parseArgs } from "node:util";
import { githubRunAttemptJobs, waitForReleaseJob } from "./lib/release-job-wait.ts";

const { values } = parseArgs({
  options: {
    job: { type: "string" },
    "timeout-minutes": { type: "string", default: "85" },
  },
});
const jobName = values.job?.trim();
if (!jobName) throw new Error("--job is required.");
const timeoutMinutes = Number(values["timeout-minutes"]);
if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0)
  throw new Error(`Invalid --timeout-minutes: ${values["timeout-minutes"]}`);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

await waitForReleaseJob({
  jobName,
  listJobs: githubRunAttemptJobs({
    apiUrl: process.env.GITHUB_API_URL?.trim() || "https://api.github.com",
    repository: required("GITHUB_REPOSITORY"),
    runId: required("GITHUB_RUN_ID"),
    runAttempt: required("GITHUB_RUN_ATTEMPT"),
    token: required("GH_TOKEN"),
    fetch: (url, init) => fetch(url, init),
  }),
  timeoutMs: timeoutMinutes * 60_000,
  pollIntervalMs: 10_000,
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: console.log,
});

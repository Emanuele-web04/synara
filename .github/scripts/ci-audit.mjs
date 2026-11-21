// FILE: ci-audit.mjs
// Purpose: Splits every job of the most recent ci.yml runs into waiting, setup
//          and running time, at p50 and p95, so CI changes start from numbers.
//          Blocked (run created to job created) is reported beside them.
// Layer: Maintainer tool. Reads the GitHub API through the `gh` CLI; no writes.
// Usage: node .github/scripts/ci-audit.mjs [--runs=150] [--workflow=ci.yml] [--steps] [--json]

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Steps that prepare a runner rather than check the change. */
const SETUP_STEP =
  /^(Set up job|Checkout|Detect code changes|Setup workspace|Setup Node|Setup Bun|Restore |Cache |Save |Fingerprint |Wait for Chromium cache|Install browser test runtime|Configure Electron sandbox helper|Post |Complete job)/;
const DAY = 86_400;

const seconds = (iso) => (iso ? Date.parse(iso) / 1000 : null);

export function percentile(values, p) {
  if (values.length === 0) return Number.NaN;
  const sorted = values.toSorted((a, b) => a - b);
  const rank = (sorted.length - 1) * p;
  const low = Math.floor(rank);
  const high = Math.min(low + 1, sorted.length - 1);
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

/**
 * One job's buckets in seconds. Waiting is created to started (runner queue).
 * Setup is the sum of preparation steps. Running is the rest of the job, taken
 * from the job's own clock so overlapping `parallel` members are not counted twice.
 */
export function splitJob(job) {
  const created = seconds(job.created_at);
  const started = seconds(job.started_at);
  const completed = seconds(job.completed_at);
  if (created === null || started === null || completed === null) return null;
  // Background steps overlap the step after them, so count the union of the
  // setup intervals rather than their sum.
  const intervals = [];
  for (const step of job.steps ?? []) {
    const from = seconds(step.started_at);
    const to = seconds(step.completed_at);
    // The API reports placeholder timestamps for some skipped steps.
    if (from === null || to === null || to < from || to - from > DAY) continue;
    if (SETUP_STEP.test(step.name)) intervals.push([from, to]);
  }
  let setup = 0;
  let covered = Number.NEGATIVE_INFINITY;
  for (const [from, to] of intervals.toSorted((a, b) => a[0] - b[0])) {
    if (to <= covered) continue;
    setup += to - Math.max(from, covered);
    covered = to;
  }
  const total = completed - started;
  return {
    waiting: Math.max(0, started - created),
    setup: Math.min(setup, total),
    running: Math.max(0, total - setup),
    total,
  };
}

/** Aggregates runs into per-job percentiles plus whole-run wall time. */
export function audit(runs) {
  const jobs = new Map();
  const steps = new Map();
  const wall = { pull_request: [], push: [] };
  const runnerSeconds = [];
  for (const run of runs) {
    const first = run.run_attempt === 1;
    const runCreated = seconds(run.created_at);
    if (first && run.conclusion === "success" && wall[run.event])
      wall[run.event].push(seconds(run.updated_at) - runCreated);
    let spent = 0;
    for (const job of run.jobs) {
      if (job.conclusion !== "success" && job.conclusion !== "failure") continue;
      const split = splitJob(job);
      if (!split) continue;
      const name = job.name.replaceAll(/\s+/g, " ");
      const entry = jobs.get(name) ?? {
        blocked: [],
        waiting: [],
        setup: [],
        running: [],
        total: [],
      };
      for (const bucket of ["waiting", "setup", "running", "total"])
        entry[bucket].push(split[bucket]);
      // Blocked is run created to job created: time spent behind `needs` or
      // scheduling. A rerun keeps the run's original creation time, so only
      // first attempts count.
      if (first) entry.blocked.push(Math.max(0, seconds(job.created_at) - runCreated));
      jobs.set(name, entry);
      spent += split.total;
      for (const step of job.steps ?? []) {
        const from = seconds(step.started_at);
        const to = seconds(step.completed_at);
        if (from === null || to === null || to < from || to - from > DAY) continue;
        const key = `${name} :: ${step.name}`;
        steps.set(key, [...(steps.get(key) ?? []), to - from]);
      }
    }
    if (run.conclusion === "success" && spent > 0) runnerSeconds.push(spent);
  }
  const summary = (values) => ({
    n: values.length,
    p50: Math.round(percentile(values, 0.5)),
    p95: Math.round(percentile(values, 0.95)),
  });
  return {
    runs: runs.length,
    wall: { pull_request: summary(wall.pull_request), push: summary(wall.push) },
    runnerSecondsPerSuccessfulRun: summary(runnerSeconds),
    jobs: [...jobs]
      .map(([name, entry]) => ({
        name,
        n: entry.total.length,
        blocked: summary(entry.blocked),
        waiting: summary(entry.waiting),
        setup: summary(entry.setup),
        running: summary(entry.running),
        total: summary(entry.total),
      }))
      .toSorted((a, b) => b.total.p50 - a.total.p50),
    steps: [...steps]
      .map(([name, values]) => Object.assign({ name }, summary(values)))
      .filter((step) => step.p50 >= 3)
      .toSorted((a, b) => a.name.localeCompare(b.name)),
  };
}

function gh(path) {
  return JSON.parse(
    execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }),
  );
}

function fetchRuns(workflow, count) {
  const runs = [];
  for (let page = 1; runs.length < count; page += 1) {
    const batch = gh(
      `repos/{owner}/{repo}/actions/workflows/${workflow}/runs?per_page=100&page=${page}`,
    ).workflow_runs;
    if (batch.length === 0) break;
    runs.push(...batch);
  }
  runs.length = Math.min(runs.length, count);
  for (const run of runs)
    run.jobs = gh(`repos/{owner}/{repo}/actions/runs/${run.id}/jobs?per_page=100`).jobs;
  return runs;
}

const pair = (value) => `${value.p50} / ${value.p95}`.padStart(11);

function print(result, withSteps) {
  console.log(`${result.runs} runs. Seconds, p50 / p95.\n`);
  for (const event of ["pull_request", "push"])
    console.log(
      `${event} result, successful first attempts (n=${result.wall[event].n}): ${pair(result.wall[event]).trim()}`,
    );
  console.log(
    `Runner-seconds per successful run: ${pair(result.runnerSecondsPerSuccessfulRun).trim()}\n`,
  );
  console.log(
    `${"Job".padEnd(52)}    n     Blocked     Waiting       Setup     Running       Total`,
  );
  for (const job of result.jobs)
    console.log(
      `${job.name.slice(0, 52).padEnd(52)} ${String(job.n).padStart(4)} ${pair(job.blocked)} ${pair(job.waiting)} ${pair(job.setup)} ${pair(job.running)} ${pair(job.total)}`,
    );
  if (!withSteps) return;
  console.log("\nSteps with a median of 3 s or more");
  for (const step of result.steps)
    console.log(`${step.name.slice(0, 96).padEnd(96)} ${pair(step)}`);
}

const flag = (name, fallback) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = audit(fetchRuns(flag("workflow", "ci.yml"), Number(flag("runs", "150"))));
  if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else print(result, process.argv.includes("--steps"));
}

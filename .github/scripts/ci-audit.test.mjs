import assert from "node:assert/strict";
import { test } from "node:test";

import { audit, percentile, splitJob } from "./ci-audit.mjs";

const at = (second) => new Date(Date.UTC(2026, 10, 21, 0, 0, second)).toISOString();
const step = (name, from, to) => ({ name, started_at: at(from), completed_at: at(to) });
const job = (overrides = {}) => ({
  name: "Unit Tests (web)",
  conclusion: "success",
  created_at: at(10),
  started_at: at(14),
  completed_at: at(114),
  steps: [
    step("Set up job", 14, 16),
    step("Checkout", 16, 22),
    step("Setup workspace", 22, 40),
    step("Parallel group", 40, 110),
    step("Test (web)", 40, 110),
    step("Post Checkout", 110, 114),
  ],
  ...overrides,
});

test("a job splits into waiting, setup and running without counting parallel members twice", () => {
  assert.deepEqual(splitJob(job()), { waiting: 4, setup: 30, running: 70, total: 100 });
});
test("a background setup step that overlaps the next one is counted once", () => {
  const steps = [
    step("Checkout", 14, 20),
    step("Restore Chromium headless shell", 20, 26),
    step("Setup workspace", 21, 40),
    step("Browser test", 40, 114),
  ];
  assert.deepEqual(splitJob(job({ steps })), { waiting: 4, setup: 26, running: 74, total: 100 });
});
test("placeholder step timestamps and unfinished jobs are ignored", () => {
  const skipped = { name: "Cache Turbo", started_at: "0001-01-01T00:00:00Z", completed_at: at(30) };
  assert.equal(splitJob(job({ steps: [...job().steps, skipped] })).setup, 30);
  assert.equal(splitJob(job({ completed_at: null })), null);
});
test("percentiles interpolate and blocked time only counts first attempts", () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([10], 0.95), 10);
  const run = (attempt, conclusion = "success") => ({
    event: "pull_request",
    conclusion,
    run_attempt: attempt,
    created_at: at(0),
    updated_at: at(120),
    jobs: [job(), job({ name: "Skipped lane", conclusion: "skipped" })],
  });
  const result = audit([run(1), run(2), run(1, "failure")]);
  assert.deepEqual(result.wall.pull_request, { n: 1, p50: 120, p95: 120 });
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].n, 3);
  assert.deepEqual(result.jobs[0].blocked, { n: 2, p50: 10, p95: 10 });
  assert.deepEqual(result.runnerSecondsPerSuccessfulRun, { n: 2, p50: 100, p95: 100 });
});

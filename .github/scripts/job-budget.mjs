// FILE: job-budget.mjs
// Purpose: Fails a CI job that finished its work but took longer than its budget,
//          so a slow lane is a red lane instead of a habit.
// Layer: Last step of every ci.yml job; the first step records CI_JOB_STARTED.
// Usage: CI_JOB_STARTED=<epoch s> CI_JOB_BUDGET_SECONDS=<n> node .github/scripts/job-budget.mjs

import { pathToFileURL } from "node:url";

/**
 * A run that had to rebuild its dependency archive measures the install, not
 * the lane, so it is reported without failing. Anything unreadable fails: a
 * budget that cannot be evaluated must not pass silently.
 */
export function checkBudget({ started, budget, now, coldCache }) {
  if (!Number.isFinite(started) || started <= 0)
    return { ok: false, message: "CI_JOB_STARTED is missing: the job clock step did not run." };
  if (!Number.isFinite(budget) || budget <= 0)
    return { ok: false, message: "CI_JOB_BUDGET_SECONDS is missing or not a positive number." };
  const elapsed = Math.round(now - started);
  const summary = `${elapsed} s of a ${budget} s budget`;
  if (elapsed <= budget) return { ok: true, elapsed, message: `Within budget: ${summary}.` };
  if (coldCache)
    return {
      ok: true,
      elapsed,
      message: `Over budget on a cold ${coldCache} cache, not enforced: ${summary}.`,
    };
  return {
    ok: false,
    elapsed,
    message: `Over budget: ${summary}. Make the job faster; raise the budget only with measurements (.github/CI.md).`,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = checkBudget({
    started: Number(process.env.CI_JOB_STARTED),
    budget: Number(process.env.CI_JOB_BUDGET_SECONDS),
    now: Date.now() / 1000,
    coldCache: process.env.CI_COLD_CACHE || "",
  });
  console.log(result.ok ? result.message : `::error title=Job budget::${result.message}`);
  process.exit(result.ok ? 0 : 1);
}

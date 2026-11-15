// FILE: ci-budget.ts
// Purpose: Fails a CI step or job that exceeds its time budget, so CI stays
//          fast instead of slowly regressing.
// Layer: .github/workflows/ci.yml.
// Usage:
//   node scripts/ci-budget.ts run <seconds> -- <command...>
//       Runs the command; stops it and fails once it exceeds <seconds>.
//   node scripts/ci-budget.ts since <seconds> <label>
//       Fails when more than <seconds> passed since the job's first step
//       wrote CI_BUDGET_START (epoch seconds) to $GITHUB_ENV.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export function overBudget(elapsedSeconds: number, budgetSeconds: number): boolean {
  return elapsedSeconds > budgetSeconds;
}

function fail(message: string): never {
  // GitHub annotation, so the overrun shows on the run summary.
  console.error(`::error title=Over budget::${message}`);
  process.exit(1);
}

function parseBudget(value: string | undefined): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) fail(`invalid budget "${value}"`);
  return seconds;
}

async function runWithin(budget: number, command: readonly string[]): Promise<void> {
  if (command.length === 0) fail("missing command after --");
  const started = performance.now();
  const child = spawn(command[0]!, command.slice(1), { stdio: "inherit", shell: false });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  }, budget * 1_000);
  const code = await new Promise<number>((resolve) => {
    child.on("error", (error) => {
      console.error(error.message);
      resolve(1);
    });
    child.on("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
  });
  clearTimeout(timer);
  const elapsed = (performance.now() - started) / 1_000;
  console.log(`ci-budget: ${command.join(" ")} took ${elapsed.toFixed(1)} s of ${budget} s`);
  if (timedOut || overBudget(elapsed, budget))
    fail(`\`${command.join(" ")}\` exceeded its ${budget} s budget (${elapsed.toFixed(1)} s)`);
  if (code !== 0) process.exit(code);
}

function since(budget: number, label: string): void {
  const start = Number(process.env.CI_BUDGET_START);
  if (!Number.isFinite(start) || start <= 0)
    fail("CI_BUDGET_START is not set by the job's first step");
  const elapsed = Date.now() / 1_000 - start;
  console.log(`ci-budget: ${label} after ${elapsed.toFixed(1)} s of ${budget} s`);
  if (overBudget(elapsed, budget))
    fail(`${label} exceeded its ${budget} s budget (${elapsed.toFixed(1)} s)`);
}

async function main() {
  const [mode, seconds, ...rest] = process.argv.slice(2);
  const budget = parseBudget(seconds);
  if (mode === "run") return runWithin(budget, rest[0] === "--" ? rest.slice(1) : rest);
  if (mode === "since") return since(budget, rest.join(" ") || "job");
  fail(`unknown mode "${mode}"; expected run or since`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

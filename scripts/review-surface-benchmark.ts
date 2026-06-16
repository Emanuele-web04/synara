// FILE: review-surface-benchmark.ts
// Purpose: Runs the review surface browser benchmark repeatedly and summarizes proof metrics.
// Layer: Developer performance verification script.
// Depends on: apps/web benchmark:review.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface ReviewBenchmarkMetrics {
  readonly inputRows: number;
  readonly naiveRows: number;
  readonly optimizedRows: number;
  readonly mountedRowReduction: number;
  readonly naiveElapsedMs: number;
  readonly optimizedElapsedMs: number;
  readonly listCalls: number;
  readonly viewerCalls: number;
}

interface MetricSummary {
  readonly min: number;
  readonly median: number;
  readonly max: number;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = resolve(repoRoot, "apps/web");
const BENCHMARK_PREFIX = "[benchmark] review surface board";
const BENCHMARK_PATTERN = /^\[benchmark\] review surface board (\{.*\})$/m;

function parseIterations(args: ReadonlyArray<string>): number {
  const runsFlagIndex = args.findIndex((arg) => arg === "--runs" || arg === "-r");
  const raw =
    runsFlagIndex >= 0
      ? args[runsFlagIndex + 1]
      : args.find((arg) => !arg.startsWith("-"));
  if (!raw) return 7;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer iteration count, got ${raw}.`);
  }
  return parsed;
}

function parseBenchmarkMetrics(output: string): ReviewBenchmarkMetrics {
  const matches = [...output.matchAll(new RegExp(BENCHMARK_PATTERN, "gm"))];
  if (matches.length === 0) {
    throw new Error(`Benchmark output did not include ${BENCHMARK_PREFIX}.`);
  }
  if (matches.length > 1) {
    throw new Error(`Benchmark output included ${String(matches.length)} benchmark payloads.`);
  }
  const payload = matches[0]?.[1];
  if (!payload) {
    throw new Error("Benchmark output did not include a JSON payload.");
  }
  return JSON.parse(payload) as ReviewBenchmarkMetrics;
}

function runBenchmarkOnce(index: number): ReviewBenchmarkMetrics {
  const result = spawnSync("bun", ["run", "benchmark:review"], {
    cwd: webRoot,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `Benchmark iteration ${String(index)} failed with status ${String(result.status)}.\n${result.stdout}${result.stderr}`,
    );
  }
  return parseBenchmarkMetrics(result.stdout);
}

function summarize(values: ReadonlyArray<number>): MetricSummary {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
  return {
    min: sorted[0]!,
    median,
    max: sorted[sorted.length - 1]!,
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

const iterations = parseIterations(process.argv.slice(2));
const runs: ReviewBenchmarkMetrics[] = [];

for (let index = 1; index <= iterations; index += 1) {
  const metrics = runBenchmarkOnce(index);
  runs.push(metrics);
  console.log(
    `run ${String(index)}/${String(iterations)}: ${round(metrics.mountedRowReduction)}x rows, ${String(metrics.optimizedRows)} mounted, ${String(metrics.listCalls)} list call, ${String(metrics.viewerCalls)} viewer calls`,
  );
}

const summary = {
  iterations,
  inputRows: runs[0]?.inputRows ?? 0,
  naiveRows: summarize(runs.map((run) => run.naiveRows)),
  optimizedRows: summarize(runs.map((run) => run.optimizedRows)),
  mountedRowReduction: summarize(runs.map((run) => run.mountedRowReduction)),
  naiveElapsedMs: summarize(runs.map((run) => run.naiveElapsedMs)),
  optimizedElapsedMs: summarize(runs.map((run) => run.optimizedElapsedMs)),
  listCalls: summarize(runs.map((run) => run.listCalls)),
  viewerCalls: summarize(runs.map((run) => run.viewerCalls)),
};

console.log(JSON.stringify(summary, null, 2));

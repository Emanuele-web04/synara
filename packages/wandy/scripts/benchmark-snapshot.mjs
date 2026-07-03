#!/usr/bin/env node
/**
 * Quick wandy snapshot timing benchmark (macOS).
 * Usage: node packages/wandy/scripts/benchmark-snapshot.mjs [appName]
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const binary = path.join(packageRoot, "dist/Wandy.app/Contents/MacOS/Wandy");
const app = process.argv[2]?.trim() || "Safari";

function callTool(tool, args) {
  const started = performance.now();
  const result = spawnSync(binary, ["call", tool, "--args", JSON.stringify(args)], {
    encoding: "utf8",
    env: {
      ...process.env,
      WANDY_DISABLE_APP_AGENT_PROXY: "1",
    },
  });
  const elapsedMs = performance.now() - started;
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`);
  }
  return elapsedMs;
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

const getAppStateSamples = [];
for (let i = 0; i < 5; i += 1) {
  getAppStateSamples.push(callTool("get_app_state", { app }));
}

console.log(`wandy benchmark — app=${app}`);
console.log(
  `get_app_state x5: p50=${percentile(getAppStateSamples, 50).toFixed(0)}ms p95=${percentile(getAppStateSamples, 95).toFixed(0)}ms samples=${getAppStateSamples.map((v) => v.toFixed(0)).join(", ")}`,
);

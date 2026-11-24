// Seeds the data home the web-boot measurements restore before every sample:
// <data>/template (SYNARA_HOME) and <data>/workspaces (project folders, server cwd).
//
//   node benchmarks/web-boot/seed.mjs --data <dir> [--repo <checkout>] [--shape <json>]
//
// Uses benchmarks/desktop-perf/seed-home.ts, which writes through the server's own
// orchestration engine and refuses real Synara data homes. It must run from inside a
// checkout's apps/server, so it is copied to apps/server/.bench/ and removed afterwards.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { HARNESS_REPO } from "./lib.mjs";

const DEFAULT_SHAPE = {
  projects: 6,
  largeThreads: [400, 120, 120],
  smallThreads: 80,
  smallThreadMessages: 20,
  toolCallsPerAssistantMessage: 2,
};
const { values } = parseArgs({
  options: {
    data: { type: "string" },
    repo: { type: "string", default: HARNESS_REPO },
    shape: { type: "string", default: JSON.stringify(DEFAULT_SHAPE) },
  },
});
if (!values.data) {
  console.error("usage: --data <dir> [--repo <checkout>] [--shape <json>]");
  process.exit(2);
}
const data = path.resolve(values.data);
const template = path.join(data, "template");
const workspaces = path.join(data, "workspaces");
if (existsSync(template)) throw new Error(`${template} exists; remove it to reseed`);
mkdirSync(template, { recursive: true });
mkdirSync(workspaces, { recursive: true });

const serverDir = path.join(path.resolve(values.repo), "apps/server");
const benchDir = path.join(serverDir, ".bench");
if (existsSync(benchDir)) throw new Error(`${benchDir} exists; refusing to overwrite it`);
mkdirSync(benchDir);
try {
  for (const file of ["seed-home.ts", "seed-realistic-threads.ts"]) {
    cpSync(path.join(HARNESS_REPO, "benchmarks/desktop-perf", file), path.join(benchDir, file));
  }
  const env = {
    ...process.env,
    BENCH_SEED_HOME: template,
    BENCH_SEED_WORKSPACES: workspaces,
    BENCH_SEED_SHAPE: values.shape,
  };
  delete env.SYNARA_AUTH_TOKEN;
  const result = spawnSync("bun", [".bench/seed-home.ts"], {
    cwd: serverDir,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`seed-home.ts exited with ${result.status}`);
} finally {
  rmSync(benchDir, { recursive: true, force: true });
}
console.log(`seeded ${template}`);

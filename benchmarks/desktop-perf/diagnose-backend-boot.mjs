#!/usr/bin/env node
// Headless diagnostic: starts only the backend (the same Electron-as-Node runtime and
// bundle the desktop app spawns) on a copy of the seeded home, times spawn -> first
// healthy /health answer, and summarizes a CPU profile of that boot by source file.
// No window is opened. Web mode is used because desktop mode needs the parent's pipes.
//   node benchmarks/desktop-perf/diagnose-backend-boot.mjs --build main [--runs 5]
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildInfo, templateInfo, useTemplateSet } from "./lib/builds.mjs";
import { sleep } from "./lib/cdp.mjs";
import { BENCH_ROOT, assertIsolatedHome, freePort, resolveElectronBinary } from "./lib/launch.mjs";
import { footprintMb } from "./lib/metrics.mjs";
import { median } from "./lib/stats.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const value = (name, fallback) =>
  args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback;
const build = buildInfo(value("build", "main"));
useTemplateSet(value("template-set", "default"));
const runs = Number(value("runs", "5"));
const root = join(BENCH_ROOT, "homes", "backend-boot");
assertIsolatedHome(root);
const electron = resolveElectronBinary(build.dir);
const entry = join(build.dir, "apps/server/dist/index.mjs");

async function boot({ profileDir, extraEnv = {}, settleSeconds = 0 }) {
  rmSync(join(root, "home"), { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  cpSync(templateInfo("seeded").home, join(root, "home"), { recursive: true });
  const port = await freePort();
  const startedAt = performance.now();
  const child = spawn(
    electron,
    [...(profileDir ? ["--cpu-prof", `--cpu-prof-dir=${profileDir}`] : []), entry],
    {
      cwd: join(build.dir, "apps/server"),
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        USER: process.env.USER,
        TMPDIR: process.env.TMPDIR,
        LANG: "en_US.UTF-8",
        ELECTRON_RUN_AS_NODE: "1",
        SYNARA_HOME: join(root, "home"),
        SYNARA_PORT: String(port),
        SYNARA_MODE: "web",
        SYNARA_NO_BROWSER: "1",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const marks = {};
  let buffer = "";
  const onData = (chunk) => {
    buffer += chunk;
    const at = Math.round(performance.now() - startedAt);
    if (marks.firstOutputMs === undefined) marks.firstOutputMs = at;
    if (marks.migrationsMs === undefined && buffer.includes("Running all migrations"))
      marks.migrationsMs = at;
    if (marks.projectionsMs === undefined && buffer.includes("projection pipeline bootstrapped"))
      marks.projectionsMs = at;
    if (marks.listeningLogMs === undefined && buffer.includes("Listening on http://"))
      marks.listeningLogMs = at;
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  let exited = false;
  child.on("exit", () => (exited = true));
  while (!exited && performance.now() - startedAt < 60_000) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) {
        marks.healthMs ??= Math.round(performance.now() - startedAt);
        const body = await response.json().catch(() => null);
        if (body?.startupReady !== false) {
          marks.startupReadyMs = Math.round(performance.now() - startedAt);
          break;
        }
      }
    } catch {}
    await sleep(10);
  }
  await sleep(300);
  if (settleSeconds > 0) {
    // Memory of the backend alone, with no window connected to it.
    await sleep(settleSeconds * 1000);
    marks.footprintMbNoClient =
      Math.round((footprintMb([child.pid]).get(child.pid) ?? 0) * 10) / 10;
  }
  child.kill("SIGTERM");
  for (let index = 0; index < 100 && !exited; index += 1) await sleep(100);
  if (!exited) child.kill("SIGKILL");
  if (marks.healthMs === undefined) marks.failed = buffer.slice(-600);
  return marks;
}

const out = {
  build: { name: build.name, commit: build.commit, version: build.version },
  at: new Date().toISOString(),
  runtime: "Electron as Node, apps/server/dist/index.mjs, web mode, seeded home copy",
};
const plain = [];
for (let index = 0; index < runs; index += 1) plain.push(await boot({}));
out.boot = {
  samples: plain,
  medianHealthMs: median(plain.map((sample) => sample.healthMs).filter(Number.isFinite)),
  medianMigrationsLogMs: median(plain.map((sample) => sample.migrationsMs).filter(Number.isFinite)),
};

out.memoryWithoutClient = await boot({ settleSeconds: 30 });

// One profiled boot: self time by file, and by package for node_modules.
const profileDir = join(root, "profile");
rmSync(profileDir, { recursive: true, force: true });
mkdirSync(profileDir, { recursive: true });
out.profiledBoot = await boot({ profileDir });
const file = readdirSync(profileDir).find((name) => name.endsWith(".cpuprofile"));
if (file) {
  const profile = JSON.parse(readFileSync(join(profileDir, file), "utf8"));
  const selfMicros = new Map();
  const total = profile.timeDeltas.reduce((sum, delta) => sum + delta, 0);
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  profile.samples.forEach((id, index) =>
    selfMicros.set(id, (selfMicros.get(id) ?? 0) + (profile.timeDeltas[index] ?? 0)),
  );
  const groups = new Map();
  const functions = new Map();
  for (const [id, micros] of selfMicros) {
    const frame = byId.get(id).callFrame;
    const url = frame.url || `(${frame.functionName || "native"})`;
    const group = url.includes("/node_modules/")
      ? `node_modules/${url
          .split("/node_modules/")
          .at(-1)
          .split("/")
          .slice(0, url.split("/node_modules/").at(-1).startsWith("@") ? 2 : 1)
          .join("/")}`
      : url.replace(build.dir, "").replace(/^file:\/\//, "");
    groups.set(group, (groups.get(group) ?? 0) + micros);
    const name = `${frame.functionName || "(anonymous)"} ${group}`;
    functions.set(name, (functions.get(name) ?? 0) + micros);
  }
  const top = (map, count) =>
    [...map]
      .sort((a, b) => b[1] - a[1])
      .slice(0, count)
      .map(([name, micros]) => ({ name: name.slice(0, 110), ms: Math.round(micros / 1000) }));
  out.profile = {
    profiledMs: Math.round(total / 1000),
    bySource: top(groups, 22),
    byFunction: top(functions, 22),
  };
}
rmSync(root, { recursive: true, force: true });
const target = join(
  HERE,
  "results",
  `diagnose-${out.at.replace(/[:.]/g, "-")}-${build.name}-backend-boot.json`,
);
// Print first: the profile directory is already gone, so a failed write must not lose
// the measurements. The results directory is git-ignored and may not exist yet.
console.log(JSON.stringify(out, null, 1));
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(out, null, 1)}\n`);
console.log(`\nsaved: ${target}`);
process.exit(0);

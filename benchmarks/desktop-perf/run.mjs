#!/usr/bin/env node
// One command -> one results file.
//   node benchmarks/desktop-perf/run.mjs --build main [--build <other>] [--label baseline]
//        [--suites startup,idle,switch,load,longchat] [--runs 5] [--max-attempts 10] [--template-set default]
//        [--allow-locked-screen]
// Builds are prepared first with prepare.mjs. With several --build flags the samples
// alternate (A, B, B, A, ...) so both builds see the same machine state over time.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildInfo,
  clearChromiumCaches,
  freshHomeFromTemplate,
  removeHome,
  templateInfo,
  useTemplateSet,
} from "./lib/builds.mjs";
import { waitForQuietMac } from "./lib/launch.mjs";
import { machineIdentity, machineState } from "./lib/metrics.mjs";
import { gap, summarize } from "./lib/stats.mjs";
import {
  LONGCHAT_PLAN,
  measureIdle,
  measureLoad,
  measureLongChat,
  measureSwitching,
  SWITCH_PLAN,
} from "./lib/tests-session.mjs";
import { measureLaunch } from "./lib/tests-startup.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const values = (name) =>
  args.flatMap((arg, index) => (arg === `--${name}` ? [args[index + 1]] : []));
const builds = values("build").map(buildInfo);
if (builds.length === 0) {
  console.error(
    "usage: run.mjs --build <name> [--build <name>] [--label <label>] [--suites startup,idle,switch,load,longchat] [--runs 5]",
  );
  process.exit(1);
}
const runs = Number(values("runs")[0] ?? 5);
const suites = (values("suites")[0] ?? "startup,idle,switch,load").split(",");
const maxAttempts = Number(values("max-attempts")[0] ?? runs * 2);
useTemplateSet(values("template-set")[0] ?? "default");
if (args.includes("--allow-locked-screen")) process.env.BENCH_ALLOW_LOCKED_SCREEN = "1";
const startedAt = new Date();
const label = values("label")[0] ?? "run";
const runId = `desktop-perf-${startedAt.toISOString().replace(/[:.]/g, "-")}-${label}`;
const outFile = join(HERE, "results", `${runId}.json`);
mkdirSync(dirname(outFile), { recursive: true });

const raw = Object.fromEntries(
  builds.map((build) => [
    build.name,
    { startup: [], idle: [], switching: [], load: [], longchat: [] },
  ]),
);
const log = (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
const order = (sample) => (sample % 2 === 0 ? builds : [...builds].reverse());

async function guarded(name, build, sample, run) {
  const state = machineState();
  try {
    const result = await run();
    return { sample, machineState: state, ...result };
  } catch (error) {
    log(`${name} ${build.name} #${sample + 1} FAILED: ${error.message.split("\n")[0]}`);
    return { sample, machineState: state, failed: error.message.split("\n")[0] };
  }
}

function save() {
  writeFileSync(outFile, `${JSON.stringify(report(), null, 1)}\n`);
}

// Each suite samples until `runs` valid samples exist or `maxAttempts` were made. An
// invalid or failed sample stays in the results with its cause; extra samples are added,
// none is replaced.
async function sampleSuite(name, key, measure, describe) {
  if (!suites.includes(name)) return;
  const valid = Object.fromEntries(builds.map((build) => [build.name, 0]));
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const pending = order(attempt).filter((build) => valid[build.name] < runs);
    if (pending.length === 0) break;
    for (const build of pending) {
      const quiet = await waitForQuietMac({ log });
      const record = await guarded(name, build, attempt, () => measure(build));
      record.waitedForQuietMac = quiet;
      const failed =
        record.failed ??
        Object.values(record).find(
          (value) => value && typeof value === "object" && typeof value.failed === "string",
        )?.failed ??
        null;
      if (!failed) valid[build.name] += 1;
      raw[build.name][key].push(record);
      log(
        `${name} ${build.name} #${attempt + 1} (${valid[build.name]}/${runs} valid): ${failed ? `FAILED ${failed}` : describe(record)}`,
      );
      save();
    }
  }
}

await sampleSuite(
  "startup",
  "startup",
  async (build) => {
    const home = freshHomeFromTemplate("seeded");
    const cachesCleared = clearChromiumCaches(home.profile);
    const cold = await measureLaunch({ build, home, expectTranscript: true });
    const relaunch = await measureLaunch({ build, home, expectTranscript: true });
    const empty = await measureLaunch({
      build,
      home: freshHomeFromTemplate("empty"),
      expectTranscript: false,
    });
    return { dataHome: "seeded + empty templates", cachesCleared, cold, relaunch, empty };
  },
  (record) =>
    `cold ${record.cold.typingMs} ms, relaunch ${record.relaunch.typingMs} ms, empty ${record.empty.typingMs} ms`,
);

await sampleSuite(
  "idle",
  "idle",
  async (build) => ({
    dataHome: "seeded template",
    ...(await measureIdle({ build, home: freshHomeFromTemplate("seeded") })),
  }),
  (record) =>
    `app ${record.memory.appMb} MB, total ${record.memory.totalMb} MB, cpu front ${record.front.cpu.appPercent}% covered ${record.covered.cpu.appPercent}%`,
);

await sampleSuite(
  "switch",
  "switching",
  async (build) => ({
    dataHome: "seeded template",
    ...(await measureSwitching({ build, home: freshHomeFromTemplate("seeded") })),
  }),
  (record) =>
    `first open 1400 ${Math.round(record.cold["large-1400"].bottomMs)} ms, switch back ${Math.round(record.warm["large-1400"].bottomMs)} ms, scroll gaps ${record.scroll.framesOver33ms}`,
);

// Opt-in (not in the default list): needs a template set made with --realistic.
await sampleSuite(
  "longchat",
  "longchat",
  async (build) => ({
    dataHome: "seeded template with realistic long threads",
    ...(await measureLongChat({ build, home: freshHomeFromTemplate("seeded") })),
  }),
  (record) =>
    `agent-heavy first open ${Math.round(record.threads["agent-heavy"].cold.bottomMs)} ms, fling p95 ${record.threads["agent-heavy"].fling.frameP95Ms} ms`,
);

await sampleSuite(
  "load",
  "load",
  async (build) => ({
    dataHome: "seeded template",
    ...(await measureLoad({ build, home: freshHomeFromTemplate("seeded") })),
  }),
  (record) =>
    `streaming total ${record.memoryWhileStreaming.totalMb} MB, typing p95 ${record.typing.p95Ms} ms, per thread ${record.totalMbPerThreadWithSession} MB`,
);

removeHome();
save();
log(`results: ${outFile}`);
process.exit(0);

function tests(name) {
  const data = raw[name];
  const out = {};
  const ok = (records) => records.filter((record) => !record.failed);
  const add = (key, records, read, unit) => {
    if (records.length === 0) return;
    out[key] = summarize(
      records.map((record) => {
        if (record.failed) return null;
        try {
          const value = read(record);
          return typeof value === "number" && Number.isFinite(value) ? value : null;
        } catch {
          return null;
        }
      }),
      unit,
    );
    const causes = records.filter((record) => record.failed).map((record) => record.failed);
    if (causes.length > 0) out[key].failedCauses = causes;
  };
  // A startup sample is three launches; one invalid launch invalidates the whole sample.
  const sampleFailure = (record) =>
    record.failed ?? record.cold?.failed ?? record.relaunch?.failed ?? record.empty?.failed ?? null;
  const launch = (phase) =>
    data.startup.map((record) => ({ ...record[phase], failed: sampleFailure(record) }));
  if (suites.includes("startup")) {
    add("A1/cold", launch("cold"), (r) => r.typingMs / 1000, "s");
    add("A1/cold-first-paint", launch("cold"), (r) => r.firstPaintMs, "ms");
    add("A2/relaunch", launch("relaunch"), (r) => r.typingMs / 1000, "s");
    add("A2/relaunch-first-paint", launch("relaunch"), (r) => r.firstPaintMs, "ms");
    add("A2/relaunch-sidebar", launch("relaunch"), (r) => r.sidebarRowsMs, "ms");
    add("A2/relaunch-empty-home", launch("empty"), (r) => r.typingMs / 1000, "s");
    add("Q1/quit-right-after-start", launch("relaunch"), (r) => r.quitMs, "ms");
    add(
      "A9/processes-left-after-quit",
      [...launch("cold"), ...launch("relaunch")],
      (r) => r.survivorsAfterQuit,
      "processes",
    );
  }
  if (suites.includes("idle")) {
    const idle = data.idle;
    add("A5/total", idle, (r) => r.memory.totalMb, "MB");
    add("A5/app", idle, (r) => r.memory.appMb, "MB");
    for (const role of ["main", "renderer", "gpu", "backend", "utility:NetworkService"])
      add(`A5/${role}`, idle, (r) => r.memory.byRole[role] ?? 0, "MB");
    add("A5/helpers-and-providers", idle, (r) => r.memory.totalMb - r.memory.appMb, "MB");
    add("A5/processes", idle, (r) => r.memory.processCount, "processes");
    add("A6/front", idle, (r) => r.front.cpu.appPercent, "% CPU");
    add("A6/covered", idle, (r) => r.covered.cpu.appPercent, "% CPU");
    for (const role of ["main", "renderer", "gpu", "backend"]) {
      add(`A6/front-${role}`, idle, (r) => r.front.cpu.byRolePercent[role] ?? 0, "% CPU");
      add(`A6/covered-${role}`, idle, (r) => r.covered.cpu.byRolePercent[role] ?? 0, "% CPU");
    }
    add("W1/front-wakeups", idle, (r) => r.front.wakeups.wakeupsPerSecond, "wake-ups/s");
    add("W1/covered-wakeups", idle, (r) => r.covered.wakeups.wakeupsPerSecond, "wake-ups/s");
    for (const role of ["backend", "renderer", "gpu", "main"]) {
      add(
        `W1/front-wakeups-${role}`,
        idle,
        (r) => r.front.wakeups.byRolePerSecond[role] ?? 0,
        "wake-ups/s",
      );
    }
    add("G1/gpu-process-cpu-front", idle, (r) => r.front.cpu.byRolePercent.gpu ?? 0, "% CPU");
    add("G1/gpu-process-cpu-covered", idle, (r) => r.covered.cpu.byRolePercent.gpu ?? 0, "% CPU");
    add("G2/gpu-process-memory", idle, (r) => r.memory.byRole.gpu ?? 0, "MB");
    add(
      "G3/system-gpu-before-launch",
      idle,
      (r) => r.gpuSystemBeforeLaunchPercent.median,
      "% device utilization",
    );
    add(
      "G3/system-gpu-front",
      idle,
      (r) => r.front.gpuSystemUtilizationPercent.median,
      "% device utilization",
    );
    add(
      "G3/system-gpu-covered",
      idle,
      (r) => r.covered.gpuSystemUtilizationPercent.median,
      "% device utilization",
    );
    add("Q2/quit-after-idle", idle, (r) => r.quit.quitMs, "ms");
    const hidden = ok(idle).filter((r) => r.coveredState?.visibility === "hidden").length;
    out["A6/covered-window-reported-hidden"] = {
      median: hidden,
      min: hidden,
      max: hidden,
      runs: ok(idle).length,
      unit: `runs of ${ok(idle).length}`,
    };
  }
  if (suites.includes("switch")) {
    const switching = data.switching;
    for (const [size] of SWITCH_PLAN.cold) {
      add(
        `A11/open-first-${size}`,
        switching,
        (r) => r.cold[size].bottomMs ?? r.cold[size].firstRowMs,
        "ms",
      );
      add(`A11/open-first-${size}-first-row`, switching, (r) => r.cold[size].firstRowMs, "ms");
    }
    for (const [size] of SWITCH_PLAN.warm)
      add(
        `T1/switch-back-${size}`,
        switching,
        (r) => r.warm[size].bottomMs ?? r.warm[size].firstRowMs,
        "ms",
      );
    add("A11/scroll-gaps", switching, (r) => r.scroll.framesOver33ms, "frames over 33 ms");
    add("A11/scroll-frame-p95", switching, (r) => r.scroll.frameP95Ms, "ms");
    add("G4/gpu-process-cpu-scrolling", switching, (r) => r.scroll.gpuProcessCpuPercent, "% CPU");
    add("T2/renderer-cpu-scrolling", switching, (r) => r.scroll.rendererCpuPercent, "% CPU");
    add(
      "A10/mb-per-viewed-thread",
      switching,
      (r) => r.appMbPerViewedThread,
      "MB (renderer + backend + main)",
    );
    add(
      "G2/gpu-process-memory-after-scroll",
      switching,
      (r) => r.memoryAfterScroll.byRole.gpu ?? 0,
      "MB",
    );
  }
  if (suites.includes("longchat")) {
    const longchat = data.longchat;
    for (const [name] of LONGCHAT_PLAN.threads) {
      add(`LC1/open-first-${name}`, longchat, (r) => r.threads[name].cold.bottomMs, "ms");
      add(`LC2/switch-back-${name}`, longchat, (r) => r.threads[name].warm.bottomMs, "ms");
      add(`LC3/scroll-frame-p95-${name}`, longchat, (r) => r.threads[name].scroll.frameP95Ms, "ms");
      add(
        `LC3/scroll-gaps-${name}`,
        longchat,
        (r) => r.threads[name].scroll.framesOver33ms,
        "frames over 33 ms",
      );
      add(`LC4/fling-frame-p95-${name}`, longchat, (r) => r.threads[name].fling.frameP95Ms, "ms");
      add(
        `LC4/fling-gaps-${name}`,
        longchat,
        (r) => r.threads[name].fling.framesOver33ms,
        "frames over 33 ms",
      );
    }
  }
  if (suites.includes("load")) {
    const load = data.load;
    add("A7/total-while-streaming", load, (r) => r.memoryWhileStreaming.totalMb, "MB");
    add("A7/app-while-streaming", load, (r) => r.memoryWhileStreaming.appMb, "MB");
    add("A7/rss-total-p95", load, (r) => r.rssTotalMb.p95, "MB (RSS, counts shared pages)");
    add("A7/rss-total-peak", load, (r) => r.rssTotalMb.peak, "MB (RSS, counts shared pages)");
    add("A8/p95", load, (r) => r.typing.p95Ms, "ms");
    add("A8/median", load, (r) => r.typing.medianMs, "ms");
    add("A8/missed", load, (r) => r.typing.missed, "keystrokes of 60");
    add("A10/mb-per-thread", load, (r) => r.totalMbPerThreadWithSession, "MB");
    add("A10/app-mb-per-thread", load, (r) => r.appMbPerThreadWithSession, "MB");
    add("L1/cpu-while-streaming", load, (r) => r.cpuWhileStreaming.appPercent, "% CPU");
    add(
      "L1/renderer-cpu-while-streaming",
      load,
      (r) => r.cpuWhileStreaming.byRolePercent.renderer ?? 0,
      "% CPU",
    );
    add(
      "L1/backend-cpu-while-streaming",
      load,
      (r) => r.cpuWhileStreaming.byRolePercent.backend ?? 0,
      "% CPU",
    );
    add(
      "G5/gpu-process-cpu-while-streaming",
      load,
      (r) => r.cpuWhileStreaming.byRolePercent.gpu ?? 0,
      "% CPU",
    );
    add("L2/stream-duration", load, (r) => r.streamSeconds, "s");
  }
  out["packaged-app"] = gap(
    "not measured",
    "the harness launches source builds only; the packaged, signed app is not measured",
  );
  out["cold-after-reboot"] = gap(
    "not measured",
    "the OS file cache cannot be purged without sudo; cold here means Chromium disk caches cleared",
  );
  out["gpu-power"] = gap(
    "not measured",
    "powermetrics needs sudo; GPU is read as GPU-process CPU, GPU-process memory and system GPU utilization from ioreg",
  );
  return out;
}

function report() {
  const seeded = templateInfo("seeded");
  return {
    run: runId,
    measured: `${startedAt.toISOString()} to ${new Date().toISOString()}`,
    machine: machineIdentity(),
    conditions: (() => {
      const all = builds.flatMap((build) => Object.values(raw[build.name]).flat());
      const locked = all.filter((record) => record.machineState?.screenLocked).length;
      return {
        samplesWithScreenLocked: locked,
        samples: all.length,
        note:
          locked > 0
            ? "Samples taken with the screen locked: process-level readings are valid; readings that depend on drawing frames (front-window CPU and GPU, frame times, typing latency) are not representative."
            : "All samples were taken with the screen unlocked.",
      };
    })(),
    rule: "median of the valid samples; failed or invalid samples stay listed with their cause and are never replaced (extra samples are taken instead); gaps are never ranked",
    method: {
      suites,
      samplesPerMeasurement: runs,
      alternatingBuilds: builds.length > 1,
      dataHome: {
        templateSet: seeded.templateSet ?? "default",
        template: "seeded",
        contents: seeded.contents,
        lastRoute: seeded.lastRoute,
        createdWith: seeded.createdWith,
        launchedFrom: seeded.launchedFrom,
      },
      clock:
        "startup timings start when the Electron process is spawned and stop when two typed characters are in the composer",
      memory:
        "physical footprint per process from /usr/bin/footprint, summed over the app's process tree",
      cpu: "cumulative CPU time over a 60 s window, percent of one core, summed over the process tree",
      load: "real Claude Sonnet sessions started from the app's own composer; no stubs",
    },
    apps: builds.map((build) => ({
      id: build.name,
      name: `Synara ${build.version}`,
      version: `${build.version} (${build.commit.slice(0, 12)}, ${build.ref})`,
      buildType: build.buildType,
      tests: tests(build.name),
      raw: raw[build.name],
    })),
  };
}

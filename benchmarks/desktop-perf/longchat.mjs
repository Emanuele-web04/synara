#!/usr/bin/env node
// Long-chat suite, headless: opening, switching back to and scrolling long threads.
//
// Real backend in web mode + the build's production web bundle in headless Chromium
// (Playwright from the build). Runs with the screen locked and needs no window in front,
// so it fits CI and remote sessions. Input goes through the DevTools protocol.
//
// Valid: main-thread times (script, style, layout), long tasks, open latency, snapshot
// size and arrival, retained heap, CPU profiles. Not valid: frame times — headless
// Chromium rasterizes in software, so use run.mjs (suite "longchat") for frames on a GPU.
//
//   node benchmarks/desktop-perf/longchat.mjs --prepare-base --build main
//   node benchmarks/desktop-perf/longchat.mjs --build main [--build branch] [--runs 6]
//        [--label x] [--only small-38,agent-heavy] [--profile] [--capture] [--press-ms 80]
//        [--no-desktop-local]
//
// --prepare-base  copies the seeded template and appends the realistic long threads
//                 (seed-realistic-threads.ts) with that build, then migrates it once
// --build         one or two builds; with two, samples alternate A B B A ...
// --profile       adds a CPU profile per measurement (build with SYNARA_WEB_SOURCEMAP=hidden
//                 to resolve frames to source)
// --capture       writes each cold snapshot frame to <results>/frames/frame-<name>.json,
//                 the input of apps/web/perf/longChatDerivations.perf.test.ts
// --runs          samples per build (default 6: open timings are bimodal, 3 hide that)
// --no-desktop-local  measure as a plain browser. By default the page sets the declared
//                 local-backend switch (LOCAL_BACKEND_UNCOMPRESSED_STORAGE_KEY in
//                 apps/web/src/wsTransport.ts) before it loads, so a build that supports
//                 it connects like the desktop app to its own backend (feature socket
//                 without permessage-deflate). Builds without it ignore the key.
// --press-ms      time between pointerdown and pointerup on a sidebar row (default 80, a
//                 typical mouse click). Open timings start at pointerdown, so they include
//                 the press; work started on pointerdown overlaps it. 0 = instant click.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildInfo, seed, templateInfo, useTemplateSet } from "./lib/builds.mjs";
import { sleep } from "./lib/cdp.mjs";
import { createProfileSummarizer } from "./lib/cpuProfile.mjs";
import { bootHeadlessBackend } from "./lib/headlessBackend.mjs";
import { BENCH_ROOT } from "./lib/launch.mjs";
import { median, percentile } from "./lib/stats.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const value = (name, fallback) =>
  args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback;
const values = (name) =>
  args.flatMap((arg, index) => (arg === `--${name}` ? [args[index + 1]] : []));
const builds = (values("build").length > 0 ? values("build") : ["main"]).map(buildInfo);
useTemplateSet(value("template-set", "default"));
const BASE_HOME = join(BENCH_ROOT, "longchat", "home-base");
const RUN_HOME = join(BENCH_ROOT, "homes", "longchat-run");
const RESULTS_DIR = join(HERE, "results");

const LONGCHAT_THREADS = [
  ["small-38", "seed-thread-small-015"],
  ["prose-300", "real-thread-prose"],
  ["agent-mid", "real-thread-agent-mid"],
  ["agent-heavy", "real-thread-agent-heavy"],
  ["synthetic-1400", "seed-thread-large-01"],
];
// Mirrors LOCAL_BACKEND_UNCOMPRESSED_STORAGE_KEY (apps/web/src/wsTransport.ts).
const DESKTOP_LOCAL_STORAGE_KEY = "synara:local-backend-uncompressed";
const PARK_THREAD = "seed-thread-small-016";
const WARMUP_THREAD = "seed-thread-small-004";
const SEL = {
  composer: '[data-testid="composer-editor"]',
  scroller: '[data-chat-scroll-container="true"]',
  messageRow: "[data-message-id]",
  threadRow: (id) =>
    `li[data-thread-item="true"][data-thread-hover-anchor$=":${id}"] [role="button"]`,
};

if (args.includes("--prepare-base")) {
  const build = builds[0];
  rmSync(BASE_HOME, { recursive: true, force: true });
  mkdirSync(dirname(BASE_HOME), { recursive: true });
  cpSync(templateInfo("seeded").home, BASE_HOME, { recursive: true });
  const summary = seed(build, BASE_HOME, undefined, { mode: "append-realistic" });
  console.log(`[longchat] appended ${summary.threads} threads in ${summary.seconds}s`);
  const backend = await bootHeadlessBackend(build, BASE_HOME);
  console.log(`[longchat] base migrated and booted in ${backend.bootMs} ms`);
  await backend.stop();
  process.exit(0);
}
if (!existsSync(BASE_HOME)) {
  console.error(`Missing ${BASE_HOME}. Run longchat.mjs --prepare-base --build <name> first.`);
  process.exit(1);
}

// --- in-page probes ------------------------------------------------------------------
// From the pointerdown on a sidebar row: first new message row, bottom reached, layout
// settled (no scroll/height change for 700 ms) and long tasks in that window.
const OPEN_PROBE = (scrollerSelector, rowSelector) =>
  new Promise((resolve) => {
    const previous = new Set(
      [...document.querySelectorAll(rowSelector)].map((row) => row.dataset.messageId),
    );
    const longTasks = [];
    let observer = null;
    try {
      observer = new PerformanceObserver((list) => longTasks.push(...list.getEntries()));
      observer.observe({ type: "longtask" });
    } catch {
      // No long task timing in this browser.
    }
    window.addEventListener(
      "pointerdown",
      (event) => {
        const t0 = event.timeStamp;
        let firstRow = null;
        let bottom = null;
        let lastMove = performance.now();
        let lastGeometry = null;
        const tick = () => {
          const now = performance.now();
          const list = document.querySelector(scrollerSelector);
          if (firstRow === null) {
            for (const row of document.querySelectorAll(rowSelector)) {
              if (!previous.has(row.dataset.messageId)) {
                firstRow = now;
                break;
              }
            }
          }
          const geometry = list ? [list.scrollHeight, list.scrollTop] : [0, 0];
          if (
            !lastGeometry ||
            Math.abs(geometry[0] - lastGeometry[0]) > 8 ||
            Math.abs(geometry[1] - lastGeometry[1]) > 8
          ) {
            lastGeometry = geometry;
            lastMove = now;
          }
          if (
            bottom === null &&
            firstRow !== null &&
            list &&
            list.scrollHeight - list.scrollTop - list.clientHeight < 8
          ) {
            bottom = now;
          }
          if ((firstRow !== null && now - lastMove > 700) || now - t0 > 20_000) {
            observer?.disconnect();
            const tasks = longTasks.filter((task) => task.startTime >= t0 - 5);
            resolve({
              firstRowMs: firstRow === null ? null : firstRow - t0,
              bottomMs: bottom === null ? null : bottom - t0,
              settledMs: firstRow === null ? null : lastMove - t0,
              longTaskMs: tasks.reduce((sum, task) => sum + task.duration, 0),
              longTasks: tasks.map((task) => Math.round(task.duration)),
            });
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      { capture: true, once: true },
    );
  });

const DOM_STATS = (scrollerSelector) => {
  const list = document.querySelector(scrollerSelector);
  return {
    rowsMounted: list ? list.querySelectorAll("[data-timeline-row-kind]").length : 0,
    messageRows: list ? list.querySelectorAll("[data-message-id]").length : 0,
    scrollerNodes: list ? list.querySelectorAll("*").length : 0,
    documentNodes: document.querySelectorAll("*").length,
    scrollHeight: list?.scrollHeight ?? 0,
  };
};

const SCROLL_START = () => {
  const state = (window.__longchatScroll = { longTasks: [] });
  try {
    state.observer = new PerformanceObserver((list) =>
      state.longTasks.push(...list.getEntries().map((entry) => entry.duration)),
    );
    state.observer.observe({ type: "longtask" });
  } catch {
    // No long task timing in this browser.
  }
  return true;
};
const SCROLL_STOP = () => {
  const state = window.__longchatScroll;
  state.observer?.disconnect();
  return { longTasks: state.longTasks };
};

// Per frame: how much of the transcript viewport no mounted row covers (interior only).
const BLANK_START = (scrollerSelector) => {
  const state = (window.__longchatBlank = { samples: [], running: true });
  const tick = (now) => {
    if (!state.running) return;
    const list = document.querySelector(scrollerSelector);
    if (list) {
      const view = list.getBoundingClientRect();
      let covered = 0;
      for (const row of list.querySelectorAll("[data-timeline-row-kind]")) {
        const rect = row.getBoundingClientRect();
        covered += Math.max(0, Math.min(rect.bottom, view.bottom) - Math.max(rect.top, view.top));
      }
      const interior =
        list.scrollTop > 1500 && list.scrollHeight - list.scrollTop - list.clientHeight > 1500;
      state.samples.push([now, interior ? Math.max(0, 1 - covered / view.height) : -1]);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return true;
};
const BLANK_STOP = () => {
  const state = window.__longchatBlank;
  state.running = false;
  return state.samples;
};
const TO_BOTTOM = (scrollerSelector) => {
  const list = document.querySelector(scrollerSelector);
  if (list) list.scrollTop = list.scrollHeight;
  return list ? list.scrollHeight - list.scrollTop - list.clientHeight : null;
};

// --- driver --------------------------------------------------------------------------
const round = (number, digits = 1) =>
  number === null || number === undefined ? null : Math.round(number * 10 ** digits) / 10 ** digits;

async function readMetrics(cdp) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const pick = (name) => metrics.find((metric) => metric.name === name)?.value ?? 0;
  return {
    script: pick("ScriptDuration"),
    layout: pick("LayoutDuration"),
    style: pick("RecalcStyleDuration"),
    task: pick("TaskDuration"),
    heap: pick("JSHeapUsedSize"),
  };
}
const mainThread = (after, before) => ({
  scriptMs: round((after.script - before.script) * 1000),
  layoutMs: round((after.layout - before.layout) * 1000),
  styleMs: round((after.style - before.style) * 1000),
  taskMs: round((after.task - before.task) * 1000),
});

async function centerOf(page, selector, timeoutMs = 20_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const point = await page.evaluate((selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      element.scrollIntoView({ block: "center", inline: "nearest" });
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, selector);
    if (point) return point;
    await sleep(100);
  }
  throw new Error(`no element ${selector}`);
}

async function dismissDialogs(page) {
  // First-run dialogs and the feature tour stack one after another in a fresh browser
  // profile; keep closing until a sidebar row is the topmost element at its own centre.
  const labels = [
    "Skip intro",
    "Not now",
    "Skip tour",
    "Skip",
    "Maybe later",
    "Got it",
    "Done",
    "Close",
    "Dismiss sponsor banner",
  ];
  let quietSince = Date.now();
  const startedAt = Date.now();
  while (Date.now() - quietSince < 3000 && Date.now() - startedAt < 60_000) {
    const state = await page.evaluate((labels) => {
      const candidates = [
        ...document.querySelectorAll('button,[role="button"],[role="menuitem"],a'),
      ].filter((candidate) => candidate.getBoundingClientRect().width > 0);
      for (const label of labels) {
        const element = candidates.find(
          (candidate) =>
            (candidate.innerText || "").trim().startsWith(label) ||
            candidate.getAttribute("aria-label") === label,
        );
        if (element) {
          element.click();
          return { clicked: label };
        }
      }
      const closer = candidates.find(
        (candidate) =>
          /close|dismiss|skip/i.test(candidate.getAttribute("aria-label") ?? "") &&
          candidate.closest('[role="dialog"],[data-base-ui-portal]'),
      );
      if (closer) {
        closer.click();
        return { clicked: closer.getAttribute("aria-label") };
      }
      const row = document.querySelector('li[data-thread-item="true"] [role="button"]');
      const rect = row?.getBoundingClientRect();
      const top = rect
        ? document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        : null;
      return { blocked: !(row && top && row.contains(top)) };
    }, labels);
    if (state.clicked) {
      quietSince = Date.now();
      await sleep(700);
    } else if (state.blocked) {
      quietSince = Date.now();
      await page.keyboard.press("Escape");
      await sleep(500);
    } else {
      await sleep(250);
    }
  }
}

function createDriver({ page, cdp, ws, summarizeProfile, pressMs }) {
  const withProfile = async (enabled, run) => {
    if (enabled) await cdp.send("Profiler.start");
    const result = await run();
    if (!enabled) return result;
    const { profile } = await cdp.send("Profiler.stop");
    return { ...result, profile: summarizeProfile(profile) };
  };

  const openThread = (threadId, { profile = false } = {}) =>
    withProfile(profile, async () => {
      await centerOf(page, SEL.threadRow(threadId));
      await sleep(200);
      const point = await centerOf(page, SEL.threadRow(threadId));
      const probe = page.evaluate(
        `(${OPEN_PROBE.toString()})(${JSON.stringify(SEL.scroller)}, ${JSON.stringify(SEL.messageRow)})`,
      );
      await sleep(150);
      ws.reset();
      const before = await readMetrics(cdp);
      const pressedAt = performance.now();
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      if (pressMs > 0) await sleep(pressMs);
      await page.mouse.up();
      const result = await probe;
      const after = await readMetrics(cdp);
      const dom = await page.evaluate(`(${DOM_STATS.toString()})(${JSON.stringify(SEL.scroller)})`);
      if (!page.url().includes(threadId)) throw new Error(`route did not change to ${threadId}`);
      return {
        firstRowMs: round(result.firstRowMs),
        bottomMs: round(result.bottomMs),
        settledMs: round(result.settledMs),
        longTaskMs: round(result.longTaskMs),
        longTasks: result.longTasks,
        main: mainThread(after, before),
        wsReceivedKb: round(ws.bytes() / 1024),
        wsLargestFrameKb: round(ws.largest() / 1024),
        wsLargestFrameAfterPressMs:
          ws.largest() > 20_000 ? round(ws.largestAt() - pressedAt, 0) : null,
        dom,
        heapMb: round(after.heap / 1048576),
      };
    });

  const wheel = async (ticks, deltaPx) => {
    const point = await centerOf(page, SEL.scroller);
    await page.mouse.move(point.x, point.y);
    for (let index = 0; index < ticks; index += 1) {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: point.x,
        y: point.y,
        deltaX: 0,
        deltaY: -deltaPx,
      });
      await sleep(16);
    }
  };

  const scroll = ({ ticks, deltaPx, profile = false }) =>
    withProfile(profile, async () => {
      const before = await readMetrics(cdp);
      await page.evaluate(`(${SCROLL_START.toString()})()`);
      const startedAt = performance.now();
      await wheel(ticks, deltaPx);
      const drivenMs = performance.now() - startedAt;
      await sleep(600);
      const { longTasks } = await page.evaluate(`(${SCROLL_STOP.toString()})()`);
      const after = await readMetrics(cdp);
      const dom = await page.evaluate(`(${DOM_STATS.toString()})(${JSON.stringify(SEL.scroller)})`);
      return {
        ticks,
        deltaPx,
        drivenMs: round(drivenMs, 0),
        longTasks: longTasks.length,
        longTaskMs: round(longTasks.reduce((sum, duration) => sum + duration, 0)),
        main: mainThread(after, before),
        dom,
      };
    });

  const blank = async ({ ticks, deltaPx }) => {
    await page.evaluate(`(${BLANK_START.toString()})(${JSON.stringify(SEL.scroller)})`);
    await wheel(ticks, deltaPx);
    await sleep(700);
    const samples = (await page.evaluate(`(${BLANK_STOP.toString()})()`)).filter(
      (sample) => sample[1] >= 0,
    );
    return {
      interiorFrames: samples.length,
      framesBlankOver25pct: samples.filter((sample) => sample[1] > 0.25).length,
      framesBlankOver50pct: samples.filter((sample) => sample[1] > 0.5).length,
    };
  };

  const toBottom = async () => {
    for (let index = 0; index < 12; index += 1) {
      const remaining = await page.evaluate(
        `(${TO_BOTTOM.toString()})(${JSON.stringify(SEL.scroller)})`,
      );
      await sleep(250);
      if (remaining !== null && remaining < 4 && index > 1) break;
    }
    await sleep(700);
  };

  const heapAfterGc = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    await sleep(150);
    await cdp.send("HeapProfiler.collectGarbage");
    return (await readMetrics(cdp)).heap / 1048576;
  };

  return { openThread, scroll, blank, toBottom, heapAfterGc };
}

async function oneSample(build, sampleIndex, options) {
  rmSync(RUN_HOME, { recursive: true, force: true });
  mkdirSync(dirname(RUN_HOME), { recursive: true });
  cpSync(BASE_HOME, RUN_HOME, { recursive: true });
  const backend = await bootHeadlessBackend(build, RUN_HOME);
  const { chromium } = createRequire(join(build.dir, "apps/web/package.json"))("playwright");
  const browser = await chromium.launch({ headless: true, args: ["--enable-precise-memory-info"] });
  const record = {
    build: build.name,
    sample: sampleIndex,
    at: new Date().toISOString(),
    threads: {},
  };
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    if (options.desktopLocal) {
      await context.addInitScript((key) => {
        window.localStorage.setItem(key, "1");
      }, DESKTOP_LOCAL_STORAGE_KEY);
    }
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    for (const domain of ["Performance", "Profiler", "Network", "HeapProfiler"]) {
      await cdp.send(`${domain}.enable`);
    }
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    let bytes = 0;
    let largest = 0;
    let largestPayload = "";
    let largestAt = 0;
    cdp.on("Network.webSocketFrameReceived", (event) => {
      const payload = event.response?.payloadData ?? "";
      bytes += payload.length;
      if (payload.length > largest) {
        largest = payload.length;
        largestPayload = payload;
        largestAt = performance.now();
      }
    });
    const ws = {
      reset: () => ((bytes = 0), (largest = 0), (largestPayload = "")),
      bytes: () => bytes,
      largest: () => largest,
      largestAt: () => largestAt,
      payload: () => largestPayload,
    };
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error).slice(0, 200)));
    await page.goto(backend.url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(SEL.composer, { timeout: 90_000 });
    await sleep(4000);
    await dismissDialogs(page);
    await sleep(2000);
    await dismissDialogs(page);
    const driver = createDriver({
      page,
      cdp,
      ws,
      summarizeProfile: options.summarizeProfile,
      pressMs: options.pressMs,
    });
    // Warm-up: load the chat route's lazy chunks (markdown, highlighting) once, so the
    // first measured thread does not pay one-time code loading.
    await driver.openThread(WARMUP_THREAD);
    await sleep(1200);
    await driver.openThread(PARK_THREAD);
    await sleep(1200);
    for (const [name, threadId] of LONGCHAT_THREADS) {
      if (options.only && !options.only.includes(name)) continue;
      const entry = {};
      const heapBefore = await driver.heapAfterGc();
      // Cold: the thread's detail has never been loaded in this page.
      entry.cold = await driver.openThread(threadId, { profile: options.profile });
      if (options.capture) {
        mkdirSync(join(RESULTS_DIR, "frames"), { recursive: true });
        writeFileSync(join(RESULTS_DIR, "frames", `frame-${name}.json`), ws.payload());
      }
      await sleep(800);
      entry.retainedHeapMb = round((await driver.heapAfterGc()) - heapBefore);
      // Warm: leave to a small thread, come back.
      await driver.openThread(PARK_THREAD);
      await sleep(800);
      entry.warm = await driver.openThread(threadId, { profile: options.profile });
      await sleep(1500);
      if (name !== "small-38") {
        entry.scrollWheel = await driver.scroll({
          ticks: 90,
          deltaPx: 240,
          profile: options.profile,
        });
        await driver.toBottom();
        entry.scrollFling = await driver.scroll({
          ticks: 40,
          deltaPx: 1200,
          profile: options.profile,
        });
        await driver.toBottom();
        // Same distance again: every row on the way was measured by the previous pass.
        entry.scrollFlingRevisit = await driver.scroll({ ticks: 40, deltaPx: 1200 });
        await driver.toBottom();
        entry.blankFling = await driver.blank({ ticks: 40, deltaPx: 1200 });
        await driver.toBottom();
      }
      record.threads[name] = entry;
      console.error(
        `[${build.name} #${sampleIndex}] ${name}: cold bottom ${entry.cold.bottomMs} ms, script ${entry.cold.main.scriptMs} ms, snapshot ${entry.cold.wsLargestFrameKb} KB | warm bottom ${entry.warm.bottomMs} ms, script ${entry.warm.main.scriptMs} ms | fling script ${entry.scrollFling?.main.scriptMs ?? "-"} ms`,
      );
      await driver.openThread(PARK_THREAD);
      await sleep(600);
    }
    record.endHeapMb = round((await readMetrics(cdp)).heap / 1048576);
    record.errors = errors;
  } catch (error) {
    record.failed = String(error.stack ?? error).slice(0, 600);
    console.error(`[${build.name} #${sampleIndex}] FAILED ${record.failed}`);
  }
  await browser.close();
  await backend.stop();
  return record;
}

const runs = Number(value("runs", "6"));
const label = value("label", "longchat");
const options = {
  profile: args.includes("--profile"),
  capture: args.includes("--capture"),
  only: value("only")?.split(","),
  pressMs: Number(value("press-ms", "80")),
  desktopLocal: !args.includes("--no-desktop-local"),
};
const output = {
  suite: "longchat",
  label,
  method:
    "headless Chromium (Playwright) + real backend in web mode + production web bundle; software raster",
  options: { ...options, runs },
  builds: builds.map(({ name, version, commit }) => ({ name, version, commit })),
  samples: [],
};
mkdirSync(RESULTS_DIR, { recursive: true });
const outFile = join(
  RESULTS_DIR,
  `longchat-${new Date().toISOString().replace(/[:.]/g, "-")}-${label}.json`,
);
// Alternate builds (A B B A ...) so drift over the session spreads over both.
for (let index = 0; index < runs; index += 1) {
  const order = index % 2 === 0 ? builds : builds.toReversed();
  for (const build of order) {
    output.samples.push(
      await oneSample(build, index + 1, {
        ...options,
        summarizeProfile: createProfileSummarizer(build.dir),
      }),
    );
    writeFileSync(outFile, `${JSON.stringify(output, null, 1)}\n`);
  }
}
const coldBottom = (name) =>
  output.samples
    .filter((sample) => !sample.failed && sample.threads[name])
    .map((sample) => sample.threads[name].cold.bottomMs);
console.error(
  `[longchat] median cold bottom: ${LONGCHAT_THREADS.map(([name]) => `${name} ${median(coldBottom(name).filter((v) => v !== null)) ?? "-"}`).join(", ")} (p90 small-38 ${
    percentile(
      coldBottom("small-38").filter((v) => v !== null),
      0.9,
    ) ?? "-"
  })`,
);
console.log(outFile);

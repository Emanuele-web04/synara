#!/usr/bin/env node
// Diagnostic launches that explain where time and memory go. These are leads for a plan,
// not benchmark results: one or a few launches each, printed as JSON.
//   node benchmarks/desktop-perf/diagnose.mjs --build main --only timeline,quit,gpu-memory,backend-memory,compile-cache
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildInfo, freshHomeFromTemplate, removeHome, useTemplateSet } from "./lib/builds.mjs";
import { CdpSession, fetchJson, sleep, waitFor } from "./lib/cdp.mjs";
import { SELECTORS, elementCenter, openThreadFromSidebar, wheel } from "./lib/drive.mjs";
import {
  BENCH_ROOT,
  attachMainPage,
  freePort,
  launchDesktop,
  quitDesktop,
  waitForQuietMac,
} from "./lib/launch.mjs";
import { memorySnapshot } from "./lib/metrics.mjs";
import { median } from "./lib/stats.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const value = (name, fallback) =>
  args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback;
const build = buildInfo(value("build", "main"));
useTemplateSet(value("template-set", "default"));
const only = value("only", "timeline,quit,gpu-memory,backend-memory,compile-cache").split(",");
const out = {
  build: { name: build.name, commit: build.commit, version: build.version },
  at: new Date().toISOString(),
};
const now = () => performance.timeOrigin + performance.now();

function captureOutput(app) {
  const lines = [];
  let buffer = "";
  const onData = (chunk) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop();
    for (const text of parts)
      lines.push({ ms: Math.round(now() - app.spawnedAtEpochMs), text: text.slice(0, 300) });
  };
  app.child.stdout.on("data", onData);
  app.child.stderr.on("data", onData);
  return lines;
}

async function launch(extraEnv = {}) {
  const home = freshHomeFromTemplate("seeded");
  const app = launchDesktop({
    buildDir: build.dir,
    home: home.home,
    profile: home.profile,
    debugPort: await freePort(),
    extraEnv,
  });
  const lines = captureOutput(app);
  const { session } = await attachMainPage(app);
  return { app, session, lines };
}

const ready = (session) =>
  waitFor(
    () =>
      session.evaluate(
        `document.querySelectorAll(${JSON.stringify(SELECTORS.messageRow)}).length > 0`,
      ),
    { timeoutMs: 60_000, intervalMs: 20, label: "transcript" },
  );

// Startup timeline: main-process and backend log lines by arrival time, renderer network
// events (script chunks, WebSocket) and the visible marks, all relative to process spawn.
if (only.includes("timeline")) {
  await waitForQuietMac();
  const { app, session, lines } = await launch();
  const events = [];
  const mark = (name) => events.push({ ms: Math.round(now() - app.spawnedAtEpochMs), name });
  mark("devtools attached to window");
  session.on("Network.webSocketCreated", (params) =>
    mark(`websocket created ${params.url.split("?")[0]}`),
  );
  session.on("Network.webSocketHandshakeResponseReceived", () => mark("websocket handshake done"));
  session.on("Network.requestWillBeSent", (params) => {
    if (/\.(js|css)(\?|$)/.test(params.request.url))
      mark(`request ${params.request.url.split("/").at(-1).slice(0, 40)}`);
  });
  await session.send("Network.enable");
  await ready(session);
  mark("restored transcript on screen");
  await sleep(1500);
  const page = await session.evaluate(`({
    timeOrigin: performance.timeOrigin,
    firstContentfulPaint: performance.getEntriesByType("paint").find((entry) => entry.name === "first-contentful-paint")?.startTime ?? null,
    resources: performance.getEntriesByType("resource").filter((entry) => /\\.(js|css)$/.test(entry.name.split("?")[0])).map((entry) => ({ name: entry.name.split("/").at(-1), start: Math.round(entry.startTime), end: Math.round(entry.responseEnd), kb: Math.round((entry.decodedBodySize || 0) / 1024) })),
  })`);
  const offset = page.timeOrigin - app.spawnedAtEpochMs;
  out.timeline = {
    rendererTimeOriginMs: Math.round(offset),
    firstContentfulPaintMs:
      page.firstContentfulPaint === null ? null : Math.round(offset + page.firstContentfulPaint),
    scriptsAndStyles: page.resources
      .map((entry) => ({
        ...entry,
        start: Math.round(offset + entry.start),
        end: Math.round(offset + entry.end),
      }))
      .sort((a, b) => a.start - b.start),
    events,
    processLog: lines
      .filter(
        (line) =>
          /bootstrap|app ready|Listening on|migrat|startup|ready|window|backend/i.test(line.text) &&
          line.ms < 6000,
      )
      .slice(0, 80),
  };
  session.close();
  await quitDesktop(app);
}

// What the app does between SIGTERM and exit when it quits right after starting.
if (only.includes("quit")) {
  await waitForQuietMac();
  const { app, session, lines } = await launch();
  await ready(session);
  session.close();
  const quitAt = Math.round(now() - app.spawnedAtEpochMs);
  const quit = await quitDesktop(app);
  out.quit = {
    quitRequestedAtMs: quitAt,
    quitMs: quit.quitMs,
    logAfterQuit: lines
      .filter((line) => line.ms >= quitAt)
      .map((line) => ({ afterQuitMs: line.ms - quitAt, text: line.text }))
      .slice(0, 60),
  };
}

// GPU-process memory by Chromium's own accounting (memory-infra dump), with a small
// thread and after scrolling the 1,400-message thread.
async function memoryDump(app) {
  const version = await fetchJson(`http://127.0.0.1:${app.debugPort}/json/version`);
  const browser = await CdpSession.connect(version.webSocketDebuggerUrl);
  const collected = [];
  browser.on("Tracing.dataCollected", (params) => collected.push(...params.value));
  const done = new Promise((resolve) => browser.on("Tracing.tracingComplete", resolve));
  await browser.send("Tracing.start", {
    traceConfig: {
      includedCategories: ["disabled-by-default-memory-infra"],
      excludedCategories: ["*"],
      memoryDumpConfig: { triggers: [] },
    },
    transferMode: "ReportEvents",
  });
  await browser.send("Tracing.requestMemoryDump", { levelOfDetail: "detailed" });
  await browser.send("Tracing.end");
  await done;
  browser.close();
  const names = new Map();
  for (const event of collected)
    if (event.ph === "M" && event.name === "process_name") names.set(event.pid, event.args.name);
  const result = {};
  for (const event of collected) {
    if (event.ph !== "v" && event.ph !== "V") continue;
    const process = names.get(event.pid) ?? String(event.pid);
    const groups = (result[process] ??= {});
    for (const [name, dump] of Object.entries(event.args?.dumps?.allocators ?? {})) {
      const size = dump.attrs?.size?.value;
      if (!size) continue;
      const depth = name.split("/").length;
      if (depth > 2) continue;
      groups[name] = Math.round((parseInt(size, 16) / 1024 / 1024) * 10) / 10;
    }
  }
  for (const process of Object.keys(result)) {
    result[process] = Object.fromEntries(
      Object.entries(result[process])
        .filter(([, mb]) => mb >= 5)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 14),
    );
  }
  return result;
}
if (only.includes("gpu-memory")) {
  await waitForQuietMac();
  const { app, session } = await launch();
  await ready(session);
  await sleep(20_000);
  const atRest = { footprint: memorySnapshot(app).byRole, chromium: await memoryDump(app) };
  await openThreadFromSidebar(session, "seed-thread-large-01");
  await sleep(2500);
  const center = await elementCenter(session, SELECTORS.scroller);
  for (let index = 0; index < 90; index += 1) {
    await wheel(session, { ...center, deltaY: -240 });
    await sleep(16);
  }
  await sleep(5000);
  const afterScroll = { footprint: memorySnapshot(app).byRole, chromium: await memoryDump(app) };
  await sleep(60_000);
  const oneMinuteLater = { footprint: memorySnapshot(app).byRole };
  out.gpuMemory = {
    window: await session.evaluate(
      "({ width: innerWidth, height: innerHeight, devicePixelRatio })",
    ),
    atRest,
    afterScroll,
    oneMinuteLater,
  };
  session.close();
  await quitDesktop(app);
}

// Compositor layers of the idle window (size, memory, why each is a layer) and which
// layers repaint while nothing is happening.
if (only.includes("layers")) {
  await waitForQuietMac();
  const { app, session } = await launch();
  await ready(session);
  await sleep(15_000);
  let layers = [];
  const paints = new Map();
  session.on("LayerTree.layerTreeDidChange", (params) => {
    if (params.layers) layers = params.layers;
  });
  session.on("LayerTree.layerPainted", (params) =>
    paints.set(params.layerId, (paints.get(params.layerId) ?? 0) + 1),
  );
  await session.send("DOM.enable");
  await session.send("LayerTree.enable");
  await sleep(2000);
  paints.clear();
  const frames = await session.evaluate(
    `new Promise((resolve) => { let count = 0; const start = performance.now(); const tick = (now) => { count += 1; if (now - start >= 10000) resolve(count); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); })`,
  );
  const describe = async (layer) => {
    let node = null;
    if (layer.backendNodeId) {
      try {
        const { node: described } = await session.send("DOM.describeNode", {
          backendNodeId: layer.backendNodeId,
        });
        const attributes = described.attributes ?? [];
        const attribute = (name) => {
          const index = attributes.indexOf(name);
          return index === -1 ? "" : attributes[index + 1];
        };
        node =
          `${described.nodeName.toLowerCase()}${attribute("data-testid") ? `[data-testid=${attribute("data-testid")}]` : ""}${attribute("data-slot") ? `[data-slot=${attribute("data-slot")}]` : ""} .${attribute("class").split(/\s+/).slice(0, 6).join(".")}`.slice(
            0,
            160,
          );
      } catch {}
    }
    let reasons = [];
    try {
      reasons =
        (await session.send("LayerTree.compositingReasons", { layerId: layer.layerId }))
          .compositingReasonIds ?? [];
    } catch {}
    return {
      node,
      width: Math.round(layer.width),
      height: Math.round(layer.height),
      megapixels: Math.round((layer.width * layer.height) / 10000) / 100,
      drawsContent: layer.drawsContent,
      reasons,
      paintsIn10s: paints.get(layer.layerId) ?? 0,
    };
  };
  const described = [];
  for (const layer of layers) described.push(await describe(layer));
  const drawing = described.filter((layer) => layer.drawsContent);
  out.layers = {
    window: await session.evaluate(
      "({ width: innerWidth, height: innerHeight, devicePixelRatio })",
    ),
    note: "requestAnimationFrame frames counted for 10 s include the frames this probe itself requests; paintsIn10s shows which layers repainted on their own.",
    framesIn10s: frames,
    layerCount: layers.length,
    drawingLayerCount: drawing.length,
    drawingCssMegapixels:
      Math.round(drawing.reduce((total, layer) => total + layer.megapixels, 0) * 100) / 100,
    largest: drawing.toSorted((a, b) => b.megapixels - a.megapixels).slice(0, 25),
    repainting: described
      .filter((layer) => layer.paintsIn10s > 0)
      .toSorted((a, b) => b.paintsIn10s - a.paintsIn10s)
      .slice(0, 15),
    footprint: memorySnapshot(app).byRole,
  };
  session.close();
  await quitDesktop(app);
}

// The backend's own memory log line (heap, RSS, external) next to its footprint.
if (only.includes("backend-memory")) {
  await waitForQuietMac();
  const { app, session, lines } = await launch();
  await ready(session);
  await sleep(45_000);
  out.backendMemory = {
    footprint: memorySnapshot(app).byRole,
    serverMemoryLog: lines
      .filter((line) =>
        /server-memory|heapUsed|rssMb|max-old-space|cache_size|mmap/i.test(line.text),
      )
      .slice(-6),
    eventLoopLog: lines.filter((line) => /server-event-loop/.test(line.text)).slice(-2),
  };
  session.close();
  await quitDesktop(app);
}

// Node's on-disk compile cache for the main process and the backend: alternating
// relaunches with NODE_COMPILE_CACHE and with the cache disabled. The cache is filled by a first launch
// that is not counted.
if (only.includes("compile-cache")) {
  const cacheDir = join(BENCH_ROOT, "homes", "compile-cache");
  rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });
  const runs = Number(value("runs", "6"));
  const samples = { without: [], with: [] };
  const one = async (extraEnv) => {
    await waitForQuietMac();
    const home = freshHomeFromTemplate("seeded");
    const app = launchDesktop({
      buildDir: build.dir,
      home: home.home,
      profile: home.profile,
      debugPort: await freePort(),
      extraEnv,
    });
    const marks = {};
    try {
      const { session } = await attachMainPage(app);
      await ready(session);
      marks.transcriptMs = Math.round(now() - app.spawnedAtEpochMs);
      marks.sidebarMs = marks.transcriptMs;
      session.close();
    } finally {
      await quitDesktop(app);
    }
    return marks.transcriptMs;
  };
  await one({ NODE_COMPILE_CACHE: cacheDir });
  await one({ NODE_COMPILE_CACHE: cacheDir });
  for (let index = 0; index < runs; index += 1) {
    const order = index % 2 === 0 ? ["without", "with"] : ["with", "without"];
    for (const kind of order)
      // The control must really be uncached: a build that sets its own backend compile
      // cache would otherwise use it. NODE_DISABLE_COMPILE_CACHE turns Node's cache off.
      samples[kind].push(
        await one(
          kind === "with" ? { NODE_COMPILE_CACHE: cacheDir } : { NODE_DISABLE_COMPILE_CACHE: "1" },
        ),
      );
  }
  const { readdirSync, statSync } = await import("node:fs");
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).reduce(
      (total, entry) =>
        total +
        (entry.isDirectory() ? walk(join(dir, entry.name)) : statSync(join(dir, entry.name)).size),
      0,
    );
  out.compileCache = {
    measure: "spawn -> restored transcript on screen, ms (no typing step)",
    cacheBytes: walk(cacheDir),
    withoutMs: { median: median(samples.without), samples: samples.without },
    withMs: { median: median(samples.with), samples: samples.with },
  };
  rmSync(cacheDir, { recursive: true, force: true });
}

removeHome();
const file = join(
  HERE,
  "results",
  `diagnose-${out.at.replace(/[:.]/g, "-")}-${build.name}-${only.join("+")}.json`,
);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
console.log(JSON.stringify(out, null, 1));
console.log(`\nsaved: ${file}`);
process.exit(0);

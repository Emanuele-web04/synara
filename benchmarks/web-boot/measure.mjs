// Cold-boot measurement of production web builds. Per sample: restore the seeded home,
// start the variant's own server on it, open the app in a fresh browser context (empty
// HTTP cache) of one warm headless Chromium, wait, read the counters, stop the server.
// Variants alternate in rotating order. No provider sessions are started.
//
//   node benchmarks/web-boot/measure.mjs --data <dir> --out <file.json> \
//     --variant main=<main checkout> --variant V1=<checkout>@<dist> ... \
//     [--mode paint|network] [--rounds 12] [--cpu 1] [--network none|slow] \
//     [--port 3931] [--home seeded|empty] [--settle-ms <ms>]
//
// paint:   FCP, LCP candidates, DOMContentLoaded, load, long tasks (TBT = sum of the part
//          of each long task over 50 ms, over the whole settle window), splash removal,
//          resources started before FCP.
// network: the same page fields plus HTTP request counts and bytes from CDP Network,
//          the WebSocket RPC tags the page sent during boot, and every resource's
//          URL, start, end and size from Resource Timing.
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  NETWORK_PROFILES,
  assertPortFree,
  launchWarmBrowser,
  parseVariant,
  rotation,
  sleep,
  startServer,
} from "./lib.mjs";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    out: { type: "string" },
    variant: { type: "string", multiple: true },
    mode: { type: "string", default: "paint" },
    rounds: { type: "string", default: "12" },
    cpu: { type: "string", default: "1" },
    network: { type: "string", default: "none" },
    port: { type: "string", default: "3931" },
    home: { type: "string", default: "seeded" },
    "settle-ms": { type: "string" },
  },
});
if (!values.data || !values.out || !values.variant?.length) {
  console.error("usage: --data <dir> --out <file> --variant name=<checkout>[@<dist>] ...");
  process.exit(2);
}
const variants = values.variant.map(parseVariant);
const mode = values.mode;
const rounds = Number(values.rounds);
const cpu = Number(values.cpu);
const port = Number(values.port);
const network = NETWORK_PROFILES[values.network];
if (network === undefined) throw new Error(`unknown --network ${values.network}`);
if (mode !== "paint" && mode !== "network") throw new Error(`unknown --mode ${mode}`);
const settleMs = Number(values["settle-ms"] ?? 6000 * Math.max(1, cpu / 2));
assertPortFree(port);

function pageInstrumentation() {
  performance.setResourceTimingBufferSize(5000);
  const perf = { fcp: null, lcpEntries: [], longTasks: [], splashGoneMs: null };
  window.__perf = perf;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries())
      if (e.name === "first-contentful-paint") perf.fcp = e.startTime;
  }).observe({ type: "paint", buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      perf.lcpEntries.push({
        t: e.startTime,
        size: e.size,
        el: e.element
          ? `${e.element.tagName.toLowerCase()}.${String(e.element.className).slice(0, 60)}`
          : null,
      });
    }
  }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) perf.longTasks.push({ start: e.startTime, d: e.duration });
  }).observe({ type: "longtask", buffered: true });
  const watch = () => {
    let seen = false;
    const tick = () => {
      const present = document.querySelector(".app-boot-splash") !== null;
      if (present) seen = true;
      if (seen && !present && perf.splashGoneMs === null) {
        perf.splashGoneMs = performance.now();
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch);
  else watch();
}

function readPage(withResourceList) {
  const nav = performance.getEntriesByType("navigation")[0];
  const perf = window.__perf;
  const resources = performance.getEntriesByType("resource");
  const before = (t) => resources.filter((r) => t != null && r.startTime < t);
  const isJs = (r) => /\.m?js(\?|$)/.test(r.name);
  const isCss = (r) => /\.css(\?|$)/.test(r.name);
  return {
    ...perf,
    responseEnd: nav?.responseEnd ?? null,
    domInteractive: nav?.domInteractive ?? null,
    dcl: nav?.domContentLoadedEventEnd ?? null,
    load: nav?.loadEventEnd ?? null,
    resBeforeFcp: before(perf.fcp).length,
    jsBeforeFcp: before(perf.fcp).filter(isJs).length,
    cssBeforeFcp: before(perf.fcp).filter(isCss).length,
    jsBeforeSplashGone: before(perf.splashGoneMs).filter(isJs).length,
    resources: resources.length,
    resourceList: withResourceList
      ? resources.map((r) => ({
          url: r.name.replace(location.origin, ""),
          start: Math.round(r.startTime),
          end: Math.round(r.responseEnd),
          transfer: r.transferSize,
          decoded: r.decodedBodySize,
        }))
      : undefined,
  };
}

const browser = await launchWarmBrowser();

async function sample(variant) {
  const server = await startServer({ variant, data: values.data, port, homeKind: values.home });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await page.addInitScript(pageInstrumentation);
    const cdp = await context.newCDPSession(page);
    if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
    const net = {
      requests: 0,
      jsRequests: 0,
      cssRequests: 0,
      wireBytes: 0,
      decodedBytes: 0,
      wsIn: 0,
      wsOut: 0,
      rpcOut: {},
      dispatchTypes: {},
    };
    if (mode === "network" || network) {
      await cdp.send("Network.enable");
      if (network) await cdp.send("Network.emulateNetworkConditions", network);
    }
    if (mode === "network") {
      const httpIds = new Set();
      cdp.on("Network.requestWillBeSent", (e) => {
        if (!e.request.url.startsWith("http")) return;
        httpIds.add(e.requestId);
        net.requests += 1;
        if (/\.m?js(\?|$)/.test(e.request.url)) net.jsRequests += 1;
        if (/\.css(\?|$)/.test(e.request.url)) net.cssRequests += 1;
      });
      cdp.on("Network.dataReceived", (e) => {
        if (httpIds.has(e.requestId)) net.decodedBytes += e.dataLength;
      });
      cdp.on("Network.loadingFinished", (e) => {
        if (httpIds.has(e.requestId)) net.wireBytes += e.encodedDataLength;
      });
      cdp.on("Network.webSocketFrameReceived", (e) => {
        net.wsIn += Buffer.byteLength(e.response.payloadData);
      });
      cdp.on("Network.webSocketFrameSent", (e) => {
        const payload = e.response.payloadData;
        net.wsOut += Buffer.byteLength(payload);
        for (const tag of payload.matchAll(/"tag":"([^"]+)"/g)) {
          net.rpcOut[tag[1]] = (net.rpcOut[tag[1]] ?? 0) + 1;
        }
        // Proves no boot command starts a provider turn.
        if (payload.includes("orchestration.dispatchCommand")) {
          for (const type of payload.matchAll(/"type":"([^"]+)"/g)) {
            net.dispatchTypes[type[1]] = (net.dispatchTypes[type[1]] ?? 0) + 1;
          }
        }
      });
    }
    await page.goto(server.url, { waitUntil: "load" });
    await sleep(settleMs);
    const perf = await page.evaluate(readPage, mode === "network");
    const longTaskTotal = perf.longTasks.reduce((sum, t) => sum + t.d, 0);
    const tbt = perf.longTasks.reduce((sum, t) => sum + Math.max(0, t.d - 50), 0);
    const firstLongTask = perf.longTasks[0] ?? null;
    return {
      variant: variant.name,
      serverReadyMs: server.readyMs,
      fcp: perf.fcp,
      lcp: perf.lcpEntries.at(-1)?.t ?? null,
      lcpEl: perf.lcpEntries.at(-1)?.el ?? null,
      lcpEntries: perf.lcpEntries,
      responseEnd: perf.responseEnd,
      domInteractive: perf.domInteractive,
      dcl: perf.dcl,
      load: perf.load,
      splashGoneMs: perf.splashGoneMs,
      tbt,
      longTasks: perf.longTasks.length,
      longTaskList: perf.longTasks,
      maxLongTask: Math.max(0, ...perf.longTasks.map((t) => t.d)),
      longTaskTotal,
      firstLongTaskStart: firstLongTask?.start ?? null,
      longTaskBeforeFcp: perf.longTasks
        .filter((t) => perf.fcp != null && t.start < perf.fcp)
        .reduce((sum, t) => sum + t.d, 0),
      resBeforeFcp: perf.resBeforeFcp,
      jsBeforeFcp: perf.jsBeforeFcp,
      cssBeforeFcp: perf.cssBeforeFcp,
      jsBeforeSplashGone: perf.jsBeforeSplashGone,
      resources: perf.resources,
      ...(mode === "network" ? { ...net, resourceList: perf.resourceList } : {}),
    };
  } finally {
    await context.close();
    await server.stop();
  }
}

const meta = { mode, cpu, network: values.network, home: values.home, rounds, settleMs };
const samples = [];
for (let round = 0; round < rounds; round += 1) {
  for (const variant of rotation(variants, round)) {
    const result = await sample(variant);
    samples.push({ round, ...meta, ...result });
    writeFileSync(values.out, JSON.stringify(samples, null, 1));
    console.log(
      `${round} ${variant.name.padEnd(6)} fcp ${result.fcp?.toFixed(0)} dcl ${result.dcl?.toFixed(0)} splash ${result.splashGoneMs?.toFixed(0)} lt ${result.longTaskTotal.toFixed(0)} tbt ${result.tbt.toFixed(0)}${mode === "network" ? ` req ${result.requests} js ${result.jsRequests} wire ${Math.round(result.wireBytes / 1024)}KB` : ""}`,
    );
  }
}
await browser.close();
console.log(`done: ${samples.length} samples -> ${values.out}`);

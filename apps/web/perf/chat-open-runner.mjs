// Usage: node perf/chat-open-runner.mjs <origin> <neutral-thread-id> <thread-id>... [--rounds=3] [--out=file]
//
// Drives a running, isolated Synara server (production web build, copied database) and
// measures, per thread:
//   - cold open: in-app navigation to a thread whose detail is not loaded yet
//     (snapshot arrival, first transcript row, settled at the bottom, long tasks);
//   - warm switch: back to a thread already held in the store;
//   - reading older messages: real wheel input from the bottom to the first message
//     (scroll-anchor corrections, initial vs. final scroll range, main-thread style work);
//   - full reload: page load to the first transcript row and thread subscriptions sent.
// Never point it at a server that owns real user data; see the verify skill for setup.
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const flag = (name, fallback) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const [origin, neutral, ...threads] = args.filter((arg) => !arg.startsWith("--"));
if (!origin || !neutral || threads.length === 0) {
  console.error("usage: chat-open-runner.mjs <origin> <neutral-thread-id> <thread-id>...");
  process.exit(1);
}
const ROUNDS = Number(flag("rounds", "3"));
const WHEEL_PX = 240;
const MAX_WHEEL_TICKS = 700;
const SCROLLER = '[data-chat-scroll-container="true"]';

const median = (values) => {
  const sorted = values.filter((value) => typeof value === "number").toSorted((a, b) => a - b);
  return sorted.length ? Math.round(sorted[(sorted.length - 1) >> 1] * 10) / 10 : null;
};
const summarize = (runs) =>
  Object.fromEntries(
    Object.keys(runs[0] ?? {}).map((key) => [key, median(runs.map((r) => r[key]))]),
  );

const browser = await chromium.launch({ headless: true });

// A fresh context per thread keeps tabs, leases and caches from earlier threads out of
// the measurement.
async function newInstrumentedContext() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    const bench = (window.__chatBench = { longTasks: [], bigFrames: [], subscribes: 0 });
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) bench.longTasks.push(entry);
      }).observe({ type: "longtask", buffered: true });
    } catch {}
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(...socketArgs) {
        super(...socketArgs);
        this.addEventListener("message", (event) => {
          if (typeof event.data === "string" && event.data.length > 20_000) {
            bench.bigFrames.push(performance.now());
          }
        });
        const send = this.send.bind(this);
        this.send = (data) => {
          if (String(data).includes('"orchestration.subscribeThread"')) bench.subscribes += 1;
          return send(data);
        };
      }
    };
  });
  return context;
}

async function dismissFirstRunDialogs(page, quietMs = 2_500) {
  let quietSince = Date.now();
  while (Date.now() - quietSince < quietMs) {
    for (const name of ["Not now", "Skip tour"]) {
      const button = page.getByRole("button", { name });
      if (await button.count()) {
        await button
          .first()
          .click()
          .catch(() => {});
        quietSince = Date.now();
      }
    }
    await page.waitForTimeout(250);
  }
}

async function load(page, threadId) {
  await page.goto(`${origin}/${threadId}`, { waitUntil: "load" });
  await page.waitForSelector("[data-timeline-row-kind]", { timeout: 60_000 });
  await page.waitForTimeout(1_000);
  await dismissFirstRunDialogs(page);
}

// In-app navigation, then sample every frame until the transcript stops moving.
function measureOpen(page, threadId) {
  return page.evaluate(
    async ({ threadId, scroller }) => {
      const bench = window.__chatBench;
      bench.longTasks = [];
      bench.bigFrames = [];
      const previousRows = new Set(
        [...document.querySelectorAll("[data-message-id]")].map((row) => row.dataset.messageId),
      );
      const t0 = performance.now();
      history.pushState(history.state, "", `/${threadId}`);
      dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
      let firstRow = null;
      let bottom = null;
      let lastMove = t0;
      let lastGeometry = null;
      await new Promise((resolve) => {
        const tick = () => {
          const now = performance.now();
          const list = document.querySelector(scroller);
          if (firstRow === null) {
            for (const row of document.querySelectorAll("[data-message-id]")) {
              if (!previousRows.has(row.dataset.messageId)) {
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
          if ((firstRow !== null && now - lastMove > 700) || now - t0 > 30_000) return resolve();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const longTasks = bench.longTasks.filter((task) => task.startTime >= t0 - 5);
      return {
        snapshotArriveMs: bench.bigFrames.length ? bench.bigFrames[0] - t0 : null,
        firstRowMs: firstRow === null ? null : firstRow - t0,
        bottomMs: bottom === null ? null : bottom - t0,
        longTaskMs: longTasks.reduce((sum, task) => sum + task.duration, 0),
      };
    },
    { threadId, scroller: SCROLLER },
  );
}

async function measureReadingOlderMessages(page) {
  await page.waitForSelector(SCROLLER, { timeout: 30_000 });
  await dismissFirstRunDialogs(page, 500);
  const cdp = await page.context().newCDPSession(page);
  const box = await page.evaluate((scroller) => {
    const list = document.querySelector(scroller);
    const rect = list.getBoundingClientRect();
    const state = { corrections: 0, correctionPx: 0, lastTop: list.scrollTop };
    window.__chatBench.scroll = state;
    list.addEventListener(
      "scroll",
      () => {
        // While the reader only scrolls up, a downward jump is the list re-anchoring
        // after a row above the viewport rendered taller than estimated.
        if (list.scrollTop > state.lastTop + 1) {
          state.corrections += 1;
          state.correctionPx += list.scrollTop - state.lastTop;
        }
        state.lastTop = list.scrollTop;
      },
      { passive: true },
    );
    return {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      startHeight: list.scrollHeight,
    };
  }, SCROLLER);
  const events = [];
  cdp.on("Tracing.dataCollected", (batch) => events.push(...batch.value));
  await cdp.send("Tracing.start", {
    categories: "devtools.timeline,disabled-by-default-devtools.timeline",
    transferMode: "ReportEvents",
  });
  await page.mouse.move(box.x, box.y);
  let ticks = 0;
  for (; ticks < MAX_WHEEL_TICKS; ticks += 1) {
    await page.mouse.wheel(0, -WHEEL_PX);
    if (ticks % 5 === 4) {
      const top = await page.evaluate(
        (scroller) => document.querySelector(scroller).scrollTop,
        SCROLLER,
      );
      if (top <= 1) break;
    }
  }
  await page.waitForTimeout(300);
  const done = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
  await cdp.send("Tracing.end");
  await done;
  const main = events.find(
    (event) => event.name === "thread_name" && event.args?.name === "CrRendererMain",
  );
  const onMain = events.filter(
    (event) => event.pid === main?.pid && event.tid === main?.tid && event.ph === "X",
  );
  const styleRecalcs = onMain.filter((event) => event.name === "UpdateLayoutTree");
  const result = await page.evaluate((scroller) => {
    const list = document.querySelector(scroller);
    return {
      ...window.__chatBench.scroll,
      endHeight: list.scrollHeight,
      reachedTop: list.scrollTop <= 1,
    };
  }, SCROLLER);
  await cdp.detach();
  return {
    wheelTicks: ticks + 1,
    corrections: result.corrections,
    correctionPx: Math.round(result.correctionPx),
    startHeight: box.startHeight,
    endHeight: result.endHeight,
    styleRecalcMs: Math.round(styleRecalcs.reduce((sum, event) => sum + event.dur / 1000, 0)),
    wholeDocumentRecalcs: styleRecalcs.filter((event) => (event.args?.elementCount ?? 0) > 500)
      .length,
    mainThreadTaskMs: Math.round(
      onMain
        .filter((event) => event.name === "RunTask")
        .reduce((sum, event) => sum + event.dur / 1000, 0),
    ),
  };
}

async function measureReload(context, threadId) {
  const page = await context.newPage();
  await page.goto(`${origin}/${threadId}`, { waitUntil: "commit" });
  const firstRowMs = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const tick = () =>
          document.querySelector("[data-message-id]")
            ? resolve(performance.now())
            : requestAnimationFrame(tick);
        tick();
      }),
  );
  await page.waitForTimeout(1_500);
  const subscribeRequests = await page.evaluate(() => window.__chatBench.subscribes);
  await page.close();
  return { firstRowMs, subscribeRequests };
}

const report = { origin, rounds: ROUNDS, threads: {} };
for (const threadId of threads) {
  const context = await newInstrumentedContext();
  const page = await context.newPage();
  const cold = [];
  const warm = [];
  const scroll = [];
  const reload = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    await load(page, neutral);
    cold.push(await measureOpen(page, threadId));
    await page.waitForTimeout(400);
    scroll.push(await measureReadingOlderMessages(page));
    await measureOpen(page, neutral);
    warm.push(await measureOpen(page, threadId));
    reload.push(await measureReload(context, threadId));
  }
  report.threads[threadId] = {
    cold: summarize(cold),
    warm: summarize(warm),
    readingOlderMessages: summarize(scroll),
    reload: summarize(reload),
  };
  console.log(threadId, JSON.stringify(report.threads[threadId]));
  await context.close();
}
const out = flag("out", null);
if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
await browser.close();

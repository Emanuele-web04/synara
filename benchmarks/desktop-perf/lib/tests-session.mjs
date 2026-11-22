// Measurements taken inside one running app: memory and CPU at rest, GPU, thread
// switching, scrolling, and load with real provider sessions.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sleep, waitFor } from "./cdp.mjs";
import {
  SELECTORS,
  clickAt,
  clickSelector,
  elementCenter,
  focusEmulation,
  openThreadFromSidebar,
  pressKey,
  typeCharacter,
  wheel,
} from "./drive.mjs";
import {
  attachMainPage,
  freePort,
  frontmostProblem,
  launchDesktop,
  quitDesktop,
  resolveElectronBinary,
} from "./launch.mjs";
import {
  cpuOverWindow,
  gpuSystemOverWindow,
  memorySnapshot,
  rssTotalMb,
  wakeupsOverWindow,
} from "./metrics.mjs";
import { median, percentile } from "./stats.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export async function startApp({ build, home, expectTranscript = true }) {
  const app = launchDesktop({
    buildDir: build.dir,
    home: home.home,
    profile: home.profile,
    debugPort: await freePort(),
  });
  let session = null;
  try {
    ({ session } = await attachMainPage(app));
    await waitFor(
      () =>
        session.evaluate(
          `Boolean(document.querySelector(${JSON.stringify(SELECTORS.composer)})) && (${!expectTranscript} || document.querySelectorAll(${JSON.stringify(SELECTORS.messageRow)}).length > 0)`,
        ),
      { timeoutMs: 90_000, intervalMs: 100, label: "app ready" },
    );
    return { app, session };
  } catch (error) {
    // The next sample restores the same data home: an app left running here would have
    // it replaced underneath it and would contaminate every later measurement.
    session?.close();
    await quitDesktop(app);
    throw error;
  }
}

export async function windowBounds(session) {
  return session.evaluate(
    "({ x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight })",
  );
}

async function withCoverWindow(build, bounds, maxSeconds, run) {
  const profile = mkdtempSync(join(tmpdir(), "synara-bench-cover-"));
  const child = spawn(resolveElectronBinary(build.dir), [join(HERE, "cover-window.cjs")], {
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      BENCH_COVER_PROFILE: profile,
      BENCH_COVER_BOUNDS: JSON.stringify(bounds),
      BENCH_COVER_MAX_MS: String(maxSeconds * 1000),
    },
    stdio: ["ignore", "pipe", "ignore"],
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("cover window did not open")), 20_000);
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("cover-ready")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("exit", () => reject(new Error("cover window exited")));
    });
    return await run();
  } finally {
    child.kill("SIGKILL");
    await sleep(500);
    rmSync(profile, { recursive: true, force: true });
  }
}

function requireFrontmost(app, when) {
  const problem = frontmostProblem(app, when);
  if (problem) throw new Error(problem);
}

async function restWindow(app, seconds) {
  const [cpu, wakeups, gpu] = await Promise.all([
    cpuOverWindow(app, seconds),
    wakeupsOverWindow(app, seconds),
    gpuSystemOverWindow(seconds),
  ]);
  return { cpu, wakeups, gpuSystemUtilizationPercent: { median: median(gpu), samples: gpu } };
}

/**
 * Idle: seeded home, last thread restored, nothing running. Settles, then reads memory
 * by process, then CPU / wake-ups / GPU with the window in front and fully covered.
 */
export async function measureIdle({ build, home, settleSeconds = 45, windowSeconds = 60 }) {
  const gpuBeforeLaunch = await gpuSystemOverWindow(5);
  const { app, session } = await startApp({ build, home });
  const record = {
    at: new Date().toISOString(),
    failed: null,
    gpuSystemBeforeLaunchPercent: { median: median(gpuBeforeLaunch), samples: gpuBeforeLaunch },
  };
  try {
    await sleep(settleSeconds * 1000);
    record.memory = memorySnapshot(app);
    record.frontState = await session.evaluate(
      "({ visibility: document.visibilityState, focused: document.hasFocus() })",
    );
    record.window = await windowBounds(session);
    requireFrontmost(app, "before the front window");
    record.front = await restWindow(app, windowSeconds);
    requireFrontmost(app, "after the front window");
    await withCoverWindow(build, record.window, windowSeconds + 40, async () => {
      await sleep(8000);
      record.coveredState = await session.evaluate(
        "({ visibility: document.visibilityState, focused: document.hasFocus() })",
      );
      record.covered = await restWindow(app, windowSeconds);
    });
  } catch (error) {
    record.failed = error.message.split("\n")[0];
  }
  session.close();
  record.quit = await quitDesktop(app);
  return record;
}

// Runs in the page: waits for the next pointerdown, then samples every frame until the
// newly opened thread's rows are visible and the transcript has stopped moving.
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
    } catch {}
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
          )
            bottom = now;
          if ((firstRow !== null && now - lastMove > 500) || now - t0 > 20_000) {
            observer?.disconnect();
            const tasks = longTasks.filter((task) => task.startTime >= t0 - 5);
            resolve({
              firstRowMs: firstRow === null ? null : firstRow - t0,
              bottomMs: bottom === null ? null : bottom - t0,
              settledMs: firstRow === null ? null : lastMove - t0,
              longTaskMs: tasks.reduce((sum, task) => sum + task.duration, 0),
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

async function measureOpen(session, threadId) {
  const point = await waitFor(() => elementCenter(session, SELECTORS.threadRow(threadId)), {
    timeoutMs: 20_000,
    label: `sidebar row ${threadId}`,
  });
  await sleep(150);
  const settled = (await elementCenter(session, SELECTORS.threadRow(threadId))) ?? point;
  const pending = session.evaluate(
    `(${OPEN_PROBE.toString()})(${JSON.stringify(SELECTORS.scroller)}, ${JSON.stringify(SELECTORS.messageRow)})`,
  );
  await sleep(100);
  await clickAt(session, settled);
  const result = await pending;
  const route = await session.evaluate("location.href");
  if (!route.includes(threadId)) return { failed: `route did not change to ${threadId}` };
  // The probe gives up after 20 s. A transcript that never rendered must fail the
  // sample, not leave a missing timing that the summary would silently skip.
  if (result.firstRowMs === null) {
    return { failed: `the transcript of ${threadId} did not render within 20 s` };
  }
  return result;
}

// Runs in the page: records every frame interval while the harness sends wheel input.
const FRAME_RECORDER_START = () => {
  const state = (window.__benchFrames = { intervals: [], last: performance.now(), running: true });
  const tick = (now) => {
    if (!state.running) return;
    state.intervals.push(now - state.last);
    state.last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return true;
};
const FRAME_RECORDER_STOP = (scrollerSelector) => {
  const state = window.__benchFrames;
  state.running = false;
  const list = document.querySelector(scrollerSelector);
  return { intervals: state.intervals.slice(1), scrollTop: list?.scrollTop ?? null };
};

async function measureScroll(session, app, { ticks = 90, deltaPx = 240 } = {}) {
  const center = await elementCenter(session, SELECTORS.scroller);
  if (!center) return { failed: "no transcript scroller" };
  await session.call(FRAME_RECORDER_START);
  const cpu = cpuOverWindow(app, (ticks * 16.7) / 1000 + 0.5);
  for (let index = 0; index < ticks; index += 1) {
    await wheel(session, { ...center, deltaY: -deltaPx });
    await sleep(16);
  }
  await sleep(500);
  const frames = await session.call(FRAME_RECORDER_STOP, SELECTORS.scroller);
  const usage = await cpu;
  return {
    frames: frames.intervals.length,
    framesOver33ms: frames.intervals.filter((interval) => interval > 33).length,
    frameP95Ms: Math.round(percentile(frames.intervals, 0.95) * 10) / 10,
    frameMaxMs: Math.round(Math.max(...frames.intervals) * 10) / 10,
    rendererCpuPercent: usage.byRolePercent.renderer ?? 0,
    gpuProcessCpuPercent: usage.byRolePercent.gpu ?? 0,
  };
}

export const SWITCH_PLAN = {
  cold: [
    ["small-38", "seed-thread-small-002"],
    ["medium-120", "seed-thread-large-05"],
    ["large-300", "seed-thread-large-03"],
    ["large-666", "seed-thread-large-02"],
    ["large-1400", "seed-thread-large-01"],
  ],
  warm: [
    ["small-38", "seed-thread-small-002"],
    ["large-300", "seed-thread-large-03"],
    ["large-1400", "seed-thread-large-01"],
  ],
  scroll: "seed-thread-large-01",
  extra: [
    "seed-thread-small-003",
    "seed-thread-small-004",
    "seed-thread-small-005",
    "seed-thread-small-006",
    "seed-thread-small-007",
    "seed-thread-small-008",
    "seed-thread-small-009",
    "seed-thread-small-010",
    "seed-thread-small-011",
    "seed-thread-small-012",
  ],
};

/**
 * Thread switching: first opens (detail not loaded yet), switches back to loaded threads,
 * scrolling up through the 1,400-message thread, and memory after viewing more threads.
 */
export async function measureSwitching({ build, home }) {
  const { app, session } = await startApp({ build, home });
  const record = { at: new Date().toISOString(), failed: null, cold: {}, warm: {} };
  try {
    await sleep(8000);
    record.window = await windowBounds(session);
    requireFrontmost(app, "before thread switching");
    for (const [name, threadId] of SWITCH_PLAN.cold) {
      record.cold[name] = await measureOpen(session, threadId);
      // One thread that did not open invalidates the whole sample: its other readings
      // would otherwise enter the summaries while this timing went missing.
      if (record.cold[name].failed) throw new Error(`invalid sample: ${record.cold[name].failed}`);
      await sleep(600);
    }
    for (const [name, threadId] of SWITCH_PLAN.warm) {
      record.warm[name] = await measureOpen(session, threadId);
      // One thread that did not open invalidates the whole sample: its other readings
      // would otherwise enter the summaries while this timing went missing.
      if (record.warm[name].failed) throw new Error(`invalid sample: ${record.warm[name].failed}`);
      await sleep(600);
    }
    // Memory per viewed thread: renderer + backend + main only. The GPU process is
    // reported separately because its tile memory moves with what is on screen.
    await sleep(6000);
    record.memoryBefore = memorySnapshot(app);
    for (const threadId of SWITCH_PLAN.extra) {
      await openThreadFromSidebar(session, threadId);
      await sleep(700);
    }
    await sleep(8000);
    record.memoryAfter = memorySnapshot(app);
    record.viewedThreads = SWITCH_PLAN.extra.length;
    const held = (snapshot) =>
      (snapshot.byRole.renderer ?? 0) +
      (snapshot.byRole.backend ?? 0) +
      (snapshot.byRole.main ?? 0);
    record.appMbPerViewedThread =
      Math.round(
        ((held(record.memoryAfter) - held(record.memoryBefore)) / record.viewedThreads) * 100,
      ) / 100;
    await openThreadFromSidebar(session, SWITCH_PLAN.scroll);
    await sleep(2500);
    record.scroll = await measureScroll(session, app);
    if (record.scroll.failed) throw new Error(`invalid sample: ${record.scroll.failed}`);
    requireFrontmost(app, "after scrolling");
    await sleep(3000);
    record.memoryAfterScroll = memorySnapshot(app);
  } catch (error) {
    record.failed = error.message.split("\n")[0];
  }
  session.close();
  record.quit = await quitDesktop(app);
  return record;
}

export const LONGCHAT_PLAN = {
  threads: [
    ["prose-300", "real-thread-prose"],
    ["agent-mid", "real-thread-agent-mid"],
    ["agent-heavy", "real-thread-agent-heavy"],
  ],
  park: "seed-thread-small-016",
};

/**
 * Long threads of real shape (template set created with `prepare.mjs --templates
 * --realistic`): first open, switch back, then wheel scrolling and a fast fling with
 * frame timing on the real GPU. The headless longchat.mjs suite covers main-thread cost.
 */
export async function measureLongChat({ build, home }) {
  const { app, session } = await startApp({ build, home });
  const record = { at: new Date().toISOString(), failed: null, threads: {} };
  try {
    await sleep(8000);
    record.window = await windowBounds(session);
    requireFrontmost(app, "before long chats");
    for (const [name, threadId] of LONGCHAT_PLAN.threads) {
      const entry = {};
      entry.cold = await measureOpen(session, threadId);
      if (entry.cold.failed) throw new Error(`invalid sample: ${entry.cold.failed}`);
      await sleep(800);
      await openThreadFromSidebar(session, LONGCHAT_PLAN.park);
      await sleep(800);
      entry.warm = await measureOpen(session, threadId);
      if (entry.warm.failed) throw new Error(`invalid sample: ${entry.warm.failed}`);
      await sleep(1500);
      entry.scroll = await measureScroll(session, app);
      if (entry.scroll.failed) throw new Error(`invalid sample: ${entry.scroll.failed}`);
      await sleep(1000);
      entry.fling = await measureScroll(session, app, { ticks: 40, deltaPx: 1200 });
      if (entry.fling.failed) throw new Error(`invalid sample: ${entry.fling.failed}`);
      requireFrontmost(app, `after scrolling ${name}`);
      record.threads[name] = entry;
      await openThreadFromSidebar(session, LONGCHAT_PLAN.park);
      await sleep(800);
    }
  } catch (error) {
    record.failed = error.message.split("\n")[0];
  }
  session.close();
  record.quit = await quitDesktop(app);
  return record;
}

// Runs in the page: time from each keydown to the frame after its input event.
const TYPING_RECORDER = (composerSelector) => {
  const composer = document.querySelector(composerSelector);
  const state = (window.__benchTyping = { latencies: [], pending: null });
  composer.addEventListener("keydown", (event) => (state.pending = event.timeStamp), {
    capture: true,
  });
  composer.addEventListener("input", () => {
    const started = state.pending;
    if (started === null) return;
    state.pending = null;
    requestAnimationFrame(() =>
      requestAnimationFrame((now) => state.latencies.push(now - started)),
    );
  });
  return composer.innerText.length;
};

const TOPICS = [
  "exponential backoff with jitter in network clients",
  "write-ahead logging in embedded databases",
  "virtualized lists in user interfaces",
];
const promptFor = (topic) =>
  `Without using any tools, write a detailed 900-word technical essay about ${topic}. Use headings, two bullet lists, one table and two code blocks.`;

async function isGenerating(session) {
  return session.evaluate(
    `Boolean(document.querySelector('form button[aria-label="Stop generation"]'))`,
  );
}

/**
 * Load with real provider sessions: three new threads, each streaming a long answer from
 * the provider at the same time. Reads peak memory, CPU and typing latency while they
 * stream, then memory once they have finished and their sessions are still alive.
 */
export async function measureLoad({ build, home, threads = 3, timeoutSeconds = 240 }) {
  const { app, session } = await startApp({ build, home });
  const record = {
    at: new Date().toISOString(),
    failed: null,
    provider: "claudeAgent / claude-sonnet-5 (real sessions)",
    threads,
  };
  let sampling = true;
  const rssSamples = [];
  const sampler = (async () => {
    while (sampling) {
      rssSamples.push(rssTotalMb(app));
      await sleep(1000);
    }
  })();
  try {
    await sleep(10_000);
    record.memoryBefore = memorySnapshot(app);
    record.window = await windowBounds(session);
    requireFrontmost(app, "before the load test");
    await focusEmulation(session, true);
    const routes = [];
    const streamStartedAt = performance.now();
    for (let index = 0; index < threads; index += 1) {
      const project = `proj-${String(index + 1).padStart(2, "0")}`;
      await clickSelector(
        session,
        `button[data-testid="new-thread-button"][aria-label="Create new thread in ${project}"]`,
      );
      await waitFor(
        () =>
          session.evaluate(
            `document.querySelectorAll(${JSON.stringify(SELECTORS.messageRow)}).length === 0 && Boolean(document.querySelector(${JSON.stringify(SELECTORS.composer)}))`,
          ),
        { timeoutMs: 10_000, label: "empty draft" },
      );
      await sleep(400);
      await clickSelector(session, SELECTORS.composer);
      await sleep(150);
      await session.send("Input.insertText", { text: promptFor(TOPICS[index % TOPICS.length]) });
      await sleep(200);
      await pressKey(session, "Enter");
      await waitFor(() => isGenerating(session), {
        timeoutMs: 30_000,
        intervalMs: 100,
        label: `turn ${index + 1} to start`,
      });
      routes.push((await session.evaluate("location.href")).split("#/")[1]);
    }
    // The CPU window opens only once every session has started, so slow provider
    // start-up cannot be reported as streaming load. The check after the readings
    // confirms they were all still answering when it closed.
    const cpuDuringStream = cpuOverWindow(app, 15);
    // Typing while all sessions stream: 60 keys, 100 ms apart, in the visible thread.
    await waitFor(
      () =>
        session.evaluate(
          `(document.querySelector(${JSON.stringify(SELECTORS.scroller)})?.innerText.length ?? 0) > 400`,
        ),
      { timeoutMs: 60_000, label: "streamed text on screen" },
    );
    await clickSelector(session, SELECTORS.composer);
    const before = await session.call(TYPING_RECORDER, SELECTORS.composer);
    const stillStreamingAtStart = await isGenerating(session);
    for (let index = 0; index < 60; index += 1) {
      await typeCharacter(session, "abcdefghij"[index % 10]);
      await sleep(100);
    }
    await sleep(300);
    const typing = await session.evaluate(
      `({ latencies: window.__benchTyping.latencies, length: document.querySelector(${JSON.stringify(SELECTORS.composer)}).innerText.replace(/\\n/g, "").length })`,
    );
    record.typing = {
      keys: 60,
      measured: typing.latencies.length,
      missed: 60 - (typing.length - before),
      p95Ms: Math.round(percentile(typing.latencies, 0.95) * 10) / 10,
      medianMs: Math.round(median(typing.latencies) * 10) / 10,
      maxMs: Math.round(Math.max(...typing.latencies) * 10) / 10,
      streamingWhenStarted: stillStreamingAtStart,
      streamingWhenFinished: await isGenerating(session),
    };
    requireFrontmost(app, "after typing under load");
    record.cpuWhileStreaming = await cpuDuringStream;
    record.memoryWhileStreaming = memorySnapshot(app);
    // The readings above only count as load if every session was still answering when
    // they were taken. Check each thread now; one that already finished invalidates
    // the sample instead of passing idle readings off as streaming ones.
    let stillStreaming = 0;
    for (const route of routes) {
      if (!(await session.evaluate(`location.href.includes(${JSON.stringify(route)})`))) {
        await openThreadFromSidebar(session, route);
        await sleep(300);
      }
      if (await isGenerating(session)) stillStreaming += 1;
    }
    record.sessionsStreamingAfterReadings = stillStreaming;
    if (
      !record.typing.streamingWhenStarted ||
      !record.typing.streamingWhenFinished ||
      stillStreaming < threads
    ) {
      throw new Error(
        `invalid sample: only ${stillStreaming} of ${threads} sessions were still streaming after the load readings (typing started while streaming: ${record.typing.streamingWhenStarted}, finished while streaming: ${record.typing.streamingWhenFinished})`,
      );
    }
    // Wait for every turn to finish, checking each thread in turn.
    const deadline = performance.now() + timeoutSeconds * 1000;
    for (const route of [...routes].reverse()) {
      if (!(await session.evaluate(`location.href.includes(${JSON.stringify(route)})`)))
        await openThreadFromSidebar(session, route);
      await waitFor(async () => !(await isGenerating(session)), {
        timeoutMs: Math.max(1000, deadline - performance.now()),
        intervalMs: 250,
        label: `turn in ${route} to finish`,
      });
    }
    record.streamSeconds = Math.round((performance.now() - streamStartedAt) / 100) / 10;
    record.answerCharacters = await session.evaluate(
      `document.querySelector(${JSON.stringify(SELECTORS.scroller)})?.innerText.length ?? 0`,
    );
    await sleep(15_000);
    record.memoryAfter = memorySnapshot(app);
    record.totalMbPerThreadWithSession =
      Math.round(((record.memoryAfter.totalMb - record.memoryBefore.totalMb) / threads) * 10) / 10;
    record.appMbPerThreadWithSession =
      Math.round(((record.memoryAfter.appMb - record.memoryBefore.appMb) / threads) * 10) / 10;
  } catch (error) {
    record.failed = error.message.split("\n")[0];
  }
  sampling = false;
  await sampler;
  record.rssTotalMb = {
    peak: Math.max(...rssSamples),
    p95: percentile(rssSamples, 0.95),
    samples: rssSamples,
  };
  session.close();
  record.quit = await quitDesktop(app);
  return record;
}

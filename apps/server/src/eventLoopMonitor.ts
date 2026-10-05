import { loadavg } from "node:os";
import { monitorEventLoopDelay, performance, type Histogram } from "node:perf_hooks";
import { Effect, Layer, ServiceMap } from "effect";
import type { ServerRuntimeStatus } from "@synara/contracts";
import { reportBetaOperationalIssue } from "./betaOperationalIssue";

const SAMPLE_MS = 1000;
const SUMMARY_MS = 30_000;
const STALL_MS = 2000;
const RESOLUTION_MS = 20;

type DelayHistogram = Histogram & { enable(): boolean; disable(): boolean };
type Logger = {
  warn(message: string, payload: Record<string, unknown>): void;
  info(message: string, payload: Record<string, unknown>): void;
};

export const unavailableEventLoopStatus: ServerRuntimeStatus = {
  available: false,
  sampleWindowMs: 0,
  sampleCount: 0,
  delayP50Ms: 0,
  delayP99Ms: 0,
  delayMaxMs: 0,
  utilization: 0,
  stallWindowCount: 0,
  maxStallMs: 0,
  lastStall: null,
};

export function makeEventLoopMonitor(
  input: {
    histogram?: DelayHistogram;
    summaryHistogram?: DelayHistogram;
    now?: () => number;
    logger?: Logger;
    onStall?: (durationMs: number) => void;
    readLoop?: () => { activeMs: number; utilization: number };
  } = {},
) {
  const histogram = input.histogram ?? monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  const aggregate = input.summaryHistogram ?? monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  const now = input.now ?? (() => performance.now());
  const logger = input.logger ?? console;
  let lastSample = now();
  let windowStart = lastSample;
  let previousElu = performance.eventLoopUtilization();
  let previousUsage = process.resourceUsage();
  let firstSample = true;
  let lateActiveMs = 0;
  let countedDrift = false;
  let windowMaxMs = 0;
  let lastWarning = -Infinity;
  let lastStallAt: number | null = null;
  let lastStallMs = 0;
  let utilization = 0;
  let stallWindowCount = 0;
  let maxStallMs = 0;
  let suppressedStallWindows = 0;
  let suppressedMaxMs = 0;
  let stopped = false;
  let completed = {
    sampleWindowMs: 0,
    sampleCount: 0,
    delayP50Ms: 0,
    delayP99Ms: 0,
    delayMaxMs: 0,
  };

  histogram.enable();
  try {
    aggregate.enable();
  } catch (error) {
    histogram.disable();
    throw error;
  }
  const windowStats = (elapsed: number) => ({
    sampleWindowMs: Math.round(elapsed),
    sampleCount: aggregate.count,
    delayP50Ms: aggregate.count ? Math.max(0, aggregate.percentile(50) / 1e6 - RESOLUTION_MS) : 0,
    delayP99Ms: aggregate.count ? Math.max(0, aggregate.percentile(99) / 1e6 - RESOLUTION_MS) : 0,
    delayMaxMs: windowMaxMs,
  });
  const getSnapshot = (): ServerRuntimeStatus => ({
    available: !stopped,
    ...completed,
    utilization,
    stallWindowCount,
    maxStallMs,
    lastStall:
      lastStallAt === null
        ? null
        : { durationMs: lastStallMs, ageMs: Math.round(Math.max(0, now() - lastStallAt)) },
  });
  return {
    getSnapshot,
    sample() {
      if (stopped) return;
      const sampledAt = now();
      const elapsed = Math.max(0, sampledAt - lastSample);
      // The histogram's native timer and our timer can resume in either order.
      // Timer drift is a lower bound on non-responsiveness, not stack attribution.
      const histogramMs = histogram.count ? Math.max(0, histogram.max / 1e6 - RESOLUTION_MS) : 0;
      const driftMs = Math.max(0, elapsed - SAMPLE_MS);
      const maxMs = Math.max(histogramMs, driftMs);
      const elu = performance.eventLoopUtilization();
      const delta = performance.eventLoopUtilization(elu, previousElu);
      const loop = input.readLoop?.() ?? { activeMs: delta.active, utilization: delta.utilization };
      utilization = loop.utilization;
      previousElu = elu;
      const usage = process.resourceUsage();
      const cpuUserMs = (usage.userCPUTime - previousUsage.userCPUTime) / 1000;
      const cpuSystemMs = (usage.systemCPUTime - previousUsage.systemCPUTime) / 1000;
      const resourceDelta = {
        cpuUserMs,
        cpuSystemMs,
        majorPageFaults: usage.majorPageFault - previousUsage.majorPageFault,
        minorPageFaults: usage.minorPageFault - previousUsage.minorPageFault,
        involuntaryContextSwitches:
          usage.involuntaryContextSwitches - previousUsage.involuntaryContextSwitches,
      };
      previousUsage = usage;
      const cpuPercent = elapsed > 0 ? ((cpuUserMs + cpuSystemMs) / elapsed) * 100 : 0;
      lastSample = sampledAt;
      if (firstSample) {
        firstSample = false;
        histogram.reset();
        aggregate.reset();
        windowStart = sampledAt;
        return;
      }
      // HDR bucket error grows with duration (default 3 significant digits).
      // Keep bounded evidence from a late previous sample if the native timer
      // records that same gap after our timer. Do not count corroboration twice.
      const toleranceMs = Math.max(RESOLUTION_MS, maxMs * 0.002);
      const borrowed = loop.activeMs + toleranceMs < maxMs;
      const activeDelay = loop.activeMs + lateActiveMs + toleranceMs >= maxMs ? maxMs : 0;
      const corroboration = borrowed && countedDrift && activeDelay >= STALL_MS;
      lateActiveMs = driftMs > RESOLUTION_MS ? loop.activeMs : 0;
      countedDrift = !corroboration && activeDelay >= STALL_MS && histogramMs < STALL_MS;
      histogram.reset();
      if (maxMs > RESOLUTION_MS && activeDelay === 0) {
        // Sleep contaminates the native summary histogram as well. Start a fresh
        // window rather than publishing sleep as a runtime latency percentile.
        aggregate.reset();
        windowMaxMs = 0;
        windowStart = sampledAt;
        return;
      }
      windowMaxMs = Math.max(windowMaxMs, activeDelay);
      if (corroboration) {
        lastStallMs = Math.max(lastStallMs, activeDelay);
        maxStallMs = Math.max(maxStallMs, activeDelay);
      }
      if (activeDelay >= STALL_MS && !corroboration) {
        stallWindowCount++;
        maxStallMs = Math.max(maxStallMs, maxMs);
        lastStallAt = sampledAt;
        lastStallMs = maxMs;
        if (sampledAt - lastWarning >= SUMMARY_MS) {
          const memory = process.memoryUsage();
          logger.warn("[server-event-loop] stall", {
            stallDurationMs: Math.round(maxMs),
            sampleWindowMs: Math.round(elapsed),
            utilization,
            ...resourceDelta,
            cpuPercent,
            rssBytes: memory.rss,
            heapUsedBytes: memory.heapUsed,
            externalBytes: memory.external,
            loadAverage: loadavg(),
            stallWindowCount,
            suppressedStallWindows,
            suppressedMaxMs: Math.round(suppressedMaxMs),
          });
          input.onStall?.(Math.round(maxMs));
          lastWarning = sampledAt;
          suppressedStallWindows = 0;
          suppressedMaxMs = 0;
        } else {
          suppressedStallWindows++;
          suppressedMaxMs = Math.max(suppressedMaxMs, maxMs);
        }
      }
      completed = windowStats(sampledAt - windowStart);
      if (sampledAt - windowStart >= SUMMARY_MS) {
        logger.info("[server-event-loop] summary", {
          ...completed,
          utilization,
          stallWindowCount,
          maxStallMs,
          suppressedStallWindows,
          suppressedMaxMs,
        });
        aggregate.reset();
        windowMaxMs = 0;
        windowStart = sampledAt;
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      histogram.disable();
      aggregate.disable();
    },
  };
}

export function startEventLoopMonitor(
  monitor: ReturnType<typeof makeEventLoopMonitor>,
): () => void {
  const timer = setInterval(() => monitor.sample(), SAMPLE_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    monitor.stop();
  };
}

export class ServerEventLoopMonitor extends ServiceMap.Service<
  ServerEventLoopMonitor,
  { readonly getSnapshot: () => ServerRuntimeStatus }
>()("synara/ServerEventLoopMonitor") {}

export const ServerEventLoopMonitorLive = Layer.effect(
  ServerEventLoopMonitor,
  Effect.gen(function* () {
    try {
      const services = yield* Effect.services<never>();
      const log = Effect.runForkWith(services);
      const monitor = makeEventLoopMonitor({
        logger: {
          warn: (message, payload) => {
            log(
              Effect.logWarning(message, payload).pipe(
                Effect.withSpan("server.eventLoop.stall", {
                  root: true,
                  level: "Warn",
                  attributes: payload,
                }),
              ),
            );
          },
          info: (message, payload) => {
            log(Effect.logInfo(message, payload));
          },
        },
        onStall: (durationMs) =>
          reportBetaOperationalIssue({ code: "server.event-loop.stall", durationMs }),
      });
      const stop = startEventLoopMonitor(monitor);
      yield* Effect.addFinalizer(() => Effect.sync(stop));
      return monitor;
    } catch {
      yield* Effect.logWarning("Event-loop monitoring unavailable in this runtime");
      return { getSnapshot: () => unavailableEventLoopStatus };
    }
  }),
);

export const readEventLoopStatus = Effect.gen(function* () {
  const monitor = yield* Effect.serviceOption(ServerEventLoopMonitor);
  return monitor._tag === "Some" ? monitor.value.getSnapshot() : unavailableEventLoopStatus;
});

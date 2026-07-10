// FILE: memoryDiagnostics.ts
// Purpose: Emits low-volume backend memory counters for diagnosing desktop OOM crashes.
// Layer: Server runtime observability helper
// Exports: memory snapshot formatting and desktop diagnostic timer setup.

import * as V8 from "node:v8";

import type { RuntimeMode } from "./config";

const MB = 1024 * 1024;
const DEFAULT_MEMORY_DIAGNOSTIC_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_WARNING_HEAP_USED_RATIO = 0.7;
const DISABLE_MEMORY_DIAGNOSTICS_VALUES = new Set(["0", "false", "off"]);
const MEMORY_DIAGNOSTICS_ENV_KEYS = [
  "SYNARA_SERVER_MEMORY_DIAGNOSTICS",
  "SYNARA_SERVER_MEMORY_DIAGNOSTICS",
  "SYNARA_SERVER_MEMORY_DIAGNOSTICS",
] as const;

export interface ServerMemoryDiagnosticSnapshot {
  readonly rssMb: number;
  readonly heapUsedMb: number;
  readonly heapTotalMb: number;
  readonly heapLimitMb: number;
  readonly heapUsedRatio: number;
  readonly externalMb: number;
  readonly arrayBuffersMb: number;
}

export interface ServerMemoryDiagnosticLogPayload {
  readonly rssMb: number;
  readonly heapUsedMb: number;
  readonly heapTotalMb: number;
  readonly heapLimitMb: number;
  readonly heapUsedPercent: number;
  readonly externalMb: number;
  readonly arrayBuffersMb: number;
}

export interface ServerMemoryDiagnosticsLogger {
  readonly info: (message: string, payload: ServerMemoryDiagnosticLogPayload) => void;
  readonly warn: (message: string, payload: ServerMemoryDiagnosticLogPayload) => void;
}

export function readServerMemoryDiagnosticSnapshot(): ServerMemoryDiagnosticSnapshot {
  const memory = process.memoryUsage();
  const heap = V8.getHeapStatistics();
  const heapLimit = heap.heap_size_limit;
  return {
    rssMb: Math.round(memory.rss / MB),
    heapUsedMb: Math.round(memory.heapUsed / MB),
    heapTotalMb: Math.round(memory.heapTotal / MB),
    heapLimitMb: Math.round(heapLimit / MB),
    heapUsedRatio: heapLimit > 0 ? memory.heapUsed / heapLimit : 0,
    externalMb: Math.round(memory.external / MB),
    arrayBuffersMb: Math.round(memory.arrayBuffers / MB),
  };
}

export function toServerMemoryDiagnosticLogPayload(
  snapshot: ServerMemoryDiagnosticSnapshot,
): ServerMemoryDiagnosticLogPayload {
  return {
    rssMb: snapshot.rssMb,
    heapUsedMb: snapshot.heapUsedMb,
    heapTotalMb: snapshot.heapTotalMb,
    heapLimitMb: snapshot.heapLimitMb,
    heapUsedPercent: Number((snapshot.heapUsedRatio * 100).toFixed(1)),
    externalMb: snapshot.externalMb,
    arrayBuffersMb: snapshot.arrayBuffersMb,
  };
}

export function shouldWarnServerMemory(
  snapshot: ServerMemoryDiagnosticSnapshot,
  warningHeapUsedRatio: number,
): boolean {
  return snapshot.heapUsedRatio >= warningHeapUsedRatio;
}

function isServerMemoryDiagnosticsDisabled(): boolean {
  return MEMORY_DIAGNOSTICS_ENV_KEYS.some((key) => {
    const value = process.env[key]?.trim().toLowerCase();
    return value !== undefined && DISABLE_MEMORY_DIAGNOSTICS_VALUES.has(value);
  });
}

// Starts low-volume heap/RSS logging for packaged desktop backend crash reports.
export function startServerMemoryDiagnostics(input: {
  readonly mode: RuntimeMode;
  readonly intervalMs?: number;
  readonly logger?: ServerMemoryDiagnosticsLogger;
  readonly warningHeapUsedRatio?: number;
}): (() => void) | null {
  if (input.mode !== "desktop" || isServerMemoryDiagnosticsDisabled()) {
    return null;
  }

  const intervalMs = input.intervalMs ?? DEFAULT_MEMORY_DIAGNOSTIC_INTERVAL_MS;
  const logger = input.logger ?? console;
  const warningHeapUsedRatio = input.warningHeapUsedRatio ?? DEFAULT_WARNING_HEAP_USED_RATIO;

  const logMemory = (reason: "startup" | "interval") => {
    const snapshot = readServerMemoryDiagnosticSnapshot();
    const payload = toServerMemoryDiagnosticLogPayload(snapshot);
    if (shouldWarnServerMemory(snapshot, warningHeapUsedRatio)) {
      logger.warn(`[server-memory] ${reason}`, payload);
      return;
    }
    logger.info(`[server-memory] ${reason}`, payload);
  };

  logMemory("startup");
  const timer = setInterval(() => logMemory("interval"), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

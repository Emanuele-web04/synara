/**
 * Reading an app's logs and crash reports off a simulator.
 *
 * Backend-owned sources for an E2E check:
 *
 * - The unified log (`log show` inside the simulator): os_log, Logger, NSLog,
 *   and the frameworks' own errors about the app (UIKit, networking).
 * Direct stdout capture is deliberately unavailable: unlimited files or pipes
 * whose readers disappear could affect the app, and print is not unified logging.
 * - Crash reports, which the host writes to `~/Library/Logs/DiagnosticReports`
 *   as `<executable>-<timestamp>.ips` roughly a minute after the crash.
 *
 * Everything returned is the app's own output: data for the agent to weigh,
 * never instructions.
 *
 * @module device/deviceLogs
 */
import { readdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";

import type { DeviceCrashReport, DeviceLogQuery } from "./DeviceBackend.ts";

/** One log line is a message, not a document; longer ones are cut. */
const MAX_LINE_LENGTH = 500;
const MAX_CRASH_REPORTS = 5;
const MAX_CRASH_REPORT_BYTES = 4 * 1024 * 1024;

/**
 * Arguments after `simctl spawn <udid> log`.
 *
 * Apple's own subsystems are left out below error level: a SwiftUI app logs
 * hundreds of RunningBoard and UIKit lifecycle lines a minute, which bury the
 * app's own messages. Their errors and faults stay, since those are usually
 * about the app (a broken constraint, a failed request).
 */
export function unifiedLogArguments(executable: string, query: DeviceLogQuery): string[] {
  const process = `process == "${escapePredicateString(executable)}"`;
  const levelFlags =
    query.level === "debug" ? ["--info", "--debug"] : query.level === "info" ? ["--info"] : [];
  const scope =
    query.level === "error"
      ? "(messageType == error OR messageType == fault)"
      : '(NOT subsystem BEGINSWITH "com.apple." OR messageType == error OR messageType == fault)';
  // Log messages only: activity and signpost events are framework tracing
  // (RunningBoard state changes, UIKit gesture dispatch) that buried the app's
  // own lines, hundreds per minute.
  return [
    "show",
    "--last",
    `${Math.max(1, Math.round(query.sinceSeconds))}s`,
    "--style",
    "compact",
    ...levelFlags,
    "--predicate",
    `${process} AND eventType == logEvent AND ${scope}`,
  ];
}

function escapePredicateString(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}

/** The newest `limit` lines, each cut to a readable length. */
export function tailLines(
  lines: readonly string[],
  limit: number,
): { readonly lines: readonly string[]; readonly omitted: number } {
  const kept = lines.slice(Math.max(0, lines.length - limit));
  return {
    lines: kept.map((line) =>
      line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH - 1)}…` : line,
    ),
    omitted: lines.length - kept.length,
  };
}

/**
 * Crash reports for `executable` written since `sinceMs`, newest first.
 *
 * A macOS process with the same executable name writes to the same directory,
 * so a report whose process path names another simulator (or no simulator)
 * is skipped.
 */
export async function readCrashReports(input: {
  readonly directory: string;
  readonly executable: string;
  readonly udid: string;
  readonly sinceMs: number;
}): Promise<readonly DeviceCrashReport[]> {
  const entries = await readdir(input.directory).catch(() => [] as string[]);
  const candidates = entries.filter(
    (name) => name.startsWith(`${input.executable}-`) && name.endsWith(".ips"),
  );
  const reports: Array<DeviceCrashReport & { readonly mtimeMs: number }> = [];
  for (const name of candidates) {
    const file = path.join(input.directory, name);
    const info = await stat(file).catch(() => null);
    if (info === null || info.mtimeMs < input.sinceMs || info.size > MAX_CRASH_REPORT_BYTES) {
      continue;
    }
    const parsed = parseCrashReport(await readFile(file, "utf8").catch(() => ""));
    if (parsed.procPath !== null && !parsed.procPath.includes(input.udid)) continue;
    reports.push({
      path: file,
      capturedAt: new Date(info.mtimeMs).toISOString(),
      exception: parsed.exception,
      reason: parsed.reason,
      mtimeMs: info.mtimeMs,
    });
  }
  return reports
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_CRASH_REPORTS)
    .map(({ mtimeMs: _mtimeMs, ...report }) => report);
}

/**
 * An `.ips` report is a one-line JSON header followed by a JSON body. Only
 * the fields that answer "why did it crash" are read; anything unparseable
 * leaves them null rather than failing the read.
 */
export function parseCrashReport(text: string): {
  readonly procPath: string | null;
  readonly exception: string | null;
  readonly reason: string | null;
} {
  const newline = text.indexOf("\n");
  const body = asRecord(safeJson(newline === -1 ? "" : text.slice(newline + 1)));
  const exception = asRecord(body?.exception);
  const type = typeof exception?.type === "string" ? exception.type : null;
  const signal = typeof exception?.signal === "string" ? exception.signal : null;
  const termination = asRecord(body?.termination);
  const asi = asRecord(body?.asi);
  const asiMessage = asi
    ? Object.values(asi)
        .flatMap((value) => (Array.isArray(value) ? value : []))
        .find((value): value is string => typeof value === "string")
    : undefined;
  const indicator = typeof termination?.indicator === "string" ? termination.indicator : undefined;
  return {
    procPath: typeof body?.procPath === "string" ? body.procPath : null,
    exception: type === null ? signal : signal === null ? type : `${type} (${signal})`,
    reason: asiMessage ?? indicator ?? null,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

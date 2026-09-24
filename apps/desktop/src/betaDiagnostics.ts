// FILE: betaDiagnostics.ts
// Purpose: Beta-only diagnostics queue for Synara Beta desktop builds.
// Layer: Desktop telemetry (runs only when the baked build flavor is "beta").
//
// Privacy contract (also documented in docs/diagnostics.md):
// - Only the fixed event names and payload fields declared in BetaDiagnosticsEvent
//   are ever written. There is no generic "metadata" bag.
// - Free-text fields (error message, stack, log tail) are capped and passed
//   through redactDiagnosticText (packages/shared/diagnosticsRedaction.ts)
//   before they are written to the queue. Paths in them are reduced to the
//   file name; folder and repo names are dropped. Redaction is best-effort:
//   error text can still include fragments of whatever was on screen.
// - No prompts, chat text, file contents, provider payloads, credentials, or
//   environment variables are collected.
// - The install id is a random UUID generated on first launch of a beta install;
//   it identifies an install, not a person.
// - Stable/production builds never construct this object, so the stable binary
//   has no live diagnostics code path.

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import { LEGACY_PROVIDER_MIGRATIONS, ProviderKind } from "@synara/contracts";
import { redactDiagnosticText } from "@synara/shared/diagnosticsRedaction";

/** Override point for self-hosted / dev ingestion; production default ships in the binary. */
export const BETA_DIAGNOSTICS_ENDPOINT = "https://synara-beta-diagnostics.kartik-9f9.workers.dev";
export const BETA_DIAGNOSTICS_ENDPOINT_ENV = "SYNARA_BETA_DIAGNOSTICS_URL";

const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
// Crash events can carry a ~16 KiB log tail, so the queue gets headroom for a
// burst of them without crowding out ordinary events.
const QUEUE_MAX_BYTES = 1024 * 1024;
const QUEUE_TRIM_TARGET_BYTES = 512 * 1024;
const FLUSH_BATCH_MAX_EVENTS = 200;
const FLUSH_BATCH_MAX_BYTES = 256 * 1024;
// The server writes diagnostics/usage-snapshot.json every 6h; the main
// process relays it as one usage.daily event per UTC day.
const USAGE_SNAPSHOT_FIRST_DELAY_MS = 2 * 60 * 1000;
const USAGE_SNAPSHOT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const USAGE_SNAPSHOT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const USAGE_COUNT_MAX = 100_000;

export const DIAGNOSTICS_MESSAGE_MAX_LENGTH = 1024;
export const DIAGNOSTICS_STACK_MAX_LENGTH = 8 * 1024;
export const DIAGNOSTICS_LOG_TAIL_MAX_LENGTH = 16 * 1024;
export const DIAGNOSTICS_LOG_TAIL_MAX_LINES = 200;
const ERROR_FINGERPRINT_WINDOW_MS = 10 * 60 * 1000;
const ERROR_HOURLY_CAP = 30;

/**
 * Allowlist of event names. Adding an event means extending this union and the
 * payload type below — there is deliberately no free-form field.
 */
export type BetaDiagnosticsEventName =
  | "app.start"
  | "app.exit"
  | "app.error"
  | "app.renderer-crash"
  | "app.child-process-crash"
  | "update.check"
  | "update.available"
  | "update.downloaded"
  | "update.installed"
  | "update.error"
  | "usage.daily"
  | "beta.installed"
  | "beta.left";

/** One provider's anonymous 24h counts inside a usage.daily event. */
export interface BetaUsageProviderEntry {
  readonly provider: ProviderKind;
  readonly threads: number;
  readonly turns: number;
  readonly turnsFailed: number;
}

export type BetaDiagnosticsPayload =
  | {
      readonly kind: "lifecycle";
      readonly durationMs?: number;
      /** Major.minor OS version (e.g. "15.3"); app.start only. */
      readonly osVersion?: string | undefined;
      /** Primary language subtag (e.g. "en"); app.start only. */
      readonly locale?: string | undefined;
    }
  | {
      readonly kind: "crash";
      readonly processType: string;
      readonly reason: string;
      /** Redacted tail of the relevant process log (see readLogTail). */
      readonly logTail?: string | undefined;
    }
  | {
      readonly kind: "error";
      readonly source: "main" | "renderer";
      readonly message: string;
      readonly stack?: string | undefined;
      readonly fingerprint: string;
    }
  | {
      readonly kind: "update";
      readonly outcome: "ok" | "error";
      readonly durationMs?: number;
      readonly targetVersion?: string;
      readonly errorContext?: "check" | "download" | "install";
    }
  | {
      readonly kind: "usage";
      readonly providers: readonly BetaUsageProviderEntry[];
      readonly projects: number;
      readonly activeThreads: number;
    }
  | {
      readonly kind: "beta";
      readonly outcome: "imported" | "import-failed" | "fresh" | "trash" | "keep";
    };

export interface BetaDiagnosticsEvent {
  readonly v: 1;
  readonly id: string;
  readonly ts: string;
  readonly installId: string;
  readonly appVersion: string;
  readonly flavor: "beta";
  readonly platform: string;
  readonly arch: string;
  readonly event: BetaDiagnosticsEventName;
  readonly payload: BetaDiagnosticsPayload;
}

const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const PROVIDER_KIND_SET = new Set<string>(ProviderKind.literals);

/** Usage counts are floored, non-negative, and capped — never free text. */
const clampUsageCount = (value: unknown): number => {
  const count = typeof value === "number" ? Math.floor(value) : Number.NaN;
  if (!Number.isFinite(count) || count < 0) return 0;
  return Math.min(count, USAGE_COUNT_MAX);
};

/** Major.minor only: "15.3.1" -> "15.3", "10.0.22621" -> "10.0". */
const sanitizeOsVersion = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+)(?:\.(\d+))?/.exec(value);
  return match ? (match[2] ? `${match[1]}.${match[2]}` : match[1]!) : undefined;
};

/** app.getLocale() -> primary language subtag ("en-US" -> "en"). */
const sanitizeLocale = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const primary = value.split("-")[0]?.toLowerCase();
  return primary && /^[a-z]{2,3}$/.test(primary) ? primary : undefined;
};

const BETA_OUTCOMES_BY_EVENT: Partial<Record<BetaDiagnosticsEventName, ReadonlySet<string>>> = {
  "beta.installed": new Set(["imported", "import-failed", "fresh"]),
  "beta.left": new Set(["trash", "keep"]),
};

/**
 * Fields not on the allowlist are dropped, never coerced. Free-text fields
 * (message, stack, logTail) are capped and passed through redactDiagnosticText
 * with the caller's homeDir. `event` scopes outcome validation for the beta
 * lifecycle events.
 */
export function sanitizeBetaDiagnosticsPayload(
  payload: BetaDiagnosticsPayload,
  homeDir?: string,
  event?: BetaDiagnosticsEventName,
): BetaDiagnosticsPayload {
  const redact = (text: unknown, maxLength: number): string =>
    redactDiagnosticText(String(text), { homeDir, maxLength });
  if (payload.kind === "lifecycle") {
    const osVersion = sanitizeOsVersion(payload.osVersion);
    const locale = sanitizeLocale(payload.locale);
    return {
      kind: "lifecycle",
      ...(isFiniteNonNegative(payload.durationMs) ? { durationMs: payload.durationMs } : {}),
      ...(osVersion ? { osVersion } : {}),
      ...(locale ? { locale } : {}),
    };
  }
  if (payload.kind === "crash") {
    return {
      kind: "crash",
      processType: String(payload.processType).slice(0, 32),
      reason: String(payload.reason).slice(0, 64),
      ...(typeof payload.logTail === "string" && payload.logTail.length > 0
        ? { logTail: redact(payload.logTail, DIAGNOSTICS_LOG_TAIL_MAX_LENGTH) }
        : {}),
    };
  }
  if (payload.kind === "error") {
    return {
      kind: "error",
      source: payload.source === "renderer" ? "renderer" : "main",
      message: redact(payload.message, DIAGNOSTICS_MESSAGE_MAX_LENGTH),
      ...(typeof payload.stack === "string" && payload.stack.length > 0
        ? { stack: redact(payload.stack, DIAGNOSTICS_STACK_MAX_LENGTH) }
        : {}),
      fingerprint: /^[0-9a-f]{8,32}$/i.test(String(payload.fingerprint))
        ? String(payload.fingerprint)
        : "unknown",
    };
  }
  if (payload.kind === "update") {
    return {
      kind: "update",
      outcome: payload.outcome === "error" ? "error" : "ok",
      ...(isFiniteNonNegative(payload.durationMs) ? { durationMs: payload.durationMs } : {}),
      ...(typeof payload.targetVersion === "string" &&
      /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(payload.targetVersion)
        ? { targetVersion: payload.targetVersion }
        : {}),
      ...(payload.errorContext === "check" ||
      payload.errorContext === "download" ||
      payload.errorContext === "install"
        ? { errorContext: payload.errorContext }
        : {}),
    };
  }
  if (payload.kind === "usage") {
    // One entry per provider; duplicates merge by summing, then clamp.
    const merged = new Map<ProviderKind, { threads: number; turns: number; turnsFailed: number }>();
    if (Array.isArray(payload.providers)) {
      for (const entry of payload.providers) {
        if (!entry || typeof entry !== "object") continue;
        const rawProvider = (entry as { provider?: unknown }).provider;
        const provider =
          typeof rawProvider === "string"
            ? PROVIDER_KIND_SET.has(rawProvider)
              ? (rawProvider as ProviderKind)
              : LEGACY_PROVIDER_MIGRATIONS[rawProvider]
            : undefined;
        if (!provider) continue;
        const existing = merged.get(provider) ?? { threads: 0, turns: 0, turnsFailed: 0 };
        merged.set(provider, {
          threads: existing.threads + clampUsageCount(entry.threads),
          turns: existing.turns + clampUsageCount(entry.turns),
          turnsFailed: existing.turnsFailed + clampUsageCount(entry.turnsFailed),
        });
      }
    }
    return {
      kind: "usage",
      providers: [...merged.entries()].map(([provider, counts]) => ({
        provider,
        threads: Math.min(counts.threads, USAGE_COUNT_MAX),
        turns: Math.min(counts.turns, USAGE_COUNT_MAX),
        turnsFailed: Math.min(counts.turnsFailed, USAGE_COUNT_MAX),
      })),
      projects: clampUsageCount(payload.projects),
      activeThreads: clampUsageCount(payload.activeThreads),
    };
  }
  // kind === "beta"
  const allowedOutcomes = event === undefined ? undefined : BETA_OUTCOMES_BY_EVENT[event];
  return {
    kind: "beta",
    ...(allowedOutcomes?.has(payload.outcome) ? { outcome: payload.outcome } : {}),
  };
}

/**
 * Reads the last ~200 lines / 16 KiB of a process log for crash context.
 * Returns undefined when the file is missing or unreadable. The caller passes
 * the result through the crash payload, which redacts it before queueing.
 */
export function readLogTail(filePath: string): string | undefined {
  try {
    if (!existsSync(filePath)) return undefined;
    const size = statSync(filePath).size;
    if (size === 0) return undefined;
    const start = Math.max(0, size - DIAGNOSTICS_LOG_TAIL_MAX_LENGTH);
    const buffer = Buffer.alloc(size - start);
    const fd = openSync(filePath, "r");
    let bytesRead = 0;
    try {
      bytesRead = readSync(fd, buffer, 0, buffer.length, start);
    } finally {
      closeSync(fd);
    }
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    return lines.slice(-DIAGNOSTICS_LOG_TAIL_MAX_LINES).join("\n");
  } catch {
    return undefined;
  }
}

/** Top stack frame of an (already redacted) stack, for fingerprinting. */
function topStackFrame(stack: string | undefined): string {
  if (!stack) return "";
  for (const line of stack.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("at ")) return trimmed;
  }
  return stack.split("\n")[0]?.trim() ?? "";
}

function errorFingerprint(message: string, stack: string | undefined): string {
  return createHash("sha256")
    .update(`${message}\n${topStackFrame(stack)}`)
    .digest("hex")
    .slice(0, 16);
}

export function resolveBetaDiagnosticsEndpoint(env: NodeJS.ProcessEnv): string {
  const override = env[BETA_DIAGNOSTICS_ENDPOINT_ENV]?.trim();
  if (!override) return BETA_DIAGNOSTICS_ENDPOINT;
  // Loopback http targets are allowed so the worker can be developed locally;
  // remote overrides must be TLS. Parsed as a URL so lookalike prefixes like
  // http://localhost.evil.com cannot pass.
  try {
    const url = new URL(override);
    if (url.protocol === "https:") return override;
    if (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
    ) {
      return override;
    }
  } catch {
    // Unparseable override: fall through to the baked default.
  }
  return BETA_DIAGNOSTICS_ENDPOINT;
}

export class BetaDiagnostics {
  /** Random UUID identifying this beta install; generated on first launch. */
  readonly installId: string;
  private readonly queuePath: string;
  private readonly usageSnapshotPath: string;
  private readonly usageLastDayPath: string;
  private readonly installPendingPath: string;
  private readonly endpoint: string;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private usageTimers: ReturnType<typeof setTimeout>[] = [];
  private flushing = false;
  private flushPromise: Promise<void> | null = null;
  private disposed = false;

  constructor(input: {
    readonly homeDir: string;
    readonly appVersion: string;
    readonly platform: string;
    readonly arch: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly now?: () => Date;
  }) {
    this.queuePath = join(input.homeDir, "diagnostics", "events.jsonl");
    this.usageSnapshotPath = join(input.homeDir, "diagnostics", "usage-snapshot.json");
    this.usageLastDayPath = join(input.homeDir, "diagnostics", "usage-last-day");
    this.installPendingPath = join(input.homeDir, "diagnostics", "install-pending");
    this.endpoint = resolveBetaDiagnosticsEndpoint(input.env ?? process.env);
    this.installId = this.loadInstallId(input.homeDir);
    this.now = input.now ?? (() => new Date());
    this.appVersion = input.appVersion;
    this.platform = input.platform;
    this.arch = input.arch;
    this.homeDir = input.homeDir;
  }

  private readonly now: () => Date;
  private readonly appVersion: string;
  private readonly platform: string;
  private readonly arch: string;
  private readonly homeDir: string;
  private readonly errorFingerprintSentAt = new Map<string, number>();
  private readonly errorSentTimestamps: number[] = [];

  private loadInstallId(homeDir: string): string {
    const diagnosticsDir = join(homeDir, "diagnostics");
    const idPath = join(diagnosticsDir, "install-id");
    try {
      if (existsSync(idPath)) {
        const existing = readFileSync(idPath, "utf8").trim();
        if (/^[0-9a-f-]{36}$/i.test(existing)) return existing;
      }
      mkdirSync(diagnosticsDir, { recursive: true });
      const generated = randomUUID();
      writeFileSync(`${idPath}.tmp-${process.pid}`, `${generated}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(`${idPath}.tmp-${process.pid}`, idPath);
      try {
        // Durable marker so a first launch whose backend never comes up still
        // reports beta.installed on the next launch.
        const pendingTmp = `${this.installPendingPath}.tmp-${process.pid}`;
        writeFileSync(pendingTmp, `${new Date().toISOString()}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        renameSync(pendingTmp, this.installPendingPath);
      } catch {
        // Marker write must not fail install-id creation.
      }
      return generated;
    } catch {
      return randomUUID();
    }
  }

  /** True while this install still owes a beta.installed event. */
  hasInstallPending(): boolean {
    return existsSync(this.installPendingPath);
  }

  /** Deletes the marker once the beta.installed event is queued. */
  clearInstallPending(): void {
    try {
      rmSync(this.installPendingPath, { force: true });
    } catch {
      // best effort
    }
  }

  start(): void {
    if (this.flushTimer || this.disposed) return;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();
    // First usage relay 2 minutes after startup, then every 6h. Timers are
    // unref'd so diagnostics never hold the process open.
    const first = setTimeout(() => {
      this.maybeTrackDailyUsage();
      const every = setInterval(() => this.maybeTrackDailyUsage(), USAGE_SNAPSHOT_INTERVAL_MS);
      every.unref?.();
      this.usageTimers.push(every);
    }, USAGE_SNAPSHOT_FIRST_DELAY_MS);
    first.unref?.();
    this.usageTimers.push(first);
  }

  track(event: BetaDiagnosticsEventName, payload: BetaDiagnosticsPayload): void {
    if (this.disposed) return;
    const sanitized = sanitizeBetaDiagnosticsPayload(payload, this.homeDir, event);
    // A beta lifecycle event without a valid outcome is meaningless — drop it.
    if (sanitized.kind === "beta" && !("outcome" in sanitized)) return;
    const record: BetaDiagnosticsEvent = {
      v: 1,
      id: randomUUID(),
      ts: this.now().toISOString(),
      installId: this.installId,
      appVersion: this.appVersion,
      flavor: "beta",
      platform: this.platform,
      arch: this.arch,
      event,
      payload: sanitized,
    };
    try {
      mkdirSync(join(this.queuePath, ".."), { recursive: true });
      appendFileSync(this.queuePath, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      this.trimQueueIfNeeded();
    } catch {
      // Diagnostics must never break the app.
    }
  }

  /**
   * Records an app.error event. The message and stack are redacted before the
   * fingerprint is computed; identical fingerprints are throttled to one event
   * per 10 minutes and the session is capped at 30 errors per hour.
   */
  trackError(source: "main" | "renderer", error: unknown): void {
    if (this.disposed) return;
    try {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      const redactedMessage = redactDiagnosticText(message, {
        homeDir: this.homeDir,
        maxLength: DIAGNOSTICS_MESSAGE_MAX_LENGTH,
      });
      const redactedStack =
        stack === undefined
          ? undefined
          : redactDiagnosticText(stack, {
              homeDir: this.homeDir,
              maxLength: DIAGNOSTICS_STACK_MAX_LENGTH,
            });
      const fingerprint = errorFingerprint(redactedMessage, redactedStack);
      if (!this.allowError(fingerprint)) return;
      this.track("app.error", {
        kind: "error",
        source,
        message: redactedMessage,
        stack: redactedStack,
        fingerprint,
      });
    } catch {
      // Diagnostics must never break the app.
    }
  }

  /**
   * Relays the server-written usage snapshot as one usage.daily event per UTC
   * day. Skips missing/corrupt snapshots, snapshots older than 12h (the server
   * may have been down), and days already recorded in usage-last-day.
   */
  maybeTrackDailyUsage(): void {
    if (this.disposed) return;
    try {
      if (!existsSync(this.usageSnapshotPath)) return;
      const raw = JSON.parse(readFileSync(this.usageSnapshotPath, "utf8")) as {
        v?: unknown;
        generatedAt?: unknown;
        providers?: unknown;
        projects?: unknown;
        activeThreads?: unknown;
      };
      if (typeof raw.generatedAt !== "string") return;
      const generatedMs = Date.parse(raw.generatedAt);
      const now = this.now();
      const nowMs = now.getTime();
      if (
        !Number.isFinite(generatedMs) ||
        generatedMs > nowMs ||
        nowMs - generatedMs > USAGE_SNAPSHOT_MAX_AGE_MS
      ) {
        return;
      }
      const today = now.toISOString().slice(0, 10);
      try {
        if (
          existsSync(this.usageLastDayPath) &&
          readFileSync(this.usageLastDayPath, "utf8").trim() === today
        ) {
          return;
        }
      } catch {
        // unreadable marker: fall through and track
      }
      if (raw.v !== 1) return;
      this.track("usage.daily", {
        kind: "usage",
        providers: Array.isArray(raw.providers) ? (raw.providers as BetaUsageProviderEntry[]) : [],
        projects: raw.projects as number,
        activeThreads: raw.activeThreads as number,
      });
      writeFileSync(this.usageLastDayPath, `${today}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // Diagnostics must never break the app.
    }
  }

  private allowError(fingerprint: string): boolean {
    const nowMs = this.now().getTime();
    while (
      this.errorSentTimestamps.length > 0 &&
      nowMs - this.errorSentTimestamps[0]! > 60 * 60 * 1000
    ) {
      this.errorSentTimestamps.shift();
    }
    if (this.errorSentTimestamps.length >= ERROR_HOURLY_CAP) return false;
    const lastSent = this.errorFingerprintSentAt.get(fingerprint);
    if (lastSent !== undefined && nowMs - lastSent < ERROR_FINGERPRINT_WINDOW_MS) return false;
    this.errorFingerprintSentAt.set(fingerprint, nowMs);
    if (this.errorFingerprintSentAt.size > 256) {
      for (const [key, sentAt] of this.errorFingerprintSentAt) {
        if (nowMs - sentAt > ERROR_FINGERPRINT_WINDOW_MS) this.errorFingerprintSentAt.delete(key);
      }
    }
    this.errorSentTimestamps.push(nowMs);
    return true;
  }

  private trimQueueIfNeeded(): void {
    try {
      const size = statSync(this.queuePath).size;
      if (size <= QUEUE_MAX_BYTES) return;
      const lines = readFileSync(this.queuePath, "utf8").split("\n");
      // Keep the newest events; diagnostics data ages out rather than growing.
      const kept: string[] = [];
      let keptBytes = 0;
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]!;
        if (line.length === 0) continue;
        if (keptBytes + line.length > QUEUE_TRIM_TARGET_BYTES && kept.length > 0) break;
        kept.unshift(line);
        keptBytes += line.length + 1;
      }
      const stagingPath = `${this.queuePath}.trim-${process.pid}`;
      writeFileSync(stagingPath, `${kept.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(stagingPath, this.queuePath);
    } catch {
      // best effort
    }
  }

  /**
   * POSTs the oldest queued events as newline-delimited JSON. Successfully
   * delivered lines are dropped from the head of the queue; the remainder stay
   * for the next flush. `timeoutMs` bounds the request so a hung endpoint
   * cannot stall quit.
   */
  async flush(timeoutMs = 15_000): Promise<void> {
    if (this.flushing || this.disposed) return;
    this.flushing = true;
    // The promise resolves only after `flushing` clears, so dispose() can
    // chain a final flush on it.
    this.flushPromise = (async () => {
      try {
        await this.flushQueue(timeoutMs);
      } finally {
        this.flushing = false;
        this.flushPromise = null;
      }
    })();
    await this.flushPromise;
  }

  private async flushQueue(timeoutMs: number): Promise<void> {
    try {
      if (!existsSync(this.queuePath)) return;
      const raw = readFileSync(this.queuePath, "utf8");
      const lines = raw.split("\n").filter((line) => line.length > 0);
      if (lines.length === 0) return;

      const batch: string[] = [];
      let batchBytes = 0;
      for (const line of lines.slice(0, FLUSH_BATCH_MAX_EVENTS)) {
        if (batchBytes + line.length > FLUSH_BATCH_MAX_BYTES && batch.length > 0) break;
        batch.push(line);
        batchBytes += line.length + 1;
      }
      if (batch.length === 0) return;

      const body = `${batch.join("\n")}\n`;
      const response = await fetch(`${this.endpoint}/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/x-ndjson" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return;

      // Events can be appended while the request was in flight, and a trim can
      // rewrite the head, so match the sent lines by id rather than position.
      const sentIds = new Set<string>();
      for (const line of batch) {
        try {
          const id = (JSON.parse(line) as { id?: unknown }).id;
          if (typeof id === "string") sentIds.add(id);
        } catch {
          // unparseable sent line: leave a defensive retry in place below
        }
      }
      const current = readFileSync(this.queuePath, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      const rest = current.filter((line) => {
        try {
          const id = (JSON.parse(line) as { id?: unknown }).id;
          return !(typeof id === "string" && sentIds.has(id));
        } catch {
          return true;
        }
      });
      const stagingPath = `${this.queuePath}.flush-${process.pid}`;
      if (rest.length > 0) {
        writeFileSync(stagingPath, `${rest.join("\n")}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
      }
      try {
        if (rest.length > 0) {
          renameSync(stagingPath, this.queuePath);
        } else {
          rmSync(this.queuePath, { force: true });
        }
      } finally {
        rmSync(stagingPath, { force: true });
      }
    } catch {
      // Offline / endpoint down: keep the queue for the next flush.
    }
  }

  /** Best-effort final flush + shutdown for app quit; bounded by `timeoutMs`. */
  async dispose(timeoutMs = 3_000): Promise<void> {
    if (this.disposed) return;
    // Short sessions may never reach the 2-minute timer; a still-fresh
    // snapshot from this or the previous launch relays on the way out.
    this.maybeTrackDailyUsage();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    for (const timer of this.usageTimers) clearTimeout(timer);
    this.usageTimers = [];
    const deadline = Date.now() + timeoutMs;
    try {
      // Let an in-flight flush finish within the budget, then send whatever
      // was queued while it ran (usage snapshot, beta.left, app.exit).
      const inFlight = this.flushPromise;
      if (inFlight) {
        await Promise.race([
          inFlight,
          new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now()))),
        ]);
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) await this.flush(remaining);
    } catch {
      // shutting down
    } finally {
      this.disposed = true;
    }
  }
}

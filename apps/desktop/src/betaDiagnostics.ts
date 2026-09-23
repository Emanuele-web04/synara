// FILE: betaDiagnostics.ts
// Purpose: Beta-only diagnostics queue for Synara Beta desktop builds.
// Layer: Desktop telemetry (runs only when the baked build flavor is "beta").
//
// Privacy contract (also documented in docs/diagnostics.md):
// - Only the fixed event names and payload fields declared in BetaDiagnosticsEvent
//   are ever written. There is no generic "metadata" bag.
// - No prompts, chat text, file contents, file paths, repo names, provider
//   payloads, credentials, or environment variables are collected.
// - The install id is a random UUID generated on first launch of a beta install;
//   it identifies an install, not a person.
// - Stable/production builds never construct this object, so the stable binary
//   has no live diagnostics code path.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** Override point for self-hosted / dev ingestion; production default ships in the binary. */
export const BETA_DIAGNOSTICS_ENDPOINT = "https://synara-beta-diagnostics.kartik-9f9.workers.dev";
export const BETA_DIAGNOSTICS_ENDPOINT_ENV = "SYNARA_BETA_DIAGNOSTICS_URL";

const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
const QUEUE_MAX_BYTES = 512 * 1024;
const QUEUE_TRIM_TARGET_BYTES = 256 * 1024;
const FLUSH_BATCH_MAX_EVENTS = 200;
const FLUSH_BATCH_MAX_BYTES = 256 * 1024;

/**
 * Allowlist of event names. Adding an event means extending this union and the
 * payload type below — there is deliberately no free-form field.
 */
export type BetaDiagnosticsEventName =
  | "app.start"
  | "app.exit"
  | "app.renderer-crash"
  | "app.child-process-crash"
  | "update.check"
  | "update.available"
  | "update.downloaded"
  | "update.installed"
  | "update.error";

export type BetaDiagnosticsPayload =
  | { readonly kind: "lifecycle"; readonly durationMs?: number }
  | { readonly kind: "crash"; readonly processType: string; readonly reason: string }
  | {
      readonly kind: "update";
      readonly outcome: "ok" | "error";
      readonly durationMs?: number;
      readonly targetVersion?: string;
      readonly errorContext?: "check" | "download" | "install";
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

/** Fields not on the allowlist are dropped, never coerced. */
export function sanitizeBetaDiagnosticsPayload(
  payload: BetaDiagnosticsPayload,
): BetaDiagnosticsPayload {
  if (payload.kind === "lifecycle") {
    return {
      kind: "lifecycle",
      ...(isFiniteNonNegative(payload.durationMs) ? { durationMs: payload.durationMs } : {}),
    };
  }
  if (payload.kind === "crash") {
    return {
      kind: "crash",
      processType: String(payload.processType).slice(0, 32),
      reason: String(payload.reason).slice(0, 64),
    };
  }
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

export function resolveBetaDiagnosticsEndpoint(env: NodeJS.ProcessEnv): string {
  const override = env[BETA_DIAGNOSTICS_ENDPOINT_ENV]?.trim();
  if (!override) return BETA_DIAGNOSTICS_ENDPOINT;
  // Loopback http targets are allowed so the worker can be developed locally;
  // remote overrides must be TLS.
  if (
    /^https:\/\//i.test(override) ||
    /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(override)
  ) {
    return override;
  }
  return BETA_DIAGNOSTICS_ENDPOINT;
}

export class BetaDiagnostics {
  /** Random UUID identifying this beta install; generated on first launch. */
  readonly installId: string;
  private readonly queuePath: string;
  private readonly endpoint: string;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
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
    this.endpoint = resolveBetaDiagnosticsEndpoint(input.env ?? process.env);
    this.installId = this.loadInstallId(input.homeDir);
    this.now = input.now ?? (() => new Date());
    this.appVersion = input.appVersion;
    this.platform = input.platform;
    this.arch = input.arch;
  }

  private readonly now: () => Date;
  private readonly appVersion: string;
  private readonly platform: string;
  private readonly arch: string;

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
      writeFileSync(idPath, `${generated}\n`, { encoding: "utf8", mode: 0o600 });
      return generated;
    } catch {
      return randomUUID();
    }
  }

  start(): void {
    if (this.flushTimer || this.disposed) return;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();
  }

  track(event: BetaDiagnosticsEventName, payload: BetaDiagnosticsPayload): void {
    if (this.disposed) return;
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
      payload: sanitizeBetaDiagnosticsPayload(payload),
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
   * for the next flush.
   */
  async flush(): Promise<void> {
    if (this.flushing || this.disposed) return;
    this.flushing = true;
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
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return;

      const rest = lines.slice(batch.length);
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
    } finally {
      this.flushing = false;
    }
  }

  /** Best-effort final flush + shutdown for app quit. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      await this.flush();
    } catch {
      // shutting down
    } finally {
      this.disposed = true;
    }
  }
}

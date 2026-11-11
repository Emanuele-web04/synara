import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Schema } from "effect";
import {
  ReliabilityInput,
  ReliabilityRecord,
  ReliabilityReleaseVersion,
  RELIABILITY_MAX_BODY_BYTES,
  RELIABILITY_MAX_EVENTS_PER_POST,
  RELIABILITY_MAX_RECORD_AGE_DAYS,
  type ProductAnalyticsChannel,
} from "@synara/contracts";

const ENDPOINT = "https://synara-beta-diagnostics.synara-orgs.workers.dev/v1/reliability-events";
const MAX_RECORDS = 500;
const RETRY_WINDOW_MS = RELIABILITY_MAX_RECORD_AGE_DAYS * 24 * 60 * 60 * 1000;
const decodeRecord = Schema.decodeUnknownSync(ReliabilityRecord);

/** Anonymous technical receipts, owned by the existing product-sharing choice. */
export class ReliabilityReporter {
  private readonly path: string;
  private readonly channel: ProductAnalyticsChannel;
  private readonly appVersion: string;
  private readonly platform: ReliabilityRecord["platform"];
  private readonly fetcher: typeof fetch;
  private enabled = false;
  private disposed = false;
  private epoch = 0;
  private queue: ReliabilityRecord[] = [];
  private needsPersistence = false;
  private interval: ReturnType<typeof setInterval> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private failures = 0;

  constructor(input: {
    homeDir: string;
    channel: ProductAnalyticsChannel;
    appVersion: string;
    platform: string;
    fetcher?: typeof fetch;
  }) {
    this.path = join(input.homeDir, "product-analytics", "reliability.json");
    this.channel = input.channel;
    this.appVersion = Schema.is(ReliabilityReleaseVersion)(input.appVersion)
      ? input.appVersion
      : "0.0.0";
    this.platform =
      input.platform === "darwin" || input.platform === "win32" || input.platform === "linux"
        ? input.platform
        : "other";
    this.fetcher = input.fetcher ?? fetch;
  }

  setEnabled(enabled: boolean, options?: { restorePending?: boolean }): void {
    if (this.disposed) return;
    this.epoch += 1;
    this.enabled = false;
    this.controller?.abort();
    this.controller = undefined;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    this.failures = 0;
    this.queue = [];
    this.needsPersistence = false;
    this.clearTemporaryFiles();
    if (!enabled) {
      this.removeRegularFile(this.path);
      return;
    }
    if (options?.restorePending) {
      try {
        const stat = lstatSync(this.path);
        if (stat.isFile() && stat.size <= 1024 * 1024) {
          const raw: unknown = JSON.parse(readFileSync(this.path, "utf8"));
          if (Array.isArray(raw)) {
            for (const row of raw.slice(-MAX_RECORDS)) {
              try {
                const record = decodeRecord(row);
                if (record.channel === this.channel && this.isCurrent(record))
                  this.queue.push(record);
              } catch {
                // Persisted data has the same strict boundary as network input.
              }
            }
          }
        }
      } catch {
        // A malformed or missing spool is replaced with a sanitized empty queue.
      }
      this.persistBestEffort();
    } else {
      // A new opt-in cannot resurrect a previous consent epoch, even if opt-out
      // cleanup failed. The caller must persist consent only after this succeeds.
      this.persist();
    }
    this.enabled = true;
    if (enabled && this.interval) void this.flush();
  }

  start(): void {
    if (this.disposed || this.interval) return;
    this.interval = setInterval(() => void this.flush(), 30_000);
    this.interval.unref?.();
    void this.flush();
  }

  track(input: unknown): void {
    if (this.disposed || !this.enabled) return;
    try {
      if (!Schema.is(ReliabilityInput)(input)) return;
      const record: ReliabilityRecord = {
        v: 1,
        id: randomUUID(),
        day: new Date().toISOString().slice(0, 10),
        code: input.code,
        channel: this.channel,
        appVersion: this.appVersion,
        platform: this.platform,
      };
      this.pruneExpired();
      this.queue.push(record);
      if (this.queue.length > MAX_RECORDS) this.queue.splice(0, this.queue.length - MAX_RECORDS);
      this.persist();
      if (this.interval) void this.flush();
    } catch {
      // Reporting must not change the action being observed.
    }
  }

  async flush(): Promise<void> {
    if (this.disposed || !this.enabled || this.controller || this.retry) return;
    this.pruneExpired();
    if (this.needsPersistence) this.persistBestEffort();
    const batch: ReliabilityRecord[] = [];
    for (const record of this.queue) {
      if (batch.length >= RELIABILITY_MAX_EVENTS_PER_POST) break;
      if (
        Buffer.byteLength(JSON.stringify({ events: [...batch, record] })) >
        RELIABILITY_MAX_BODY_BYTES
      )
        break;
      batch.push(record);
    }
    if (batch.length === 0) return;
    const epoch = this.epoch;
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await this.fetcher(ENDPOINT, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: batch }),
        signal: controller.signal,
      });
      // An older Worker may return 404; no status alone acknowledges a receipt.
      if (!response.ok) throw new Error("Reliability report was not acknowledged");
      const body: unknown = await response.json();
      if (
        !body ||
        typeof body !== "object" ||
        !("stored" in body) ||
        body.stored !== true ||
        !("acknowledged" in body) ||
        !Array.isArray(body.acknowledged)
      )
        throw new Error("Reliability receipt missing");
      const sent = new Set(batch.map(({ id }) => id));
      const acknowledged = new Set(
        body.acknowledged.filter((id): id is string => typeof id === "string" && sent.has(id)),
      );
      if (epoch !== this.epoch || !this.enabled || this.disposed) return;
      if (acknowledged.size === 0) throw new Error("Reliability receipt missing");
      this.queue = this.queue.filter(({ id }) => !acknowledged.has(id));
      this.persist();
      this.failures = 0;
      if (acknowledged.size < batch.length) this.scheduleRetry();
    } catch {
      if (epoch === this.epoch && this.enabled && !this.disposed) this.scheduleRetry();
    } finally {
      clearTimeout(timeout);
      if (this.controller === controller) this.controller = undefined;
      if (
        epoch === this.epoch &&
        this.enabled &&
        !this.disposed &&
        !this.retry &&
        this.queue.length
      )
        void this.flush();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.epoch += 1;
    this.controller?.abort();
    if (this.interval) clearInterval(this.interval);
    if (this.retry) clearTimeout(this.retry);
    this.interval = undefined;
    this.retry = undefined;
  }

  private scheduleRetry(): void {
    this.failures += 1;
    if (this.retry) return;
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(this.failures - 1, 6));
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.flush();
    }, delay);
    this.retry.unref?.();
  }

  private isCurrent(record: ReliabilityRecord): boolean {
    const today = Date.parse(new Date().toISOString().slice(0, 10));
    const day = Date.parse(record.day);
    return day <= today && day >= today - RETRY_WINDOW_MS;
  }

  private pruneExpired(): void {
    const count = this.queue.length;
    this.queue = this.queue.filter((record) => this.isCurrent(record));
    if (this.queue.length !== count) this.needsPersistence = true;
  }

  private persistBestEffort(): void {
    try {
      this.persist();
    } catch {
      // Leave the write pending for a later flush if storage is unavailable.
    }
  }

  private persist(): void {
    this.needsPersistence = true;
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp-${randomUUID()}`;
    try {
      writeFileSync(temporary, JSON.stringify(this.queue), { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.path);
      this.needsPersistence = false;
    } finally {
      this.removeRegularFile(temporary);
    }
  }

  private removeRegularFile(path: string): void {
    try {
      const stat = lstatSync(path);
      if (stat.isFile() || stat.isSymbolicLink()) rmSync(path);
    } catch {
      // A missing file is already cleared; a failed removal cannot re-enable sharing.
    }
  }

  private clearTemporaryFiles(): void {
    try {
      for (const name of readdirSync(dirname(this.path))) {
        if (/^reliability\.json\.tmp-(?:\d+|[0-9a-f-]{36})$/.test(name))
          this.removeRegularFile(join(dirname(this.path), name));
      }
    } catch {
      // Missing directories and cleanup errors cannot prevent opt-out.
    }
  }
}

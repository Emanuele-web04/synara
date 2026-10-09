import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type ProductAnalyticsChannel,
  type ProductAnalyticsEnvelope,
  type ProductAnalyticsInput,
} from "@synara/contracts";

const ENDPOINT = "https://synara-beta-diagnostics.synara-orgs.workers.dev/v1/product-events";
const MAX_QUEUE = 500;
const MAX_BATCH_EVENTS = 50;
const MAX_BATCH_BYTES = 64 * 1024;
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_000;
const FLUSH_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_COUNTER = 1_000_000_000_000;
const MAX_DURATION_MS = 86_400_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type ProductAnalyticsOptionalFields = {
  -readonly [Key in keyof Omit<
    ProductAnalyticsInput,
    "event" | "outcome"
  >]?: ProductAnalyticsInput[Key];
};

const EVENTS = [
  "app.open",
  "feature.used",
  "connection.pair",
  "connection.connect",
  "connection.reconnect",
  "chat.request",
  "turn.completed",
  "performance.startup",
] as const;
const OUTCOMES = ["started", "succeeded", "failed", "cancelled"] as const;
const FEATURES = [
  "chat",
  "connections",
  "inbox",
  "tasks",
  "hubs",
  "browser",
  "settings",
  "search",
  "project",
] as const;
const MODES = ["local", "remote"] as const;
const PROVIDERS = ["codex", "claude", "other"] as const;
const PLATFORMS = ["darwin", "win32", "linux", "ios", "ipados", "other"] as const;

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function validInteger(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}

function semver(value: string): string {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value) &&
    value.length <= 64
    ? value
    : "0.0.0";
}

function platform(value: string): ProductAnalyticsEnvelope["platform"] {
  return isOneOf(PLATFORMS, value) ? value : "other";
}

/** Consent-gated, bounded sender. It stores only reconstructed allowlisted envelopes. */
export class ProductAnalytics {
  private readonly consentPath: string;
  private readonly installIdPath: string;
  private readonly queuePath: string;
  private readonly channel: ProductAnalyticsChannel;
  private readonly appVersion: string;
  private readonly platform: ProductAnalyticsEnvelope["platform"];
  private enabled = false;
  private consentNeedsPersistence = false;
  private installId: string | null = null;
  private queue: ProductAnalyticsEnvelope[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private failures = 0;
  private epoch = 0;
  private flushing = false;
  private disposed = false;

  constructor(input: {
    homeDir: string;
    channel: ProductAnalyticsChannel;
    appVersion: string;
    platform: string;
    fetcher?: typeof fetch;
  }) {
    const dir = join(input.homeDir, "product-analytics");
    this.consentPath = join(dir, "consent.json");
    this.installIdPath = join(dir, "install-id");
    this.queuePath = join(dir, "events.json");
    this.channel = input.channel;
    this.appVersion = semver(input.appVersion);
    this.platform = platform(input.platform);
    this.fetcher = input.fetcher ?? fetch;
    this.enabled = this.readConsent();
    if (this.enabled) {
      try {
        this.installId = this.readOrCreateInstallId();
        this.queue = this.readQueue();
      } catch {
        this.installId = null;
        this.queue = [];
      }
    } else {
      this.clearPersistentData();
    }
  }

  private readonly fetcher: typeof fetch;

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref?.();
    if (this.enabled && !this.retryTimer) void this.flush();
  }

  getState(): { enabled: boolean } {
    return { enabled: this.enabled };
  }

  setEnabled(value: unknown): { enabled: boolean } {
    if (this.disposed) throw new Error("Product analytics is shutting down");
    if (typeof value !== "boolean") return this.getState();
    if (value === this.enabled && !(value === false && this.consentNeedsPersistence))
      return this.getState();
    this.epoch += 1;
    if (!value) {
      const wasEnabled = this.enabled;
      this.enabled = false;
      if (wasEnabled) {
        this.controller?.abort();
        this.controller = null;
        this.flushing = false;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.queue = [];
        this.installId = null;
      }
      let cleanupError: unknown;
      try {
        this.clearPersistentDataStrict();
      } catch (error) {
        cleanupError = error;
      }
      try {
        this.persistConsent();
      } catch (error) {
        this.removeConsentOnFailure();
        throw error;
      }
      if (cleanupError) throw cleanupError;
    } else {
      if (this.consentNeedsPersistence) this.persistConsent();
      this.clearPersistentDataStrict();
      this.installId = this.readOrCreateInstallId();
      this.queue = [];
      this.enabled = true;
      try {
        this.persistConsent();
      } catch (error) {
        this.enabled = false;
        this.installId = null;
        this.clearPersistentData();
        throw error;
      }
      this.failures = 0;
      if (this.timer && !this.retryTimer) void this.flush();
    }
    return this.getState();
  }

  track(input: unknown): void {
    if (this.disposed || !this.enabled || !this.installId) return;
    try {
      const envelope = this.buildEnvelope(input);
      if (!envelope) return;
      this.pruneExpired();
      this.queue.push(envelope);
      if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
      this.persistQueue();
      if (this.timer && !this.retryTimer) void this.flush();
    } catch {
      // Analytics never affects the observed product action.
    }
  }

  async flush(): Promise<void> {
    if (
      this.disposed ||
      !this.enabled ||
      this.flushing ||
      this.retryTimer ||
      this.queue.length === 0
    )
      return;
    this.pruneExpired();
    if (this.queue.length === 0) return;
    const batch: ProductAnalyticsEnvelope[] = [];
    for (const event of this.queue) {
      if (batch.length >= MAX_BATCH_EVENTS) break;
      const candidate = [...batch, event];
      if (Buffer.byteLength(JSON.stringify({ events: candidate }), "utf8") > MAX_BATCH_BYTES) break;
      batch.push(event);
    }
    if (batch.length === 0) {
      this.queue.shift();
      this.persistQueue();
      return;
    }
    this.flushing = true;
    const epoch = this.epoch;
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetcher(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: batch }),
        signal: controller.signal,
      });
      if (!response.ok) {
        if ([400, 413, 422].includes(response.status) && epoch === this.epoch && this.enabled) {
          const rejected = new Set(batch.map((event) => event.id));
          this.queue = this.queue.filter((event) => !rejected.has(event.id));
          this.persistQueue();
          this.failures = 0;
          return;
        }
        throw new Error("Product analytics request failed");
      }
      if (epoch !== this.epoch || !this.enabled) return;
      const sent = new Set(batch.map((event) => event.id));
      this.queue = this.queue.filter((event) => !sent.has(event.id));
      this.persistQueue();
      this.failures = 0;
    } catch {
      if (epoch === this.epoch && this.enabled && !this.disposed) this.scheduleRetry();
    } finally {
      clearTimeout(timeout);
      if (this.controller === controller) {
        this.controller = null;
        this.flushing = false;
      }
      if (this.enabled && !this.disposed && !this.retryTimer && this.queue.length > 0)
        void this.flush();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch += 1;
    if (this.timer) clearInterval(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.timer = null;
    this.retryTimer = null;
    this.controller?.abort();
    this.controller = null;
    this.flushing = false;
  }

  private buildEnvelope(value: unknown): ProductAnalyticsEnvelope | null {
    if (value === null || typeof value !== "object") return null;
    const input = value as Record<string, unknown>;
    const event = input.event;
    const outcome = input.outcome;
    if (!isOneOf(EVENTS, event) || !isOneOf(OUTCOMES, outcome)) return null;
    const fields: ProductAnalyticsOptionalFields = {};
    if (input.feature !== undefined) {
      if (!isOneOf(FEATURES, input.feature)) return null;
      fields.feature = input.feature;
    }
    if (input.mode !== undefined) {
      if (!isOneOf(MODES, input.mode)) return null;
      fields.mode = input.mode;
    }
    if (input.provider !== undefined) {
      if (!isOneOf(PROVIDERS, input.provider)) return null;
      fields.provider = input.provider;
    }
    if (input.durationMs !== undefined) {
      if (!validInteger(input.durationMs, MAX_DURATION_MS)) return null;
      fields.durationMs = input.durationMs;
    }
    for (const key of ["inputTokens", "outputTokens", "cachedInputTokens"] as const) {
      if (input[key] !== undefined) {
        if (!validInteger(input[key], MAX_COUNTER)) return null;
        fields[key] = input[key];
      }
    }
    const allowed = new Set<string>(["event", "outcome"]);
    if (event === "feature.used") {
      allowed.add("feature");
      allowed.add("mode");
    }
    if (
      ["connection.pair", "connection.connect", "connection.reconnect", "chat.request"].includes(
        event,
      )
    ) {
      allowed.add("mode");
      allowed.add("provider");
      allowed.add("durationMs");
    }
    if (event === "turn.completed") {
      allowed.add("mode");
      allowed.add("provider");
      allowed.add("durationMs");
      allowed.add("inputTokens");
      allowed.add("outputTokens");
      allowed.add("cachedInputTokens");
    }
    if (event === "performance.startup") allowed.add("durationMs");
    if (Object.keys(fields).some((key) => !allowed.has(key))) return null;
    if (event === "feature.used" && fields.feature === undefined) return null;
    const now = new Date();
    return {
      v: 1,
      id: randomUUID(),
      ts: now.toISOString(),
      installId: this.installId!,
      channel: this.channel,
      surface: "desktop",
      platform: this.platform,
      appVersion: this.appVersion,
      event,
      outcome,
      ...fields,
    };
  }

  private readConsent(): boolean {
    try {
      const value = JSON.parse(readFileSync(this.consentPath, "utf8")) as { enabled?: unknown };
      return value.enabled === true;
    } catch {
      return false;
    }
  }

  private readOrCreateInstallId(): string {
    try {
      const existing = readFileSync(this.installIdPath, "utf8").trim();
      if (UUID_PATTERN.test(existing)) return existing;
    } catch {
      // Created below only after explicit consent.
    }
    const id = randomUUID();
    this.writeAtomic(this.installIdPath, `${id}\n`, true);
    return id;
  }

  private readQueue(): ProductAnalyticsEnvelope[] {
    try {
      const values = JSON.parse(readFileSync(this.queuePath, "utf8")) as unknown;
      if (!Array.isArray(values)) return [];
      const valid = values.flatMap((item) => {
        const reconstructed = this.reconstructStoredEnvelope(item);
        return reconstructed ? [reconstructed] : [];
      });
      this.queue = valid.slice(-MAX_QUEUE);
      this.pruneExpired();
      this.persistQueue();
      return this.queue;
    } catch {
      return [];
    }
  }

  private reconstructStoredEnvelope(value: unknown): ProductAnalyticsEnvelope | null {
    if (value === null || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    if (
      row.v !== 1 ||
      typeof row.id !== "string" ||
      !UUID_PATTERN.test(row.id) ||
      typeof row.ts !== "string" ||
      !Number.isFinite(Date.parse(row.ts)) ||
      typeof row.installId !== "string" ||
      row.installId !== this.installId ||
      row.channel !== this.channel ||
      row.surface !== "desktop" ||
      typeof row.platform !== "string" ||
      !isOneOf(PLATFORMS, row.platform) ||
      typeof row.appVersion !== "string" ||
      semver(row.appVersion) !== row.appVersion
    )
      return null;
    const input: Record<string, unknown> = { event: row.event, outcome: row.outcome };
    for (const key of [
      "feature",
      "mode",
      "provider",
      "durationMs",
      "inputTokens",
      "outputTokens",
      "cachedInputTokens",
    ])
      if (Object.hasOwn(row, key)) input[key] = row[key];
    const safe = this.buildEnvelope(input);
    if (!safe) return null;
    return {
      ...safe,
      id: row.id,
      ts: new Date(row.ts).toISOString(),
      channel: row.channel as ProductAnalyticsChannel,
      platform: row.platform,
      appVersion: row.appVersion,
    };
  }

  private pruneExpired(): void {
    const cutoff = Date.now() - MAX_EVENT_AGE_MS;
    this.queue = this.queue.filter((event) => {
      const time = Date.parse(event.ts);
      return Number.isFinite(time) && time >= cutoff && time <= Date.now() + 5 * 60_000;
    });
  }

  private persistConsent(): void {
    try {
      this.writeAtomic(this.consentPath, JSON.stringify({ enabled: this.enabled }), true);
      this.consentNeedsPersistence = false;
    } catch (error) {
      this.consentNeedsPersistence = true;
      throw error;
    }
  }

  private persistQueue(): void {
    if (!this.enabled) return;
    this.writeAtomic(this.queuePath, JSON.stringify(this.queue));
  }

  private clearPersistentData(): void {
    for (const path of [this.installIdPath, this.queuePath]) {
      try {
        rmSync(path, { force: true });
      } catch {
        /* best effort */
      }
    }
  }

  private clearPersistentDataStrict(): void {
    for (const path of [this.installIdPath, this.queuePath]) {
      rmSync(path, { force: true });
    }
  }

  private removeConsentOnFailure(): void {
    try {
      rmSync(this.consentPath, { force: true });
    } catch {
      // An absent consent file means disabled; IPC rejects if durable opt-out cannot be recorded.
    }
  }

  private writeAtomic(path: string, content: string, required = false): void {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.tmp-${process.pid}`;
      writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
      renameSync(temp, path);
    } catch {
      if (required) throw new Error("Unable to persist product analytics consent");
      // Local analytics persistence must never affect the app.
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer || !this.enabled) return;
    this.failures += 1;
    const delay = Math.min(1_000 * 2 ** Math.min(this.failures - 1, 6), MAX_BACKOFF_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, delay);
    this.retryTimer.unref?.();
  }
}

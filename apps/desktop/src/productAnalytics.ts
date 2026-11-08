// Installation-only product sender; legacy account linkage is scrubbed before replay.
// Consent owns the queue, identity, and cancellation of active requests.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  isProductAnalyticsCommand,
  PRODUCT_COHORT_WINDOWS,
  type ProductAnalyticsCohortStage,
  type ProductAnalyticsChannel,
  type ProductAnalyticsEnvelope,
  type ProductAnalyticsInput,
} from "@synara/contracts";

type CohortState = { day: string; entryTs: string; completed: ProductAnalyticsCohortStage[] };

// Stable retries identify only a stage of this random installation, never an account.
function cohortEventId(installId: string, day: string, stage: ProductAnalyticsCohortStage): string {
  const bytes = createHash("sha256")
    .update(`synara-cohort-v1:${installId.toLowerCase()}:${day}:${stage}`)
    .digest();
  bytes[6] = (bytes[6]! & 15) | 128;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const ENDPOINT = "https://synara-beta-diagnostics.synara-orgs.workers.dev/v1/product-events";
const IDENTITY_VERSION = "2";
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
  "app.active",
  "feature.used",
  "command.used",
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
const REASONS = [
  "unreachable",
  "not_accepting",
  "account_unavailable",
  "host_unlinked",
  "pairing_required",
  "incompatible",
  "timeout",
  "invalid_code",
  "rejected",
  "other",
] as const;
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

/**
 * Consent-gated, bounded sender. It stores only reconstructed allowlisted envelopes.
 * `defaultEnabled` applies until the user makes a choice; an explicit opt-out persists.
 */
export class ProductAnalytics {
  private readonly consentPath: string;
  private readonly installIdPath: string;
  private readonly identityVersionPath: string;
  private readonly legacyAccountHashPath: string;
  private readonly queuePath: string;
  private readonly cohortPath: string;
  private cohort: CohortState | null = null;
  private cohortSupported = false;
  private readonly channel: ProductAnalyticsChannel;
  private readonly appVersion: string;
  private readonly platform: ProductAnalyticsEnvelope["platform"];
  private enabled = false;
  private readonly defaultEnabled: boolean;
  private readonly listeners = new Set<(enabled: boolean) => void>();
  private consentNeedsPersistence = false;
  private installId: string | null = null;
  private queue: ProductAnalyticsEnvelope[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private failures = 0;
  private activeDay: string | null = null;
  private epoch = 0;
  private flushing = false;
  private disposed = false;

  constructor(input: {
    homeDir: string;
    channel: ProductAnalyticsChannel;
    appVersion: string;
    platform: string;
    defaultEnabled?: boolean;
    fetcher?: typeof fetch;
  }) {
    const dir = join(input.homeDir, "product-analytics");
    this.consentPath = join(dir, "consent.json");
    this.installIdPath = join(dir, "install-id");
    this.identityVersionPath = join(dir, "identity-version");
    this.legacyAccountHashPath = join(dir, "account-hash");
    this.queuePath = join(dir, "events.json");
    this.cohortPath = join(dir, "cohort.json");
    this.channel = input.channel;
    this.appVersion = semver(input.appVersion);
    this.platform = platform(input.platform);
    this.fetcher = input.fetcher ?? fetch;
    this.defaultEnabled = input.defaultEnabled === true;
    this.enabled = this.readConsent();
    // Older clients kept an account-derived hash independently of consent.
    try {
      rmSync(this.legacyAccountHashPath, { force: true });
    } catch {
      /* best effort */
    }
    if (this.enabled) {
      try {
        this.clearTemporaryData();
        // A legacy UUID could still join older account-linked rows on an old receiver.
        if (!this.hasCurrentIdentity()) {
          this.clearPersistentDataStrict();
          this.writeAtomic(this.identityVersionPath, `${IDENTITY_VERSION}\n`, true);
        }
        this.installId = this.readOrCreateInstallId();
        this.queue = this.readQueue();
        this.cohort = this.readCohort();
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
    this.timer = setInterval(() => {
      this.trackActiveDay();
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    this.timer.unref?.();
    this.trackActiveDay();
    if (this.enabled && !this.retryTimer) void this.flush();
  }

  /** One app.active per UTC day while the app runs, so long sessions count every day. */
  private trackActiveDay(): void {
    if (!this.enabled) return;
    this.queueCohortStage();
    const day = new Date().toISOString().slice(0, 10);
    if (day === this.activeDay) return;
    this.activeDay = day;
    this.track({ event: "app.active", outcome: "succeeded" });
  }

  getState(): { enabled: boolean } {
    return { enabled: this.enabled };
  }

  /** Follows the user's choice, so companion diagnostics share one switch. */
  onChange(listener: (enabled: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.enabled);
      } catch {
        // A listener never changes the user's choice.
      }
    }
  }

  setEnabled(value: unknown): { enabled: boolean } {
    if (this.disposed) throw new Error("Product analytics is shutting down");
    if (typeof value !== "boolean") return this.getState();
    if (value === this.enabled && !(value === false && this.consentNeedsPersistence))
      return this.getState();
    this.epoch += 1;
    this.cohort = null;
    this.cohortSupported = false;
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
        this.activeDay = null;
      }
      // Companion collection must stop even if disk cleanup or consent persistence fails.
      this.notify();
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
      this.writeAtomic(this.identityVersionPath, `${IDENTITY_VERSION}\n`, true);
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
      if (this.timer) this.trackActiveDay();
      if (this.timer && !this.retryTimer) void this.flush();
    }
    if (value) this.notify();
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
      if (event.cohortStage && !this.cohortSupported) continue;
      if (batch.length >= MAX_BATCH_EVENTS) break;
      const candidate = [...batch, event];
      if (Buffer.byteLength(JSON.stringify({ events: candidate }), "utf8") > MAX_BATCH_BYTES) break;
      batch.push(event);
    }
    // An empty existing POST probes capability while holding restored cohort envelopes.
    if (batch.length === 0 && this.cohortSupported) return;
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
      this.cohortSupported = response.headers.get("x-synara-product-cohorts") === "1";
      const cohortAcknowledged = new Set<string>();
      if (this.cohortSupported && batch.some((event) => event.cohortStage)) {
        const receipt = (await response.json()) as { cohortAcknowledged?: unknown };
        if (Array.isArray(receipt.cohortAcknowledged))
          for (const id of receipt.cohortAcknowledged)
            if (typeof id === "string") cohortAcknowledged.add(id);
      }
      if (epoch !== this.epoch || !this.enabled) return;
      // Save completion before removing the durable envelope; a crash can only replay its UUID.
      if (this.cohort) {
        const completed = new Set(this.cohort.completed);
        for (const event of batch)
          if (
            event.cohortStage &&
            event.cohortDay === this.cohort.day &&
            cohortAcknowledged.has(event.id)
          )
            completed.add(event.cohortStage);
        const state = { ...this.cohort, completed: [...completed] };
        this.persistCohort(state);
        this.cohort = state;
      }
      const sent = new Set(
        batch
          .filter((event) => !event.cohortStage || cohortAcknowledged.has(event.id))
          .map((event) => event.id),
      );
      this.queue = this.queue.filter((event) => !sent.has(event.id));
      this.persistQueue();
      this.failures = 0;
      if (batch.some((event) => event.cohortStage && !cohortAcknowledged.has(event.id)))
        this.scheduleRetry();
      this.queueCohortStage();
    } catch {
      if (epoch === this.epoch && this.enabled && !this.disposed) this.scheduleRetry();
    } finally {
      clearTimeout(timeout);
      if (this.controller === controller) {
        this.controller = null;
        this.flushing = false;
      }
      if (
        this.enabled &&
        !this.disposed &&
        !this.retryTimer &&
        this.queue.some((event) => !event.cohortStage || this.cohortSupported)
      )
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
    if (input.reason !== undefined) {
      if (!isOneOf(REASONS, input.reason)) return null;
      fields.reason = input.reason;
    }
    if (input.command !== undefined) {
      if (!isProductAnalyticsCommand(input.command)) return null;
      fields.command = input.command;
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
      // Only a failure has a cause.
      if (outcome === "failed") allowed.add("reason");
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
    if (event === "command.used") allowed.add("command");
    if (Object.keys(fields).some((key) => !allowed.has(key))) return null;
    if (event === "feature.used" && fields.feature === undefined) return null;
    if (event === "command.used" && fields.command === undefined) return null;
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

  // Receiver support is re-established each process; old receivers never consume stage envelopes.
  private queueCohortStage(): void {
    if (!this.cohortSupported || !this.enabled || !this.installId) return;
    try {
      this.pruneExpired();
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      let state = this.cohort;
      if (
        !state ||
        (!state.completed.includes("new") &&
          Date.parse(state.entryTs) < now.getTime() - MAX_EVENT_AGE_MS)
      )
        state = { day, entryTs: now.toISOString(), completed: [] };
      const age = (Date.parse(day) - Date.parse(state.day)) / 86_400_000;
      const stage = !state.completed.includes("new")
        ? "new"
        : age >= 7 && age <= 13 && !state.completed.includes("week1")
          ? "week1"
          : age >= 30 && age <= 36 && !state.completed.includes("month1")
            ? "month1"
            : null;
      if (
        !stage ||
        this.queue.some((event) => event.cohortDay === state.day && event.cohortStage === stage)
      )
        return;
      const envelope = this.buildEnvelope({ event: "app.active", outcome: "succeeded" });
      if (!envelope) return;
      const event: ProductAnalyticsEnvelope = {
        ...envelope,
        id: cohortEventId(this.installId, state.day, stage),
        ts: stage === "new" ? state.entryTs : now.toISOString(),
        cohortDay: state.day,
        cohortStage: stage,
      };
      const queue = [...this.queue, event].slice(-MAX_QUEUE);
      // Queue first: recovery can reconstruct a missing entry state from its durable envelope.
      this.writeAtomic(this.queuePath, JSON.stringify(queue), true);
      this.queue = queue;
      this.cohort = state;
      this.persistCohort(state);
    } catch {
      /* A storage failure must not affect the workspace. */
    }
  }

  private persistCohort(state: CohortState): void {
    this.writeAtomic(
      this.cohortPath,
      JSON.stringify({ v: 1, installId: this.installId, ...state }),
      true,
    );
  }

  // A queue commit can be newer than an otherwise valid state file after a crash.
  private readCohort(): CohortState | null {
    let state: CohortState | null = null;
    try {
      const raw = JSON.parse(readFileSync(this.cohortPath, "utf8")) as Record<string, unknown>;
      if (
        raw.v === 1 &&
        raw.installId === this.installId &&
        typeof raw.day === "string" &&
        typeof raw.entryTs === "string" &&
        raw.entryTs.slice(0, 10) === raw.day &&
        Number.isFinite(Date.parse(raw.entryTs)) &&
        new Date(raw.entryTs).toISOString() === raw.entryTs &&
        Date.parse(raw.entryTs) <= Date.now() + 5 * 60_000 &&
        Array.isArray(raw.completed) &&
        raw.completed.every(
          (stage) => typeof stage === "string" && Object.hasOwn(PRODUCT_COHORT_WINDOWS, stage),
        )
      )
        state = {
          day: raw.day,
          entryTs: raw.entryTs,
          completed: raw.completed as ProductAnalyticsCohortStage[],
        };
    } catch {
      /* Reconcile below with any entry whose durable queue write survived. */
    }
    let entry: ProductAnalyticsEnvelope | undefined;
    for (const event of this.queue) {
      if (event.cohortStage === "new" && (!entry || Date.parse(event.ts) > Date.parse(entry.ts)))
        entry = event;
    }
    if (entry && (!state || Date.parse(entry.ts) > Date.parse(state.entryTs)))
      return { day: entry.cohortDay!, entryTs: entry.ts, completed: [] };
    return state;
  }

  private readConsent(): boolean {
    let raw: string;
    try {
      raw = readFileSync(this.consentPath, "utf8");
    } catch (error) {
      // Only a choice never made falls back to the default; an unreadable one stays off.
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? this.defaultEnabled : false;
    }
    try {
      const value = JSON.parse(raw) as { enabled?: unknown };
      return value.enabled === true;
    } catch {
      // A recorded but unreadable choice never re-enables collection.
      return false;
    }
  }

  /** A one-time boundary severs identifiers and unsent events from account-linked clients. */
  private hasCurrentIdentity(): boolean {
    try {
      return readFileSync(this.identityVersionPath, "utf8").trim() === IDENTITY_VERSION;
    } catch {
      return false;
    }
  }

  private readOrCreateInstallId(): string {
    try {
      const existing = readFileSync(this.installIdPath, "utf8").trim();
      if (UUID_PATTERN.test(existing)) return existing;
    } catch {
      // Created below once collection is enabled.
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
      "reason",
      "command",
      "durationMs",
      "inputTokens",
      "outputTokens",
      "cachedInputTokens",
    ])
      if (Object.hasOwn(row, key)) input[key] = row[key];
    const built = this.buildEnvelope(input);
    if (!built) return null;
    let cohort: { cohortDay: string; cohortStage: ProductAnalyticsCohortStage } | undefined;
    if (row.cohortDay !== undefined || row.cohortStage !== undefined) {
      if (
        typeof row.cohortDay !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(row.cohortDay) ||
        !Number.isFinite(Date.parse(row.cohortDay)) ||
        new Date(row.cohortDay).toISOString().slice(0, 10) !== row.cohortDay ||
        typeof row.cohortStage !== "string" ||
        !Object.hasOwn(PRODUCT_COHORT_WINDOWS, row.cohortStage) ||
        row.event !== "app.active" ||
        row.outcome !== "succeeded"
      )
        return null;
      const stage = row.cohortStage as ProductAnalyticsCohortStage;
      const age = (Date.parse(row.ts.slice(0, 10)) - Date.parse(row.cohortDay)) / 86_400_000;
      const [first, last] = PRODUCT_COHORT_WINDOWS[stage];
      if (
        age < first ||
        age > last ||
        row.id !== cohortEventId(this.installId!, row.cohortDay, stage)
      )
        return null;
      cohort = { cohortDay: row.cohortDay, cohortStage: stage };
    }
    // Rebuilding also discards legacy account hashes from the durable queue.
    return {
      ...built,
      ...cohort,
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

  /** Clear only this sender's orphaned atomic writes, preserving unrelated files and links. */
  private clearTemporaryData(): void {
    const dir = dirname(this.queuePath);
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (
          entry.isFile() &&
          /^(install-id|identity-version|account-hash|events\.json|cohort\.json)\.tmp-[1-9][0-9]*$/.test(
            entry.name,
          )
        ) {
          rmSync(join(dir, entry.name), { force: true });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private clearPersistentData(): void {
    for (const path of [
      this.installIdPath,
      this.identityVersionPath,
      this.legacyAccountHashPath,
      this.queuePath,
      this.cohortPath,
    ]) {
      try {
        rmSync(path, { force: true });
      } catch {
        /* best effort */
      }
    }
    try {
      this.clearTemporaryData();
    } catch {
      /* best effort */
    }
  }

  private clearPersistentDataStrict(): void {
    for (const path of [
      this.installIdPath,
      this.identityVersionPath,
      this.legacyAccountHashPath,
      this.queuePath,
      this.cohortPath,
    ]) {
      rmSync(path, { force: true });
    }
    this.clearTemporaryData();
  }

  private removeConsentOnFailure(): void {
    try {
      rmSync(this.consentPath, { force: true });
    } catch {
      // An absent consent file means disabled; IPC rejects if durable opt-out cannot be recorded.
    }
  }

  private writeAtomic(path: string, content: string, required = false): void {
    const temp = `${path}.tmp-${process.pid}`;
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
      renameSync(temp, path);
    } catch {
      if (required) throw new Error("Unable to persist product analytics consent");
      // Local analytics persistence must never affect the app.
    } finally {
      try {
        rmSync(temp, { force: true });
      } catch {
        /* best effort */
      }
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

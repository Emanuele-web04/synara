// FILE: apps/analytics/worker.ts
// Purpose: Cloudflare Worker ingest + dashboard API for Synara Beta diagnostics.
//
// Endpoints:
//   POST /v1/events   — NDJSON diagnostics events -> D1 `events` table
//   POST /v1/crash    — Electron minidump multipart upload -> R2 + `crash_dumps`
//   POST /api/login   — password login -> signed session cookie
//   GET  /api/*       — dashboard reads (session cookie required)
//   GET  /healthz     — liveness
//   GET  /*           — dashboard SPA (session required; /login is public)
//
// The worker is deliberately allowlist-shaped: unknown event names, unexpected
// field types, and oversized payloads are dropped rather than stored. Free-text
// fields are re-redacted server-side with the same rules the client applies.
// Deploy: `cd apps/analytics && wrangler deploy`

import { redactDiagnosticText } from "@synara/shared/diagnosticsRedaction";

export interface Env {
  DB: D1Database;
  /** Absent when the bucket cannot be provisioned; /v1/crash returns 503. */
  CRASH_DUMPS?: R2Bucket;
  ASSETS: Fetcher;
  /** Per-IP rate limit for ingest endpoints (120 req / 60 s). */
  INGEST_RATE_LIMITER?: RateLimit;
  /** Per-IP rate limit for the dashboard login (10 req / 60 s). */
  LOGIN_RATE_LIMITER?: RateLimit;
  /** Shared proof used only to trust the host-forwarded client IP on the
   *  diagnostics ingest routes. Product events remain directly rate-limited. */
  FORWARDER_SECRET?: string;
  DASHBOARD_PASSWORD?: string;
  /** Optional second dashboard password, e.g. for a teammate. */
  DASHBOARD_PASSWORD_2?: string;
  DASHBOARD_SESSION_KEY?: string;
  /** Cloudflare Access app AUD tag. When set, dashboard auth comes from the
   *  Cf-Access-Jwt-Assertion header instead of the password session. */
  POLICY_AUD?: string;
  /** Access team domain, e.g. "https://synara.cloudflareaccess.com". */
  TEAM_DOMAIN?: string;
  /** Comma-separated email allowlist checked against the Access JWT's email
   *  claim. Defense in depth on top of the Access app policy. */
  ALLOWED_EMAILS?: string;
  /** Optional shared ingest secret; required when set (Authorization: Bearer). */
  INGEST_TOKEN?: string;
  /** Max crash dump size accepted; default 5 MiB. */
  MAX_DUMP_BYTES?: string;
}

const PRODUCT_EVENTS = new Set([
  "app.open",
  "feature.used",
  "connection.pair",
  "connection.connect",
  "connection.reconnect",
  "chat.request",
  "turn.completed",
  "performance.startup",
]);
const PRODUCT_OUTCOMES = new Set(["started", "succeeded", "failed", "cancelled"]);
const PRODUCT_FEATURES = new Set([
  "chat",
  "connections",
  "inbox",
  "tasks",
  "hubs",
  "browser",
  "settings",
  "search",
  "project",
]);
const PRODUCT_MODES = new Set(["local", "remote"]);
const PRODUCT_PROVIDERS = new Set(["codex", "claude", "other"]);
const PRODUCT_CHANNELS = new Set(["stable", "beta"]);
const PRODUCT_SURFACES = new Set(["desktop", "ios", "ipados"]);
const PRODUCT_PLATFORMS = new Set(["darwin", "win32", "linux", "ios", "ipados", "other"]);
const PRODUCT_MAX_EVENTS_PER_POST = 50;
const PRODUCT_MAX_BODY_BYTES = 64 * 1024;
const PRODUCT_MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PRODUCT_MAX_EVENT_FUTURE_MS = 5 * 60 * 1000;
const PRODUCT_RETENTION_DAYS = 30;
const PRODUCT_RETENTION_DELETE_BATCH_SIZE = 10_000;
const PRODUCT_RETENTION_MAX_BATCHES = 10;
const PRODUCT_MAX_DURATION_MS = 86_400_000;
const PRODUCT_MAX_TOKEN_COUNT = 1_000_000_000_000;
const PRODUCT_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRODUCT_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PRODUCT_ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

interface NormalizedProductEvent {
  id: string;
  ts: string;
  installId: string;
  channel: string;
  surface: string;
  platform: string;
  appVersion: string;
  event: string;
  outcome: string;
  feature: string | null;
  mode: string | null;
  provider: string | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
}

const INSERT_PRODUCT_EVENT_SQL = `INSERT OR IGNORE INTO product_events (
  event_id, ts, received_at, install_id, channel, surface, platform, app_version,
  event, outcome, feature, mode, provider, duration_ms,
  input_tokens, output_tokens, cached_input_tokens
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function productEventStatement(
  env: Env,
  event: NormalizedProductEvent,
  receivedAt: string,
): D1PreparedStatement {
  return env.DB.prepare(INSERT_PRODUCT_EVENT_SQL).bind(
    event.id,
    event.ts,
    receivedAt,
    event.installId,
    event.channel,
    event.surface,
    event.platform,
    event.appVersion,
    event.event,
    event.outcome,
    event.feature,
    event.mode,
    event.provider,
    event.durationMs,
    event.inputTokens,
    event.outputTokens,
    event.cachedInputTokens,
  );
}

interface ProductFilters {
  from: string;
  to: string;
  fromTimestamp: string;
  beforeTimestamp: string;
  channel: string | null;
  surface: string | null;
  clause: string;
  binds: (string | number)[];
}

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseProductFilters(url: URL, now = Date.now()): ProductFilters | null {
  const today = new Date(now).toISOString().slice(0, 10);
  const defaultFrom = new Date(now - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const from = url.searchParams.get("from") ?? defaultFrom;
  const to = url.searchParams.get("to") ?? today;
  if (!validCalendarDate(from) || !validCalendarDate(to) || from > to) return null;
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toExclusiveMs = Date.parse(`${to}T00:00:00.000Z`) + DAY_MS;
  if (toExclusiveMs - fromMs > PRODUCT_RETENTION_DAYS * DAY_MS) return null;

  const rawChannel = url.searchParams.get("channel");
  const rawSurface = url.searchParams.get("surface");
  if (rawChannel && !PRODUCT_CHANNELS.has(rawChannel)) return null;
  if (rawSurface && !PRODUCT_SURFACES.has(rawSurface)) return null;
  const channel = rawChannel || null;
  const surface = rawSurface || null;
  const clauses = ["ts >= ?", "ts < ?"];
  const binds: (string | number)[] = [
    new Date(fromMs).toISOString(),
    new Date(toExclusiveMs).toISOString(),
  ];
  if (channel) {
    clauses.push("channel = ?");
    binds.push(channel);
  }
  if (surface) {
    clauses.push("surface = ?");
    binds.push(surface);
  }
  return {
    from,
    to,
    fromTimestamp: new Date(fromMs).toISOString(),
    beforeTimestamp: new Date(toExclusiveMs).toISOString(),
    channel,
    surface,
    clause: clauses.join(" AND "),
    binds,
  };
}

/** Product events intentionally have a separate, closed schema and table. */
export function normalizeProductEvent(
  raw: unknown,
  now = Date.now(),
): NormalizedProductEvent | null {
  if (!isRecord(raw) || raw.v !== 1) return null;
  if (typeof raw.id !== "string" || !PRODUCT_UUID_PATTERN.test(raw.id)) return null;
  if (typeof raw.installId !== "string" || !PRODUCT_UUID_PATTERN.test(raw.installId)) return null;
  if (raw.channel !== "stable" && raw.channel !== "beta") return null;
  if (!PRODUCT_SURFACES.has(String(raw.surface)) || !PRODUCT_PLATFORMS.has(String(raw.platform))) {
    return null;
  }
  if (
    typeof raw.appVersion !== "string" ||
    raw.appVersion.length > 64 ||
    !PRODUCT_VERSION_PATTERN.test(raw.appVersion)
  ) {
    return null;
  }
  if (typeof raw.event !== "string" || !PRODUCT_EVENTS.has(raw.event)) return null;
  if (typeof raw.outcome !== "string" || !PRODUCT_OUTCOMES.has(raw.outcome)) return null;
  if (typeof raw.ts !== "string" || !PRODUCT_ISO_TIMESTAMP_PATTERN.test(raw.ts)) return null;
  const tsMs = Date.parse(raw.ts);
  if (
    !Number.isFinite(tsMs) ||
    new Date(tsMs).toISOString().slice(0, 10) !== raw.ts.slice(0, 10) ||
    tsMs < now - PRODUCT_MAX_EVENT_AGE_MS ||
    tsMs > now + PRODUCT_MAX_EVENT_FUTURE_MS
  ) {
    return null;
  }

  const optionalEnum = (key: "feature" | "mode" | "provider", allowed: Set<string>) => {
    const value = raw[key];
    if (value === undefined) return null;
    return typeof value === "string" && allowed.has(value) ? value : undefined;
  };
  const feature = optionalEnum("feature", PRODUCT_FEATURES);
  const mode = optionalEnum("mode", PRODUCT_MODES);
  const provider = optionalEnum("provider", PRODUCT_PROVIDERS);
  if (feature === undefined || mode === undefined || provider === undefined) return null;

  const optionalCount = (
    key: "durationMs" | "inputTokens" | "outputTokens" | "cachedInputTokens",
    max: number,
  ) => {
    const value = raw[key];
    if (value === undefined) return null;
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max
      ? value
      : undefined;
  };
  const durationMs = optionalCount("durationMs", PRODUCT_MAX_DURATION_MS);
  const inputTokens = optionalCount("inputTokens", PRODUCT_MAX_TOKEN_COUNT);
  const outputTokens = optionalCount("outputTokens", PRODUCT_MAX_TOKEN_COUNT);
  const cachedInputTokens = optionalCount("cachedInputTokens", PRODUCT_MAX_TOKEN_COUNT);
  if (
    durationMs === undefined ||
    inputTokens === undefined ||
    outputTokens === undefined ||
    cachedInputTokens === undefined
  ) {
    return null;
  }

  // Reconstruct to strip all unknown keys before persistence.
  return {
    id: raw.id,
    ts: raw.ts,
    installId: raw.installId,
    channel: raw.channel,
    surface: raw.surface as string,
    platform: raw.platform as string,
    appVersion: raw.appVersion,
    event: raw.event,
    outcome: raw.outcome,
    feature,
    mode,
    provider,
    durationMs,
    inputTokens,
    outputTokens,
    cachedInputTokens,
  };
}

const KNOWN_EVENTS = new Set([
  "app.start",
  "app.exit",
  "app.error",
  "app.renderer-crash",
  "app.child-process-crash",
  "update.check",
  "update.available",
  "update.downloaded",
  "update.installed",
  "update.error",
  "usage.daily",
  "beta.installed",
  "beta.left",
]);

const MAX_NDJSON_BYTES = 256 * 1024;
const MAX_EVENTS_PER_POST = 400;
const MESSAGE_MAX = 1024;
const STACK_MAX = 8 * 1024;
const LOG_TAIL_MAX = 16 * 1024;
const LOGIN_BODY_MAX_BYTES = 4 * 1024;
// Multipart framing around the dump itself; the body cap is dump cap + this.
const MULTIPART_OVERHEAD_BYTES = 256 * 1024;
// Client timestamps this far ahead are clock skew, not data.
const MAX_EVENT_FUTURE_MS = 24 * 60 * 60 * 1000;
const MAX_EVENT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_COOKIE = "synara_beta_dash";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
// Nothing is deleted: events, usage rows, and minidumps are kept indefinitely.
// The dashboard's widest range ("All") is still capped at this many days.
const MAX_RANGE_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const OS_VERSION_PATTERN = /^\d{1,4}(\.\d{1,4})?$/;
const LOCALE_PATTERN = /^[a-z]{2,3}$/;
const PROVIDER_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const MAX_USAGE_PROVIDERS = 32;
const USAGE_COUNT_MAX = 100_000;
const BETA_INSTALLED_OUTCOMES = new Set(["imported", "import-failed", "fresh"]);
const BETA_LEFT_OUTCOMES = new Set(["trash", "keep"]);
// usage_providers binds 10 params per row; 9 rows keeps a multi-row INSERT
// under D1's 100-bound-parameter cap.
const USAGE_PROVIDER_ROWS_PER_STATEMENT = 9;

/** Usage counts are floored, non-negative, and capped — never free text. */
function clampUsageCount(value: unknown): number {
  const count = typeof value === "number" ? Math.floor(value) : Number.NaN;
  if (!Number.isFinite(count) || count < 0) return 0;
  return Math.min(count, USAGE_COUNT_MAX);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

interface UsageProviderRow {
  provider: string;
  threads: number;
  turns: number;
  turnsFailed: number;
}

interface NormalizedEvent {
  /** Client-generated event id; unique in the events table for idempotency. */
  clientId: string | null;
  ts: string;
  installId: string;
  appVersion: string;
  platform: string;
  arch: string;
  event: string;
  kind: string;
  outcome: string;
  processType: string;
  reason: string;
  errorContext: string;
  targetVersion: string;
  durationMs: number | null;
  source: string;
  fingerprint: string;
  message: string | null;
  stack: string | null;
  logTail: string | null;
  osVersion: string;
  locale: string;
  projects: number | null;
  activeThreads: number | null;
  /** usage.daily only: per-provider rows, merged and capped. */
  providers: UsageProviderRow[] | null;
}

/** Returns a normalized row for the `events` table, or null to drop. */
export function normalizeEvent(raw: unknown, now = Date.now()): NormalizedEvent | null {
  if (!isRecord(raw)) return null;
  if (raw.v !== 1 || typeof raw.event !== "string" || !KNOWN_EVENTS.has(raw.event)) {
    return null;
  }
  if (typeof raw.installId !== "string" || !UUID_PATTERN.test(raw.installId)) return null;
  if (raw.flavor !== "beta") return null;
  if (typeof raw.platform !== "string" || raw.platform.length > 16) return null;
  if (typeof raw.arch !== "string" || raw.arch.length > 16) return null;
  if (
    typeof raw.appVersion !== "string" ||
    raw.appVersion.length > 32 ||
    !VERSION_PATTERN.test(raw.appVersion)
  ) {
    return null;
  }
  if (typeof raw.ts !== "string" || raw.ts.length > 64) return null;
  const tsMs = Date.parse(raw.ts);
  if (Number.isNaN(tsMs)) return null;
  if (tsMs > now + MAX_EVENT_FUTURE_MS || tsMs < now - MAX_EVENT_AGE_MS) return null;
  const clientId = typeof raw.id === "string" && UUID_PATTERN.test(raw.id) ? raw.id : null;

  const payload = isRecord(raw.payload) ? raw.payload : {};
  const kind = typeof payload.kind === "string" ? payload.kind.slice(0, 16) : "";
  // update.* uses ok/error; beta.installed/beta.left carry their own closed
  // outcome sets and the whole event is dropped when the outcome is invalid.
  let outcome = payload.outcome === "error" ? "error" : "ok";
  if (raw.event === "beta.installed" || raw.event === "beta.left") {
    const allowed = raw.event === "beta.installed" ? BETA_INSTALLED_OUTCOMES : BETA_LEFT_OUTCOMES;
    if (typeof payload.outcome !== "string" || !allowed.has(payload.outcome)) return null;
    outcome = payload.outcome;
  }
  const processType =
    typeof payload.processType === "string" ? payload.processType.slice(0, 32) : "";
  const reason = typeof payload.reason === "string" ? payload.reason.slice(0, 64) : "";
  const errorContext =
    payload.errorContext === "check" ||
    payload.errorContext === "download" ||
    payload.errorContext === "install"
      ? payload.errorContext
      : "";
  const targetVersion =
    typeof payload.targetVersion === "string" && VERSION_PATTERN.test(payload.targetVersion)
      ? payload.targetVersion
      : "";
  const source =
    payload.source === "renderer" ? "renderer" : payload.source === "main" ? "main" : "";
  const fingerprint =
    typeof payload.fingerprint === "string" && /^[0-9a-f]{8,32}$/i.test(payload.fingerprint)
      ? payload.fingerprint
      : "";
  // Defense in depth: the client redacts before queueing; the worker does it
  // again so stored text is safe even from hand-crafted or old clients.
  const message =
    typeof payload.message === "string"
      ? redactDiagnosticText(payload.message, { maxLength: MESSAGE_MAX })
      : null;
  const stack =
    typeof payload.stack === "string"
      ? redactDiagnosticText(payload.stack, { maxLength: STACK_MAX })
      : null;
  const logTail =
    typeof payload.logTail === "string"
      ? redactDiagnosticText(payload.logTail, { maxLength: LOG_TAIL_MAX })
      : null;

  // lifecycle (app.start): OS major.minor and UI language only.
  const osVersion =
    kind === "lifecycle" &&
    typeof payload.osVersion === "string" &&
    OS_VERSION_PATTERN.test(payload.osVersion)
      ? payload.osVersion
      : "";
  const locale =
    kind === "lifecycle" &&
    typeof payload.locale === "string" &&
    LOCALE_PATTERN.test(payload.locale)
      ? payload.locale
      : "";

  // usage.daily: the event is dropped unless providers is an array; each entry
  // keeps only a provider token and clamped counts, merged per provider.
  let providers: UsageProviderRow[] | null = null;
  let projects: number | null = null;
  let activeThreads: number | null = null;
  if (raw.event === "usage.daily") {
    if (!Array.isArray(payload.providers)) return null;
    const merged = new Map<string, UsageProviderRow>();
    for (const entry of payload.providers.slice(0, MAX_USAGE_PROVIDERS)) {
      if (!isRecord(entry)) continue;
      if (typeof entry.provider !== "string" || !PROVIDER_PATTERN.test(entry.provider)) continue;
      const existing = merged.get(entry.provider) ?? {
        provider: entry.provider,
        threads: 0,
        turns: 0,
        turnsFailed: 0,
      };
      merged.set(entry.provider, {
        provider: entry.provider,
        threads: Math.min(existing.threads + clampUsageCount(entry.threads), USAGE_COUNT_MAX),
        turns: Math.min(existing.turns + clampUsageCount(entry.turns), USAGE_COUNT_MAX),
        turnsFailed: Math.min(
          existing.turnsFailed + clampUsageCount(entry.turnsFailed),
          USAGE_COUNT_MAX,
        ),
      });
    }
    providers = [...merged.values()];
    projects = payload.projects === undefined ? null : clampUsageCount(payload.projects);
    activeThreads =
      payload.activeThreads === undefined ? null : clampUsageCount(payload.activeThreads);
  }

  return {
    clientId,
    ts: raw.ts,
    installId: raw.installId,
    appVersion: raw.appVersion,
    platform: raw.platform,
    arch: raw.arch,
    event: raw.event,
    kind,
    outcome,
    processType,
    reason,
    errorContext,
    targetVersion,
    durationMs:
      isFiniteNumber(payload.durationMs) && payload.durationMs >= 0 ? payload.durationMs : null,
    source,
    fingerprint,
    message,
    stack,
    logTail,
    osVersion,
    locale,
    projects,
    activeThreads,
    providers,
  };
}

// INSERT OR IGNORE + the unique index on client_id make retried flushes
// idempotent: the same client event id is stored at most once.
const INSERT_EVENT_SQL = `INSERT OR IGNORE INTO events (
  client_id, ts, received_at, install_id, app_version, platform, arch, event,
  kind, outcome, process_type, reason, error_context, target_version,
  duration_ms, source, fingerprint, message, stack, log_tail,
  os_version, locale, projects, active_threads
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function eventStatement(env: Env, event: NormalizedEvent, receivedAt: string): D1PreparedStatement {
  return env.DB.prepare(INSERT_EVENT_SQL).bind(
    event.clientId,
    event.ts,
    receivedAt,
    event.installId,
    event.appVersion,
    event.platform,
    event.arch,
    event.event,
    event.kind,
    event.outcome,
    event.processType,
    event.reason,
    event.errorContext,
    event.targetVersion,
    event.durationMs,
    event.source,
    event.fingerprint,
    event.message,
    event.stack,
    event.logTail,
    event.osVersion,
    event.locale,
    event.projects,
    event.activeThreads,
  );
}

/** Multi-row usage_providers INSERT; rows stay under D1's bind cap. */
function usageProviderStatement(
  env: Env,
  eventId: number,
  event: NormalizedEvent,
  rows: UsageProviderRow[],
  receivedAt: string,
): D1PreparedStatement {
  const binds: (string | number)[] = [];
  const values = rows
    .map((row) => {
      binds.push(
        eventId,
        event.installId,
        event.ts.slice(0, 10),
        event.appVersion,
        event.platform,
        row.provider,
        row.threads,
        row.turns,
        row.turnsFailed,
        receivedAt,
      );
      return "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    })
    .join(", ");
  return env.DB.prepare(
    `INSERT INTO usage_providers (
      event_id, install_id, day, app_version, platform,
      provider, threads, turns, turns_failed, received_at
    ) VALUES ${values}`,
  ).bind(...binds);
}

/**
 * Reads a request body with a hard byte cap that does not trust
 * Content-Length. The stream is drained (never cancelled — workerd proxies
 * may drop the connection on mid-upload cancel) but at most maxBytes is
 * retained. Returns null when the cap is exceeded.
 */
async function readBodyBytes(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total <= maxBytes) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total > maxBytes) return null;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Per-IP rate-limit check; a missing/failing limiter must not break ingest. */
async function overRateLimit(
  limiter: RateLimit | undefined,
  request: Request,
  forwarderSecret?: string,
): Promise<boolean> {
  if (!limiter) return false;
  try {
    let key = request.headers.get("cf-connecting-ip") ?? "anonymous";
    const forwardedIp = request.headers.get("x-synara-client-ip");
    const proof = request.headers.get("x-synara-forwarder-secret");
    if (
      forwarderSecret &&
      proof &&
      forwardedIp &&
      forwardedIp.length <= 45 &&
      /^[0-9a-f:.]+$/i.test(forwardedIp) &&
      timingSafeEqual(new TextEncoder().encode(proof), new TextEncoder().encode(forwarderSecret))
    ) {
      key = forwardedIp;
    }
    const outcome = await limiter.limit({ key });
    return !outcome.success;
  } catch {
    return false;
  }
}

function authorizedIngest(request: Request, env: Env): boolean {
  if (!env.INGEST_TOKEN) return true;
  return request.headers.get("authorization") === `Bearer ${env.INGEST_TOKEN}`;
}

// --- Dashboard session -------------------------------------------------------

function encodeBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signSession(secret: string, expiresAtSeconds: number): Promise<string> {
  const payload = `${expiresAtSeconds}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(payload),
  );
  return `${payload}.${encodeBase64Url(signature)}`;
}

/** Constant-time compare over fixed-length buffers (hashes/signatures). */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

export async function verifySessionCookie(
  cookieHeader: string | null,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!cookieHeader) return false;
  const match = /(?:^|;\s*)synara_beta_dash=([0-9]+\.[A-Za-z0-9_-]+)/.exec(cookieHeader);
  if (!match) return false;
  const [expiryText, signature] = match[1]!.split(".");
  const expiresAt = Number(expiryText);
  if (!Number.isFinite(expiresAt) || expiresAt < nowSeconds) return false;
  const expected = encodeBase64Url(
    await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(expiryText!)),
  );
  return timingSafeEqual(new TextEncoder().encode(signature!), new TextEncoder().encode(expected));
}

async function passwordMatches(input: string, env: Env): Promise<boolean> {
  // Both sides are SHA-256 digests, so the compare is constant-time over equal
  // lengths regardless of the inputs. Every configured password is checked
  // without early exit so timing does not reveal which entry matched.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  let matched = false;
  for (const expected of [env.DASHBOARD_PASSWORD, env.DASHBOARD_PASSWORD_2]) {
    if (!expected) continue;
    const b = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
    );
    if (timingSafeEqual(new Uint8Array(digest), b)) matched = true;
  }
  return matched;
}

function sessionConfigured(env: Env): boolean {
  return Boolean((env.DASHBOARD_PASSWORD || env.DASHBOARD_PASSWORD_2) && env.DASHBOARD_SESSION_KEY);
}

// --- Cloudflare Access JWT -------------------------------------------------

function decodeBase64UrlJson(part: string): Record<string, unknown> | null {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlBytes(part)));
  } catch {
    return null;
  }
}

function base64UrlBytes(part: string): Uint8Array<ArrayBuffer> {
  const bin = atob(part.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

let accessKeysCache: { fetchedAt: number; keys: Map<string, CryptoKey> } | null = null;

async function accessPublicKeys(teamDomain: string): Promise<Map<string, CryptoKey>> {
  // Access rotates signing keys; a 6h cache refetches on unknown kid anyway.
  if (accessKeysCache && Date.now() - accessKeysCache.fetchedAt < 6 * 60 * 60 * 1000) {
    return accessKeysCache.keys;
  }
  const res = await fetch(`${teamDomain}/cdn-cgi/access/certs`, {
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`access certs fetch failed: ${res.status}`);
  const body = (await res.json()) as { public_certs?: Array<Record<string, unknown>> };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.public_certs ?? []) {
    if (typeof jwk.kid !== "string" || jwk.kty !== "RSA") continue;
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey(
        "jwk",
        jwk as JsonWebKey,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      ),
    );
  }
  accessKeysCache = { fetchedAt: Date.now(), keys };
  return keys;
}

/** Verify the Access-injected JWT: RS256 signature by the team's cert, our app
 *  AUD, unexpired, and (when configured) an allowlisted email claim. */
export async function verifyAccessJwt(
  token: string,
  env: Pick<Env, "POLICY_AUD" | "TEAM_DOMAIN" | "ALLOWED_EMAILS">,
  nowSeconds = Math.floor(Date.now() / 1000),
  getKeys: (teamDomain: string) => Promise<Map<string, CryptoKey>> = accessPublicKeys,
): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3 || !env.TEAM_DOMAIN || !env.POLICY_AUD) return false;
  const header = decodeBase64UrlJson(parts[0]!);
  const payload = decodeBase64UrlJson(parts[1]!);
  if (!header || !payload || header.alg !== "RS256" || typeof header.kid !== "string") {
    return false;
  }
  if (payload.iss !== env.TEAM_DOMAIN) return false;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.POLICY_AUD)) return false;
  if (typeof payload.exp !== "number" || payload.exp < nowSeconds) return false;
  if (env.ALLOWED_EMAILS) {
    const allowed = env.ALLOWED_EMAILS.split(",").map((e) => e.trim().toLowerCase());
    if (!allowed.includes(String(payload.email ?? "").toLowerCase())) return false;
  }
  let keys = await getKeys(env.TEAM_DOMAIN);
  let key = keys.get(header.kid);
  if (!key) {
    accessKeysCache = null; // rotate-safe: refetch once for an unknown kid
    keys = await getKeys(env.TEAM_DOMAIN);
    key = keys.get(header.kid);
    if (!key) return false;
  }
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  return crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, base64UrlBytes(parts[2]!), data);
}

async function hasSession(request: Request, env: Env): Promise<boolean> {
  if (env.POLICY_AUD) {
    const jwt = request.headers.get("cf-access-jwt-assertion");
    if (!jwt) return false;
    return verifyAccessJwt(jwt, env);
  }
  if (!env.DASHBOARD_SESSION_KEY) return false;
  return verifySessionCookie(request.headers.get("cookie"), env.DASHBOARD_SESSION_KEY);
}

// --- Dashboard API -----------------------------------------------------------

// Issue keys are bound into SQL, never interpolated, so any printable text
// after the prefix is fine (crash reasons like `code=1` are real keys).
const ISSUE_KEY_PATTERN = /^(err|crash|update):[^\x00-\x1f\x7f]{0,160}$/;
const PLATFORM_OPTIONS = new Set(["darwin", "win32", "linux"]);
const KIND_OPTIONS = new Set(["error", "crash", "update"]);
const SOURCE_OPTIONS = new Set(["main", "renderer"]);
const ISSUE_STATUSES = new Set(["resolved", "ignored"]);
const QUERY_MAX_LEN = 100;
const STATUS_BODY_MAX_BYTES = 1024;

interface ApiFilters {
  days: number;
  /** ISO cutoff for `ts >= since` — rolling `days`x24h before `now`. */
  since: string;
  /** Equal-length rolling window before `since` for "previous" deltas. */
  prevSince: string;
  /** ISO cutoff for day-bucketed queries — UTC midnight of today-days+1. */
  bucketSince: string;
  /** Single request instant so every bucket lands consistently. */
  now: number;
  version: string | null;
  platform: string | null;
  kind: "error" | "crash" | "update" | null;
  source: "main" | "renderer" | null;
  q: string | null;
  /** Non-time predicates over `events`, leading " AND ..."; pair with binds. */
  clause: string;
  binds: string[];
  /**
   * Version + platform only — used for install-level metrics (active installs,
   * crash-free %) where kind/source/q would distort the denominator.
   */
  scopeClause: string;
  scopeBinds: string[];
  /** Platform only — for the per-version releases table. */
  platformClause: string;
  platformBinds: string[];
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Parses dashboard query params; invalid values are dropped, never stored. */
export function parseApiFilters(url: URL, now = Date.now()): ApiFilters {
  const daysParam = Number(url.searchParams.get("days") ?? "7");
  const days = Number.isFinite(daysParam)
    ? Math.min(MAX_RANGE_DAYS, Math.max(1, Math.floor(daysParam)))
    : 7;
  // Stats and deltas use a rolling window [now - days*24h, now) so "24h" and
  // "last 7 days" stay honest at any hour. Charts and sparklines bucket on
  // calendar days instead: exactly `days` UTC days ending today.
  const since = new Date(now - days * DAY_MS).toISOString();
  const prevSince = new Date(now - 2 * days * DAY_MS).toISOString();
  const todayUtc = Date.parse(new Date(now).toISOString().slice(0, 10));
  const bucketSince = new Date(todayUtc - (days - 1) * DAY_MS).toISOString();

  const versionParam = url.searchParams.get("version");
  const version = versionParam && VERSION_PATTERN.test(versionParam) ? versionParam : null;

  const platformParam = url.searchParams.get("platform");
  const platform = platformParam && PLATFORM_OPTIONS.has(platformParam) ? platformParam : null;

  const kindParam = url.searchParams.get("kind");
  const kind = kindParam && KIND_OPTIONS.has(kindParam) ? (kindParam as ApiFilters["kind"]) : null;

  const sourceParam = url.searchParams.get("source");
  const source =
    sourceParam && SOURCE_OPTIONS.has(sourceParam) ? (sourceParam as ApiFilters["source"]) : null;

  const qParam = url.searchParams.get("q")?.trim() ?? "";
  const q = qParam.length > 0 ? qParam.slice(0, QUERY_MAX_LEN) : null;

  const scopeParts: string[] = [];
  const scopeBinds: string[] = [];
  if (version) {
    scopeParts.push("app_version = ?");
    scopeBinds.push(version);
  }
  if (platform) {
    scopeParts.push("platform = ?");
    scopeBinds.push(platform);
  }
  const parts = [...scopeParts];
  const binds = [...scopeBinds];
  if (kind === "error") parts.push("event = 'app.error'");
  else if (kind === "crash") {
    parts.push("event IN ('app.renderer-crash','app.child-process-crash')");
  } else if (kind === "update") parts.push("event = 'update.error'");
  // source only applies to error events; crashes and update rows keep no source.
  if (source) {
    parts.push("(event <> 'app.error' OR source = ?)");
    binds.push(source);
  }
  if (q) {
    parts.push("(message LIKE ? ESCAPE '\\' OR issue_key LIKE ? ESCAPE '\\')");
    const like = `%${escapeLike(q)}%`;
    binds.push(like, like);
  }
  return {
    days,
    since,
    prevSince,
    bucketSince,
    now,
    version,
    platform,
    kind,
    source,
    q,
    clause: parts.length > 0 ? ` AND ${parts.join(" AND ")}` : "",
    binds,
    scopeClause: scopeParts.length > 0 ? ` AND ${scopeParts.join(" AND ")}` : "",
    scopeBinds,
    platformClause: platform ? " AND platform = ?" : "",
    platformBinds: platform ? [platform] : [],
  };
}

/** Semver-aware descending sort (numeric segments first; beta.10 > beta.9). */
export function compareVersionsDesc(a: string, b: string): number {
  const split = (v: string) => v.split(/[.-]/).map((s) => (/^\d+$/.test(s) ? Number(s) : s));
  const pa = split(a);
  const pb = split(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return 1; // shorter (no prerelease) sorts newer
    if (y === undefined) return -1;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return y - x;
    } else if (typeof x === "number") {
      return -1; // numeric prerelease ids rank below alpha ones
    } else if (typeof y === "number") {
      return 1;
    } else if (x !== y) {
      return String(y).localeCompare(String(x));
    }
  }
  return 0;
}

interface IssueRow {
  key: string;
  kind: "error" | "crash" | "update";
  title: string;
  events: number;
  users: number;
  firstSeen: string;
  lastSeen: string;
  versions: string[];
  firstVersion: string;
  status: "open" | "resolved" | "ignored" | "regressed";
  isNew: boolean;
  trend: number[];
}

/** Public kind name for an issue key (`err:` -> `error`). */
function issueKind(key: string): IssueRow["kind"] {
  if (key.startsWith("err:")) return "error";
  if (key.startsWith("crash:")) return "crash";
  return "update";
}

const PROCESS_LABELS: Record<string, string> = {
  renderer: "App window",
  backend: "Backend",
  server: "Backend",
  GPU: "GPU process",
  Utility: "Utility process",
};

const REASON_LABELS: Record<string, string> = {
  killed: "was killed",
  oom: "ran out of memory",
  crashed: "crashed",
  "launch-failed": "failed to launch",
  "abnormal-exit": "exited abnormally",
  "integrity-failure": "failed integrity check",
};

function crashTitle(key: string): string {
  const rest = key.slice("crash:".length);
  const sep = rest.indexOf(":");
  const processType = sep === -1 ? rest : rest.slice(0, sep);
  const reason = sep === -1 ? "" : rest.slice(sep + 1);
  const process = PROCESS_LABELS[processType] ?? processType;
  if (!reason) return process;
  const mapped = REASON_LABELS[reason];
  if (mapped) return `${process} ${mapped}`;
  const code = /^code=(\d+)$/.exec(reason);
  if (code) return `${process} exited with code ${code[1]}`;
  return `${process} · ${reason}`;
}

function issueTitle(key: string, latestMessage: string | null): string {
  if (key.startsWith("crash:")) return crashTitle(key);
  if (key.startsWith("update:")) return `Update failed: ${key.slice("update:".length)}`;
  return latestMessage ?? "(no message)";
}

interface ReleaseRowData {
  version: string;
  firstSeen: string;
  installs: number;
  crashFreePct: number | null;
  errors: number;
  crashes: number;
  updateFailures: number;
  newIssues: number;
}

/** Release health bands — same thresholds the Releases badges use. */
export function releaseHealth(
  crashFreePct: number | null,
): "healthy" | "watch" | "unhealthy" | null {
  if (crashFreePct === null) return null;
  return crashFreePct >= 99.5 ? "healthy" : crashFreePct >= 98 ? "watch" : "unhealthy";
}

/** Per-version aggregate rows, semver-descending. Platform filter only. */
async function loadReleases(env: Env, f: ApiFilters): Promise<ReleaseRowData[]> {
  const [perVersion, firsts] = await Promise.all([
    env.DB.prepare(
      `SELECT app_version AS version, MIN(ts) AS firstSeen,
              COUNT(DISTINCT install_id) AS installs,
              SUM(CASE WHEN event = 'app.error' THEN 1 ELSE 0 END) AS errors,
              SUM(CASE WHEN event IN ('app.renderer-crash','app.child-process-crash') THEN 1 ELSE 0 END) AS crashes,
              SUM(CASE WHEN event = 'update.error' THEN 1 ELSE 0 END) AS updateFailures,
              COUNT(DISTINCT CASE WHEN event IN ('app.renderer-crash','app.child-process-crash')
                   THEN install_id END) AS crashInstalls
       FROM events WHERE ts >= ?${f.platformClause} GROUP BY app_version`,
    )
      .bind(f.since, ...f.platformBinds)
      .all<{
        version: string;
        firstSeen: string;
        installs: number;
        errors: number;
        crashes: number;
        updateFailures: number;
        crashInstalls: number;
      }>(),
    // Issues whose first-ever event ran this version. DISTINCT guards
    // against two events tying on MIN(ts).
    env.DB.prepare(
      `SELECT e.app_version AS version, COUNT(DISTINCT e.issue_key) AS n FROM events e
       INNER JOIN (
         SELECT issue_key, MIN(ts) AS mts FROM events
         WHERE issue_key IS NOT NULL GROUP BY issue_key
       ) m ON m.issue_key = e.issue_key AND e.ts = m.mts
       GROUP BY e.app_version`,
    ).all<{ version: string; n: number }>(),
  ]);
  const newIssuesByVersion = new Map(firsts.results.map((r) => [r.version, r.n]));
  return perVersion.results
    .map((r) => ({
      version: r.version,
      firstSeen: r.firstSeen,
      installs: r.installs,
      crashFreePct:
        r.installs > 0
          ? Math.round(((r.installs - r.crashInstalls) / r.installs) * 1000) / 10
          : null,
      errors: r.errors,
      crashes: r.crashes,
      updateFailures: r.updateFailures,
      newIssues: newIssuesByVersion.get(r.version) ?? 0,
    }))
    .sort((a, b) => compareVersionsDesc(a.version, b.version));
}

/** Day labels for a range: the UTC date of `since` through `now`'s date. */
export function rangeDays(since: string, now: number): string[] {
  const start = Date.parse(since.slice(0, 10));
  const today = Date.parse(new Date(now).toISOString().slice(0, 10));
  const labels: string[] = [];
  for (let day = start; day <= today; day += DAY_MS) {
    labels.push(new Date(day).toISOString().slice(0, 10));
  }
  return labels;
}

/** Day index within the range: 0 = `since`'s date, last = today. */
function dayIndex(ts: string, since: string, dayCount: number): number {
  const sinceDay = Date.parse(since.slice(0, 10));
  const rowDay = Date.parse(ts.slice(0, 10));
  const offset = Math.round((rowDay - sinceDay) / DAY_MS);
  return Math.min(dayCount - 1, Math.max(0, offset));
}

function placeholders(count: number): string {
  return new Array(count).fill("?").join(",");
}

/**
 * Loads issue aggregates for `key` (or all issues with in-range events when
 * null). D1 caps bound parameters at 100 per query, so no IN lists of keys —
 * each facet query is `issue_key = ?` or `issue_key IS NOT NULL`.
 * Enrichment is one grouped query per facet — no per-issue round trips.
 */
async function loadIssues(env: Env, f: ApiFilters, key: string | null): Promise<IssueRow[]> {
  const keyWhere = key === null ? "issue_key IS NOT NULL" : "issue_key = ?";
  const keyBinds = key === null ? [] : [key];

  const [agg, firsts, latest, statuses, trendRows] = await Promise.all([
    env.DB.prepare(
      `SELECT issue_key AS key, COUNT(*) AS events, COUNT(DISTINCT install_id) AS users,
              MAX(ts) AS lastSeen, GROUP_CONCAT(DISTINCT app_version) AS versionsCsv
       FROM events
       WHERE ${keyWhere} AND ts >= ?${f.clause}
       GROUP BY issue_key`,
    )
      .bind(...keyBinds, f.since, ...f.binds)
      .all<{
        key: string;
        events: number;
        users: number;
        lastSeen: string;
        versionsCsv: string | null;
      }>(),
    // First-ever event per issue — deliberately unfiltered: firstSeen and
    // firstVersion describe the issue, not the current view.
    env.DB.prepare(
      `SELECT e.issue_key AS key, e.ts AS firstSeen, e.app_version AS firstVersion
       FROM events e
       INNER JOIN (
         SELECT issue_key, MIN(ts) AS mts FROM events
         WHERE ${keyWhere} GROUP BY issue_key
       ) m ON m.issue_key = e.issue_key AND e.ts = m.mts`,
    )
      .bind(...keyBinds)
      .all<{ key: string; firstSeen: string; firstVersion: string }>(),
    // Latest in-range event per issue (title text for errors).
    env.DB.prepare(
      `SELECT e.issue_key AS key, e.message AS message
       FROM events e
       INNER JOIN (
         SELECT issue_key, MAX(ts) AS xts FROM events
         WHERE ${keyWhere} AND ts >= ?${f.clause} GROUP BY issue_key
       ) m ON m.issue_key = e.issue_key AND e.ts = m.xts`,
    )
      .bind(...keyBinds, f.since, ...f.binds)
      .all<{ key: string; message: string | null }>(),
    // strftime normalizes client timestamps ("YYYY-MM-DD HH:MM:SS" or ISO) so
    // the regressed comparison works regardless of the stored format.
    env.DB.prepare(
      `SELECT s.issue_key AS key, s.status,
              EXISTS(SELECT 1 FROM events e WHERE e.issue_key = s.issue_key
                     AND strftime('%Y-%m-%dT%H:%M:%fZ', e.ts) >
                         strftime('%Y-%m-%dT%H:%M:%fZ', s.updated_at)) AS regressed
       FROM issue_status s${key === null ? "" : " WHERE s.issue_key = ?"}`,
    )
      .bind(...keyBinds)
      .all<{ key: string; status: string; regressed: number }>(),
    env.DB.prepare(
      `SELECT issue_key AS key, substr(ts, 1, 10) AS day, COUNT(*) AS n
       FROM events WHERE ${keyWhere} AND ts >= ?${f.clause}
       GROUP BY issue_key, day`,
    )
      .bind(...keyBinds, f.bucketSince, ...f.binds)
      .all<{ key: string; day: string; n: number }>(),
  ]);

  const firstByKey = new Map(firsts.results.map((r) => [r.key, r]));
  const messageByKey = new Map(latest.results.map((r) => [r.key, r.message]));
  const statusByKey = new Map(statuses.results.map((r) => [r.key, r]));
  const dayCount = rangeDays(f.bucketSince, f.now).length;
  const trendByKey = new Map<string, number[]>();
  for (const row of trendRows.results) {
    const arr = trendByKey.get(row.key) ?? new Array(dayCount).fill(0);
    arr[dayIndex(row.day, f.bucketSince, dayCount)] += row.n;
    trendByKey.set(row.key, arr);
  }

  const issues: IssueRow[] = [];
  for (const row of agg.results) {
    const first = firstByKey.get(row.key);
    if (!first) continue; // every grouped key has a first event
    const statusRow = statusByKey.get(row.key);
    let status: IssueRow["status"] = "open";
    if (statusRow?.status === "ignored") status = "ignored";
    else if (statusRow?.status === "resolved") {
      status = statusRow.regressed ? "regressed" : "resolved";
    }
    issues.push({
      key: row.key,
      kind: issueKind(row.key),
      title: issueTitle(row.key, messageByKey.get(row.key) ?? null),
      events: row.events,
      users: row.users,
      firstSeen: first.firstSeen,
      lastSeen: row.lastSeen,
      versions: (row.versionsCsv ?? "").split(",").filter(Boolean).sort(compareVersionsDesc),
      firstVersion: first.firstVersion,
      status,
      isNew: f.version ? first.firstVersion === f.version : first.firstSeen >= f.since,
      trend: trendByKey.get(row.key) ?? new Array(dayCount).fill(0),
    });
  }
  return issues;
}

function sortIssues(issues: IssueRow[], sort: string | null): IssueRow[] {
  const by = {
    events: (a: IssueRow, b: IssueRow) => b.events - a.events,
    last: (a: IssueRow, b: IssueRow) => b.lastSeen.localeCompare(a.lastSeen),
    first: (a: IssueRow, b: IssueRow) => b.firstSeen.localeCompare(a.firstSeen),
    users: (a: IssueRow, b: IssueRow) => b.users - a.users || b.events - a.events,
  }[sort ?? "users"];
  return by ? [...issues].sort(by) : [...issues].sort((a, b) => b.users - a.users);
}

function statusMatches(issue: IssueRow, status: string): boolean {
  if (status === "all") return true;
  if (status === "resolved") return issue.status === "resolved";
  if (status === "ignored") return issue.status === "ignored";
  return issue.status === "open" || issue.status === "regressed";
}

function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/api/login" && request.method === "POST") {
    if (await overRateLimit(env.LOGIN_RATE_LIMITER, request)) {
      return new Response("rate limited", { status: 429 });
    }
    if (!sessionConfigured(env)) return new Response("dashboard not configured", { status: 503 });
    const bodyBytes = await readBodyBytes(request, LOGIN_BODY_MAX_BYTES);
    if (!bodyBytes) return new Response("payload too large", { status: 413 });
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return new Response("bad request", { status: 400 });
    }
    const password = isRecord(body) && typeof body.password === "string" ? body.password : "";
    if (!(await passwordMatches(password, env))) {
      return new Response("unauthorized", { status: 401 });
    }
    const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    const token = await signSession(env.DASHBOARD_SESSION_KEY!, expiresAt);
    return new Response("ok", {
      status: 200,
      headers: {
        "set-cookie": `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`,
      },
    });
  }

  if (url.pathname === "/api/logout" && request.method === "POST") {
    return new Response("ok", {
      headers: {
        "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
      },
    });
  }

  if (url.pathname === "/api/session") {
    return jsonResponse({ authenticated: await hasSession(request, env) });
  }

  // Everything below requires a valid session.
  if (!(await hasSession(request, env))) {
    return new Response("unauthorized", { status: 401 });
  }

  const f = parseApiFilters(url);

  if (url.pathname === "/api/filters" && request.method === "GET") {
    const rangeSince = new Date(Date.now() - MAX_RANGE_DAYS * DAY_MS).toISOString();
    const [versions, platforms] = await Promise.all([
      env.DB.prepare(`SELECT DISTINCT app_version AS version FROM events WHERE received_at >= ?`)
        .bind(rangeSince)
        .all<{ version: string }>(),
      env.DB.prepare(
        `SELECT DISTINCT platform FROM events WHERE received_at >= ? AND platform <> ''`,
      )
        .bind(rangeSince)
        .all<{ platform: string }>(),
    ]);
    return jsonResponse({
      versions: versions.results.map((r) => r.version).sort(compareVersionsDesc),
      platforms: platforms.results.map((r) => r.platform).sort(),
    });
  }

  if (url.pathname === "/api/overview" && request.method === "GET") {
    const dayAgo = new Date(Date.now() - DAY_MS).toISOString();
    const [active24h, activeRange, crashInstalls, updateFailures, series] = await Promise.all([
      // Install metrics use scopeClause only: kind/source/q would distort the
      // install denominator and make crash-free meaningless.
      env.DB.prepare(
        `SELECT COUNT(DISTINCT install_id) AS n FROM events WHERE ts >= ?${f.scopeClause}`,
      )
        .bind(dayAgo, ...f.scopeBinds)
        .first<{ n: number }>(),
      env.DB.prepare(
        `SELECT COUNT(DISTINCT install_id) AS n FROM events WHERE ts >= ?${f.scopeClause}`,
      )
        .bind(f.since, ...f.scopeBinds)
        .first<{ n: number }>(),
      env.DB.prepare(
        `SELECT COUNT(DISTINCT install_id) AS n FROM events
         WHERE ts >= ? AND event IN ('app.renderer-crash','app.child-process-crash')${f.scopeClause}`,
      )
        .bind(f.since, ...f.scopeBinds)
        .first<{ n: number }>(),
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM events WHERE ts >= ? AND event = 'update.error'${f.clause}`,
      )
        .bind(f.since, ...f.binds)
        .first<{ n: number }>(),
      env.DB.prepare(
        `SELECT substr(ts, 1, 10) AS day, event, COUNT(*) AS n FROM events
         WHERE ts >= ? AND event IN ('app.error','app.renderer-crash','app.child-process-crash','update.error')${f.clause}
         GROUP BY day, event`,
      )
        .bind(f.bucketSince, ...f.binds)
        .all<{ day: string; event: string; n: number }>(),
    ]);

    const timeseries: { day: string; errors: number; crashes: number; updateFailures: number }[] =
      [];
    const byDay = new Map<string, { errors: number; crashes: number; updateFailures: number }>();
    for (const row of series.results) {
      const bucket = byDay.get(row.day) ?? { errors: 0, crashes: 0, updateFailures: 0 };
      if (row.event === "app.error") bucket.errors += row.n;
      else if (row.event === "update.error") bucket.updateFailures += row.n;
      else bucket.crashes += row.n;
      byDay.set(row.day, bucket);
    }
    for (const day of rangeDays(f.bucketSince, f.now)) {
      const bucket = byDay.get(day) ?? { errors: 0, crashes: 0, updateFailures: 0 };
      timeseries.push({ day, ...bucket });
    }

    const active = activeRange?.n ?? 0;
    // "All" has no meaningful previous window — deltas stay null there. The
    // equal-length rolling window [prevSince, since) feeds the others.
    const hasPrevious = f.days < 365;
    const [activePrev, crashInstallsPrev, updatePrev, newIssuesPrev, lastEvent] = await Promise.all(
      [
        hasPrevious
          ? env.DB.prepare(
              `SELECT COUNT(DISTINCT install_id) AS n FROM events
               WHERE ts >= ? AND ts < ?${f.scopeClause}`,
            )
              .bind(f.prevSince, f.since, ...f.scopeBinds)
              .first<{ n: number }>()
          : null,
        hasPrevious
          ? env.DB.prepare(
              `SELECT COUNT(DISTINCT install_id) AS n FROM events
               WHERE ts >= ? AND ts < ?
                 AND event IN ('app.renderer-crash','app.child-process-crash')${f.scopeClause}`,
            )
              .bind(f.prevSince, f.since, ...f.scopeBinds)
              .first<{ n: number }>()
          : null,
        hasPrevious
          ? env.DB.prepare(
              `SELECT COUNT(*) AS n FROM events
               WHERE ts >= ? AND ts < ? AND event = 'update.error'${f.clause}`,
            )
              .bind(f.prevSince, f.since, ...f.binds)
              .first<{ n: number }>()
          : null,
        // Issues first-ever inside the previous window that also had an
        // in-scope event there — the same isNew definition, shifted back.
        hasPrevious
          ? env.DB.prepare(
              `SELECT COUNT(*) AS n FROM (
                 SELECT issue_key, MIN(ts) AS first FROM events
                 WHERE issue_key IS NOT NULL GROUP BY issue_key
               ) m
               WHERE m.first >= ? AND m.first < ?
                 AND EXISTS (
                   SELECT 1 FROM events e WHERE e.issue_key = m.issue_key
                     AND e.ts >= ? AND e.ts < ?${f.clause}
                 )`,
            )
              .bind(f.prevSince, f.since, f.prevSince, f.since, ...f.binds)
              .first<{ n: number }>()
          : null,
        env.DB.prepare(`SELECT MAX(ts) AS ts FROM events`).first<{ ts: string | null }>(),
      ],
    );
    const prevActive = activePrev?.n ?? 0;
    // isNew uses the same definition as the issues list: first-ever event in
    // the selected version when a version filter is set, else inside the range.
    const issues = await loadIssues(env, f, null);
    const releases = await loadReleases(env, f);
    // Under a version filter the latest-release line describes that version,
    // keeping it consistent with the headline's scope.
    const latest = f.version
      ? (releases.find((r) => r.version === f.version) ?? null)
      : (releases[0] ?? null);
    return jsonResponse({
      activeInstalls24h: active24h?.n ?? 0,
      activeInstalls: active,
      crashFreePct:
        active > 0 ? Math.round(((active - (crashInstalls?.n ?? 0)) / active) * 1000) / 10 : null,
      newIssues: issues.filter((issue) => issue.isNew).length,
      updateFailures: updateFailures?.n ?? 0,
      timeseries,
      topIssues: sortIssues(issues, "users").slice(0, 5),
      previous: {
        activeInstalls: hasPrevious ? prevActive : null,
        crashFreePct:
          hasPrevious && prevActive > 0
            ? Math.round(((prevActive - (crashInstallsPrev?.n ?? 0)) / prevActive) * 1000) / 10
            : null,
        // "First seen in this version" has no meaningful previous window, so
        // a version filter suppresses the delta entirely.
        newIssues: hasPrevious && f.version === null ? (newIssuesPrev?.n ?? 0) : null,
        updateFailures: hasPrevious ? (updatePrev?.n ?? 0) : null,
      },
      lastEventAt: lastEvent?.ts ?? null,
      latestRelease:
        latest === null
          ? null
          : { ...latest, health: latest.installs > 0 ? releaseHealth(latest.crashFreePct) : null },
    });
  }

  if (url.pathname === "/api/status" && request.method === "GET") {
    const row = await env.DB.prepare(`SELECT MAX(ts) AS ts FROM events`).first<{
      ts: string | null;
    }>();
    return jsonResponse({ lastEventAt: row?.ts ?? null });
  }

  if (url.pathname === "/api/activity" && request.method === "GET") {
    // The latest issue-class events plus the two beta lifecycle events.
    const rows = await env.DB.prepare(
      `SELECT id, ts, event, kind, issue_key AS issueKey, app_version AS appVersion,
              platform, outcome, message
       FROM events
       WHERE ts >= ?${f.clause}
         AND event IN ('app.error','app.renderer-crash','app.child-process-crash',
                       'update.error','beta.installed','beta.left')
       ORDER BY ts DESC LIMIT 15`,
    )
      .bind(f.since, ...f.binds)
      .all<{
        id: number;
        ts: string;
        event: string;
        kind: string;
        issueKey: string | null;
        appVersion: string;
        platform: string;
        outcome: string;
        message: string | null;
      }>();
    return jsonResponse({
      activity: rows.results.map((row) => ({
        id: row.id,
        ts: row.ts,
        event: row.event,
        kind: row.kind,
        issueKey: row.issueKey,
        title:
          row.event === "beta.installed"
            ? row.outcome === "imported"
              ? "New install (copied from Synara)"
              : row.outcome === "import-failed"
                ? "New install (import failed)"
                : "New install"
            : row.event === "beta.left"
              ? row.outcome === "trash"
                ? "Left Beta (moved to Trash)"
                : "Left Beta"
              : row.issueKey
                ? issueTitle(row.issueKey, row.message)
                : (row.message ?? "(no message)"),
        appVersion: row.appVersion,
        platform: row.platform,
        outcome: row.outcome,
      })),
    });
  }

  if (url.pathname === "/api/issues" && request.method === "GET") {
    const status = url.searchParams.get("status") ?? "open";
    const issues = sortIssues(await loadIssues(env, f, null), url.searchParams.get("sort"))
      .filter((issue) => statusMatches(issue, status))
      .slice(0, 200);
    return jsonResponse({ issues });
  }

  const issueMatch = /^\/api\/issues\/([^/]+)$/.exec(url.pathname);
  if (issueMatch) {
    let key: string;
    try {
      key = decodeURIComponent(issueMatch[1]!);
    } catch {
      return new Response("bad issue key", { status: 400 });
    }
    if (!ISSUE_KEY_PATTERN.test(key)) {
      return new Response("bad issue key", { status: 400 });
    }

    if (request.method === "GET") {
      const [issueRows, detailRow, seriesRows, byVersion, byPlatform, occurrences] =
        await Promise.all([
          loadIssues(env, f, key),
          env.DB.prepare(
            `SELECT message, stack, log_tail AS logTail, process_type AS processType,
                    reason, error_context AS errorContext
             FROM events WHERE issue_key = ? AND ts >= ?${f.clause}
             ORDER BY ts DESC LIMIT 1`,
          )
            .bind(key, f.since, ...f.binds)
            .first<{
              message: string | null;
              stack: string | null;
              logTail: string | null;
              processType: string;
              reason: string;
              errorContext: string;
            }>(),
          env.DB.prepare(
            `SELECT substr(ts, 1, 10) AS day, COUNT(*) AS n FROM events
             WHERE issue_key = ? AND ts >= ?${f.clause} GROUP BY day`,
          )
            .bind(key, f.bucketSince, ...f.binds)
            .all<{ day: string; n: number }>(),
          env.DB.prepare(
            `SELECT app_version AS version, COUNT(*) AS events,
                    COUNT(DISTINCT install_id) AS users
             FROM events WHERE issue_key = ? AND ts >= ?${f.clause} GROUP BY app_version`,
          )
            .bind(key, f.since, ...f.binds)
            .all<{ version: string; events: number; users: number }>(),
          env.DB.prepare(
            `SELECT platform, COUNT(*) AS events, COUNT(DISTINCT install_id) AS users
             FROM events WHERE issue_key = ? AND ts >= ?${f.clause} GROUP BY platform`,
          )
            .bind(key, f.since, ...f.binds)
            .all<{ platform: string; events: number; users: number }>(),
          env.DB.prepare(
            `SELECT id, ts, app_version AS appVersion, platform, arch, source,
                    install_id AS installId
             FROM events WHERE issue_key = ? AND ts >= ?${f.clause}
             ORDER BY ts DESC LIMIT 50`,
          )
            .bind(key, f.since, ...f.binds)
            .all<{
              id: number;
              ts: string;
              appVersion: string;
              platform: string;
              arch: string;
              source: string;
              installId: string;
            }>(),
        ]);

      if (issueRows.length === 0) return new Response("not found", { status: 404 });
      const issue = issueRows[0]!;

      const dayCount = rangeDays(f.bucketSince, f.now).length;
      const dayCounts = new Array(dayCount).fill(0) as number[];
      for (const row of seriesRows.results) {
        dayCounts[dayIndex(row.day, f.bucketSince, dayCount)] += row.n;
      }

      // Minidumps land minutes from the crash event; join in JS instead of
      // issuing one query per occurrence. The IN list binds at most 50
      // install ids + 2 — under D1's 100-parameter cap.
      let dumpsByOccurrence = new Map<number, { id: number; r2Key: string; size: number }[]>();
      const occ = occurrences.results;
      if (occ.length > 0) {
        const installIds = [...new Set(occ.map((o) => o.installId))];
        const minTs = new Date(Date.parse(occ[occ.length - 1]!.ts) - 10 * 60 * 1000).toISOString();
        const maxTs = new Date(Date.parse(occ[0]!.ts) + 10 * 60 * 1000).toISOString();
        const dumps = await env.DB.prepare(
          `SELECT id, r2_key AS r2Key, size, ts, install_id AS installId FROM crash_dumps
           WHERE install_id IN (${placeholders(installIds.length)}) AND ts BETWEEN ? AND ?`,
        )
          .bind(...installIds, minTs, maxTs)
          .all<{ id: number; r2Key: string; size: number; ts: string; installId: string }>();
        dumpsByOccurrence = new Map();
        for (const dump of dumps.results) {
          for (const o of occ) {
            if (
              o.installId === dump.installId &&
              Math.abs(Date.parse(dump.ts) - Date.parse(o.ts)) <= 10 * 60 * 1000
            ) {
              const list = dumpsByOccurrence.get(o.id) ?? [];
              list.push({ id: dump.id, r2Key: dump.r2Key, size: dump.size });
              dumpsByOccurrence.set(o.id, list);
            }
          }
        }
      }

      return jsonResponse({
        issue,
        detail: detailRow ?? null,
        timeseries: dayCounts,
        byVersion: [...byVersion.results].sort((a, b) => compareVersionsDesc(a.version, b.version)),
        byPlatform: byPlatform.results,
        occurrences: occ.map((o) => ({
          ...o,
          installId: o.installId.slice(0, 8),
          dumps: dumpsByOccurrence.get(o.id) ?? [],
        })),
      });
    }
  }

  const issueStatusMatch = /^\/api\/issues\/([^/]+)\/status$/.exec(url.pathname);
  if (issueStatusMatch && request.method === "POST") {
    let key: string;
    try {
      key = decodeURIComponent(issueStatusMatch[1]!);
    } catch {
      return new Response("bad issue key", { status: 400 });
    }
    if (!ISSUE_KEY_PATTERN.test(key)) {
      return new Response("bad issue key", { status: 400 });
    }
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.startsWith("application/json")) {
      return new Response("expected application/json", { status: 415 });
    }
    const bodyBytes = await readBodyBytes(request, STATUS_BODY_MAX_BYTES);
    if (!bodyBytes) return new Response("payload too large", { status: 413 });
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return new Response("bad request", { status: 400 });
    }
    const status = isRecord(body) && typeof body.status === "string" ? body.status : "";
    if (status === "open") {
      await env.DB.prepare(`DELETE FROM issue_status WHERE issue_key = ?`).bind(key).run();
      return jsonResponse({ status: "open" });
    }
    if (!ISSUE_STATUSES.has(status)) {
      return new Response("bad status", { status: 400 });
    }
    await env.DB.prepare(
      `INSERT INTO issue_status (issue_key, status, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(issue_key) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
    )
      .bind(key, status, new Date().toISOString())
      .run();
    return jsonResponse({ status });
  }

  if (url.pathname === "/api/usage" && request.method === "GET") {
    // Install-level metrics use scopeClause (version + platform) only.
    const [active, installsByDay, turnStats, newInstallRows, leftRows, providerRows, localeRows] =
      await Promise.all([
        env.DB.prepare(
          `SELECT COUNT(DISTINCT install_id) AS n FROM events WHERE ts >= ?${f.scopeClause}`,
        )
          .bind(f.since, ...f.scopeBinds)
          .first<{ n: number }>(),
        env.DB.prepare(
          `SELECT substr(ts, 1, 10) AS day, COUNT(DISTINCT install_id) AS n
           FROM events WHERE ts >= ?${f.scopeClause} GROUP BY day ORDER BY day`,
        )
          .bind(f.bucketSince, ...f.scopeBinds)
          .all<{ day: string; n: number }>(),
        env.DB.prepare(
          `SELECT COALESCE(SUM(up.turns), 0) AS turns,
                  COALESCE(SUM(up.turns_failed), 0) AS failed
           FROM usage_providers up JOIN events e ON e.id = up.event_id
           WHERE e.ts >= ?${f.scopeClause}`,
        )
          .bind(f.since, ...f.scopeBinds)
          .first<{ turns: number; failed: number }>(),
        env.DB.prepare(
          `SELECT outcome, COUNT(*) AS n FROM events
           WHERE event = 'beta.installed' AND ts >= ?${f.scopeClause} GROUP BY outcome`,
        )
          .bind(f.since, ...f.scopeBinds)
          .all<{ outcome: string; n: number }>(),
        env.DB.prepare(
          `SELECT outcome, COUNT(*) AS n FROM events
           WHERE event = 'beta.left' AND ts >= ?${f.scopeClause} GROUP BY outcome`,
        )
          .bind(f.since, ...f.scopeBinds)
          .all<{ outcome: string; n: number }>(),
        env.DB.prepare(
          `SELECT up.provider AS provider, COUNT(DISTINCT up.install_id) AS installs,
                  SUM(up.threads) AS threads, SUM(up.turns) AS turns,
                  SUM(up.turns_failed) AS failed
           FROM usage_providers up JOIN events e ON e.id = up.event_id
           WHERE e.ts >= ?${f.scopeClause} GROUP BY up.provider ORDER BY installs DESC`,
        )
          .bind(f.since, ...f.scopeBinds)
          .all<{
            provider: string;
            installs: number;
            threads: number;
            turns: number;
            failed: number;
          }>(),
        // Each install's latest app.start in range carries its OS and locale.
        env.DB.prepare(
          `SELECT e.platform AS platform, e.os_version AS osVersion, e.locale AS locale,
                  COUNT(DISTINCT e.install_id) AS installs
           FROM events e
           INNER JOIN (
             SELECT install_id, MAX(ts) AS mts FROM events
             WHERE event = 'app.start' AND ts >= ?${f.scopeClause} GROUP BY install_id
           ) m ON m.install_id = e.install_id AND e.ts = m.mts
           WHERE e.event = 'app.start'
           GROUP BY e.platform, e.os_version, e.locale`,
        )
          .bind(f.since, ...f.scopeBinds)
          .all<{ platform: string; osVersion: string; locale: string; installs: number }>(),
      ]);
    const activeInstalls = active?.n ?? 0;
    const turns = turnStats?.turns ?? 0;
    const turnsFailed = turnStats?.failed ?? 0;
    const countBy = (rows: readonly { outcome: string; n: number }[], key: string) =>
      rows.find((r) => r.outcome === key)?.n ?? 0;
    const osMap = new Map<string, { platform: string; osVersion: string; installs: number }>();
    const localeMap = new Map<string, number>();
    for (const row of localeRows.results) {
      if (row.osVersion) {
        const key = `${row.platform}:${row.osVersion}`;
        const existing = osMap.get(key) ?? {
          platform: row.platform,
          osVersion: row.osVersion,
          installs: 0,
        };
        existing.installs += row.installs;
        osMap.set(key, existing);
      }
      if (row.locale) {
        localeMap.set(row.locale, (localeMap.get(row.locale) ?? 0) + row.installs);
      }
    }
    return jsonResponse({
      activeInstalls,
      installsByDay: installsByDay.results,
      turns,
      turnsFailedPct: turns > 0 ? Math.round((turnsFailed / turns) * 1000) / 10 : 0,
      newInstalls: {
        imported: countBy(newInstallRows.results, "imported"),
        importFailed: countBy(newInstallRows.results, "import-failed"),
        fresh: countBy(newInstallRows.results, "fresh"),
      },
      left: {
        trash: countBy(leftRows.results, "trash"),
        keep: countBy(leftRows.results, "keep"),
      },
      providers: providerRows.results.map((r) => ({
        provider: r.provider,
        installs: r.installs,
        sharePct: activeInstalls > 0 ? Math.round((r.installs / activeInstalls) * 1000) / 10 : 0,
        threads: r.threads,
        turns: r.turns,
        failedPct: r.turns > 0 ? Math.round((r.failed / r.turns) * 1000) / 10 : 0,
      })),
      osVersions: [...osMap.values()].sort((a, b) => b.installs - a.installs),
      locales: [...localeMap.entries()]
        .map(([locale, installs]) => ({ locale, installs }))
        .sort((a, b) => b.installs - a.installs),
    });
  }

  if (url.pathname === "/api/product" && request.method === "GET") {
    const productFilters = parseProductFilters(url);
    if (!productFilters) return new Response("bad product filters", { status: 400 });
    const where = productFilters.clause;
    const binds = productFilters.binds;
    const terminalTurn =
      "event = 'turn.completed' AND surface = 'desktop' AND outcome IN ('succeeded', 'failed', 'cancelled')";
    const periodMs =
      Date.parse(productFilters.beforeTimestamp) - Date.parse(productFilters.fromTimestamp);
    const previousFrom = new Date(
      Date.parse(productFilters.fromTimestamp) - periodMs,
    ).toISOString();
    // Compare only full UTC days inside retention; a partial baseline is misleading.
    const comparisonAvailable =
      Date.parse(previousFrom) >= Date.now() - PRODUCT_RETENTION_DAYS * DAY_MS &&
      Date.parse(productFilters.beforeTimestamp) <=
        Date.parse(new Date().toISOString().slice(0, 10));
    const previousBinds = [previousFrom, productFilters.fromTimestamp, ...binds.slice(2)];

    const [
      totals,
      dailyRows,
      featureRows,
      outcomeRows,
      latencyRows,
      eventRows,
      tokenRows,
      providerRows,
      providerDailyRows,
      previousRows,
    ] = await Promise.all([
      env.DB.prepare(
        `SELECT COUNT(*) AS events, COUNT(DISTINCT install_id) AS installations
           FROM product_events WHERE ${where}`,
      )
        .bind(...binds)
        .first<{ events: number; installations: number }>(),
      env.DB.prepare(
        `SELECT substr(ts, 1, 10) AS day, COUNT(*) AS events,
                  COUNT(DISTINCT install_id) AS installations,
                  SUM(CASE WHEN ${terminalTurn} THEN 1 ELSE 0 END) AS turns
           FROM product_events WHERE ${where} GROUP BY day ORDER BY day`,
      )
        .bind(...binds)
        .all<{ day: string; events: number; installations: number; turns: number }>(),
      env.DB.prepare(
        `SELECT feature, COUNT(*) AS events, COUNT(DISTINCT install_id) AS installations
           FROM product_events WHERE ${where} AND event = 'feature.used' AND feature IS NOT NULL
           GROUP BY feature ORDER BY events DESC, feature`,
      )
        .bind(...binds)
        .all<{ feature: string; events: number; installations: number }>(),
      env.DB.prepare(
        `SELECT event, outcome, COUNT(*) AS events
           FROM product_events WHERE ${where}
           GROUP BY event, outcome ORDER BY event, outcome`,
      )
        .bind(...binds)
        .all<{ event: string; outcome: string; events: number }>(),
      env.DB.prepare(
        `SELECT event, AVG(duration_ms) AS meanDurationMs,
                  COUNT(duration_ms) AS samples
           FROM product_events WHERE ${where} AND duration_ms IS NOT NULL
           GROUP BY event ORDER BY event`,
      )
        .bind(...binds)
        .all<{ event: string; meanDurationMs: number; samples: number }>(),
      env.DB.prepare(
        `SELECT event, COUNT(*) AS events, COUNT(DISTINCT install_id) AS installations
           FROM product_events WHERE ${where} GROUP BY event ORDER BY events DESC, event`,
      )
        .bind(...binds)
        .all<{ event: string; events: number; installations: number }>(),
      env.DB.prepare(
        `SELECT SUM(input_tokens) AS inputTokens, COUNT(input_tokens) AS inputSamples,
                  SUM(output_tokens) AS outputTokens, COUNT(output_tokens) AS outputSamples,
                  SUM(cached_input_tokens) AS cachedInputTokens,
                  COUNT(cached_input_tokens) AS cachedInputSamples
           FROM product_events
           WHERE ${where} AND ${terminalTurn}`,
      )
        .bind(...binds)
        .first<{
          inputTokens: number | null;
          inputSamples: number;
          outputTokens: number | null;
          outputSamples: number;
          cachedInputTokens: number | null;
          cachedInputSamples: number;
        }>(),
      env.DB.prepare(
        `SELECT COALESCE(provider, 'unknown') AS provider, COUNT(*) AS turns,
                  SUM(outcome = 'succeeded') AS succeeded,
                  SUM(outcome = 'failed') AS failed,
                  SUM(outcome = 'cancelled') AS cancelled,
                  SUM(input_tokens) AS inputTokens, COUNT(input_tokens) AS inputSamples,
                  SUM(output_tokens) AS outputTokens, COUNT(output_tokens) AS outputSamples,
                  SUM(cached_input_tokens) AS cachedInputTokens,
                  COUNT(cached_input_tokens) AS cachedInputSamples
           FROM product_events WHERE ${where} AND ${terminalTurn}
           GROUP BY COALESCE(provider, 'unknown') ORDER BY turns DESC, provider`,
      )
        .bind(...binds)
        .all<{
          provider: string;
          turns: number;
          succeeded: number;
          failed: number;
          cancelled: number;
          inputTokens: number | null;
          inputSamples: number;
          outputTokens: number | null;
          outputSamples: number;
          cachedInputTokens: number | null;
          cachedInputSamples: number;
        }>(),
      env.DB.prepare(
        `SELECT substr(ts, 1, 10) AS day, COALESCE(provider, 'unknown') AS provider, COUNT(*) AS turns
           FROM product_events WHERE ${where} AND ${terminalTurn}
           GROUP BY day, COALESCE(provider, 'unknown') ORDER BY day, provider`,
      )
        .bind(...binds)
        .all<{ day: string; provider: string; turns: number }>(),
      comparisonAvailable
        ? env.DB.prepare(
            `SELECT COALESCE(provider, 'unknown') AS provider, COUNT(*) AS turns
           FROM product_events WHERE ${where} AND ${terminalTurn}
           GROUP BY COALESCE(provider, 'unknown') ORDER BY provider`,
          )
            .bind(...previousBinds)
            .all<{ provider: string; turns: number }>()
        : Promise.resolve(null),
    ]);

    const dayCount = Math.floor(
      (Date.parse(productFilters.beforeTimestamp) - Date.parse(productFilters.fromTimestamp)) /
        DAY_MS,
    );
    const dailyByDay = new Map(dailyRows.results.map((row) => [row.day, row]));
    const daily = Array.from({ length: dayCount }, (_, index) => {
      const day = new Date(Date.parse(productFilters.fromTimestamp) + index * DAY_MS)
        .toISOString()
        .slice(0, 10);
      return dailyByDay.get(day) ?? { day, events: 0, installations: 0, turns: 0 };
    });
    return jsonResponse({
      from: productFilters.from,
      to: productFilters.to,
      channel: productFilters.channel,
      surface: productFilters.surface,
      events: totals?.events ?? 0,
      activeInstallations: totals?.installations ?? 0,
      daily,
      features: featureRows.results,
      outcomes: outcomeRows.results,
      latency: latencyRows.results.map((row) => ({
        event: row.event,
        meanDurationMs: Math.round(row.meanDurationMs * 10) / 10,
        samples: row.samples,
      })),
      observedDesktopTurns: {
        ...providerRows.results.reduce(
          (total, row) => ({
            total: total.total + row.turns,
            succeeded: total.succeeded + row.succeeded,
            failed: total.failed + row.failed,
            cancelled: total.cancelled + row.cancelled,
          }),
          { total: 0, succeeded: 0, failed: 0, cancelled: 0 },
        ),
        providers: providerRows.results,
        daily: providerDailyRows.results,
        previous: previousRows
          ? {
              from: previousFrom.slice(0, 10),
              to: new Date(Date.parse(productFilters.fromTimestamp) - DAY_MS)
                .toISOString()
                .slice(0, 10),
              providers: previousRows.results,
            }
          : null,
      },
      observedDesktopCompletions: {
        inputTokens: {
          total: tokenRows?.inputTokens ?? null,
          samples: tokenRows?.inputSamples ?? 0,
        },
        outputTokens: {
          total: tokenRows?.outputTokens ?? null,
          samples: tokenRows?.outputSamples ?? 0,
        },
        cachedInputTokens: {
          total: tokenRows?.cachedInputTokens ?? null,
          samples: tokenRows?.cachedInputSamples ?? 0,
        },
      },
      eventTypes: eventRows.results,
    });
  }

  if (url.pathname === "/api/releases" && request.method === "GET") {
    return jsonResponse({ releases: await loadReleases(env, f) });
  }

  const dumpMatch = /^\/api\/dumps\/(.+)$/.exec(url.pathname);
  if (dumpMatch && request.method === "GET") {
    if (!env.CRASH_DUMPS) return new Response("crash storage unavailable", { status: 503 });
    let key: string;
    try {
      key = decodeURIComponent(dumpMatch[1]!);
    } catch {
      return new Response("bad key", { status: 400 });
    }
    if (!key.startsWith("dumps/") || key.includes("..")) {
      return new Response("bad key", { status: 400 });
    }
    const object = await env.CRASH_DUMPS.get(key);
    if (!object) return new Response("not found", { status: 404 });
    return new Response(object.body, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${key.split("/").pop()}"`,
      },
    });
  }

  return new Response("not found", { status: 404 });
}

// --- Request routing ----------------------------------------------------------

// The SPA is same-origin only: self-hosted scripts/styles, canvas charts, no
// framing. style-src needs 'unsafe-inline' for ECharts' inline styles.
const SPA_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "font-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** Serves the SPA shell with hardening headers. */
async function serveSpa(_request: Request, env: Env, url: URL): Promise<Response> {
  const response = await env.ASSETS.fetch(new URL("/index.html", url));
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", SPA_CSP);
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }

    if (url.pathname === "/v1/product-events" && request.method === "POST") {
      if (await overRateLimit(env.INGEST_RATE_LIMITER, request)) {
        return new Response("rate limited", { status: 429 });
      }
      if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
        return new Response("unsupported media type", { status: 415 });
      }
      const bodyBytes = await readBodyBytes(request, PRODUCT_MAX_BODY_BYTES);
      if (!bodyBytes) return new Response("payload too large", { status: 413 });
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(bodyBytes));
      } catch {
        return new Response("bad request", { status: 400 });
      }
      if (!isRecord(body) || !Array.isArray(body.events)) {
        return new Response("bad request", { status: 400 });
      }
      if (body.events.length > PRODUCT_MAX_EVENTS_PER_POST) {
        return new Response("too many events", { status: 413 });
      }
      const receivedAt = new Date().toISOString();
      const statements = body.events
        .map((raw) => normalizeProductEvent(raw))
        .filter((event): event is NormalizedProductEvent => event !== null)
        .map((event) => productEventStatement(env, event, receivedAt));
      const results = statements.length > 0 ? await env.DB.batch(statements) : [];
      const accepted = results.reduce((count, result) => count + (result.meta?.changes ?? 0), 0);
      return Response.json({ accepted, received: body.events.length });
    }

    if (url.pathname === "/v1/events" && request.method === "POST") {
      if (await overRateLimit(env.INGEST_RATE_LIMITER, request, env.FORWARDER_SECRET)) {
        return new Response("rate limited", { status: 429 });
      }
      if (!authorizedIngest(request, env)) {
        return new Response("unauthorized", { status: 401 });
      }
      const bodyBytes = await readBodyBytes(request, MAX_NDJSON_BYTES);
      if (!bodyBytes) {
        return new Response("payload too large", { status: 413 });
      }
      const body = new TextDecoder().decode(bodyBytes);
      const lines = body.split("\n").filter((line) => line.length > 0);
      if (lines.length > MAX_EVENTS_PER_POST) {
        return new Response("too many events", { status: 413 });
      }
      const receivedAt = new Date().toISOString();
      const statements: D1PreparedStatement[] = [];
      const normalizedEvents: NormalizedEvent[] = [];
      for (const line of lines) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const normalized = normalizeEvent(parsed);
        if (!normalized) continue;
        normalizedEvents.push(normalized);
        statements.push(eventStatement(env, normalized, receivedAt));
      }
      let written = 0;
      if (statements.length > 0) {
        // One D1 round trip for the whole batch.
        const results = await env.DB.batch(statements);
        written = results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
        // Provider rows attach only to events that were actually inserted —
        // a retried flush (changes = 0, client_id already stored) adds none.
        const providerStatements: D1PreparedStatement[] = [];
        results.forEach((result, index) => {
          const event = normalizedEvents[index]!;
          if (!event.providers || event.providers.length === 0) return;
          const changes = result.meta?.changes ?? 0;
          const eventId = result.meta?.last_row_id;
          if (changes <= 0 || typeof eventId !== "number") return;
          for (let i = 0; i < event.providers.length; i += USAGE_PROVIDER_ROWS_PER_STATEMENT) {
            providerStatements.push(
              usageProviderStatement(
                env,
                eventId,
                event,
                event.providers.slice(i, i + USAGE_PROVIDER_ROWS_PER_STATEMENT),
                receivedAt,
              ),
            );
          }
        });
        if (providerStatements.length > 0) {
          await env.DB.batch(providerStatements);
        }
      }
      return Response.json({ accepted: written, received: lines.length });
    }

    if (url.pathname === "/v1/crash" && request.method === "POST") {
      if (await overRateLimit(env.INGEST_RATE_LIMITER, request, env.FORWARDER_SECRET)) {
        return new Response("rate limited", { status: 429 });
      }
      if (!authorizedIngest(request, env)) {
        return new Response("unauthorized", { status: 401 });
      }
      if (!env.CRASH_DUMPS) {
        return new Response("crash storage unavailable", { status: 503 });
      }
      // Electron's crashReporter POSTs multipart/form-data with the minidump in
      // the `upload_file_minidump` part plus globalExtra fields.
      const configuredMax = Number(env.MAX_DUMP_BYTES);
      const maxBytes =
        Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : 5 * 1024 * 1024;
      const bodyBytes = await readBodyBytes(request, maxBytes + MULTIPART_OVERHEAD_BYTES);
      if (!bodyBytes) {
        return new Response("dump too large", { status: 413 });
      }
      let form: FormData;
      try {
        form = await new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: bodyBytes.buffer as ArrayBuffer,
        }).formData();
      } catch {
        return new Response("bad request", { status: 400 });
      }
      const dump = form.get("upload_file_minidump");
      if (!(dump instanceof File)) {
        return new Response("missing minidump", { status: 400 });
      }
      if (dump.size > maxBytes) {
        return new Response("dump too large", { status: 413 });
      }
      // Only a real UUID reaches the R2 key; anything else would bloat it past
      // R2's 1024-byte key limit or pollute the per-install grouping.
      const rawInstallId = String(form.get("installId") ?? "");
      const installId = UUID_PATTERN.test(rawInstallId) ? rawInstallId.toLowerCase() : "";
      // appVersion is our explicit globalExtra; `ver` is Electron's built-in.
      const rawVersion = String(form.get("appVersion") ?? form.get("ver") ?? "");
      const appVersion = VERSION_PATTERN.test(rawVersion) ? rawVersion : "";
      const key = `dumps/${new Date().toISOString().slice(0, 10)}/${installId || "unknown"}/${crypto.randomUUID()}.dmp`;
      await env.CRASH_DUMPS.put(key, dump.stream(), {
        customMetadata: {
          installId,
          flavor: String(form.get("flavor") ?? "").slice(0, 16),
          receivedAt: new Date().toISOString(),
        },
      });
      await env.DB.prepare(
        `INSERT INTO crash_dumps (r2_key, install_id, app_version, ts, received_at, size)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          key,
          installId || "unknown",
          appVersion,
          new Date().toISOString(),
          new Date().toISOString(),
          dump.size,
        )
        .run();
      return Response.json({ stored: true });
    }

    if (url.pathname.startsWith("/api/")) {
      // API responses are never cacheable: they carry session-scoped data.
      const response = await handleApi(request, env, url);
      const headers = new Headers(response.headers);
      headers.set("cache-control", "no-store");
      return new Response(response.body, { status: response.status, headers });
    }

    // Dashboard SPA. Hashed static assets and the two public root files
    // (app icon, favicon) skip the session gate; pages require a session
    // except /login, which the SPA renders from its own session probe.
    if (
      url.pathname.startsWith("/assets/") ||
      ((request.method === "GET" || request.method === "HEAD") &&
        (url.pathname === "/beta.png" || url.pathname === "/favicon.ico"))
    ) {
      return env.ASSETS.fetch(request);
    }
    if (request.method !== "GET") {
      return new Response("not found", { status: 404 });
    }
    if (url.pathname === "/login") {
      return serveSpa(request, env, url);
    }
    if (!(await hasSession(request, env))) {
      return Response.redirect(`${url.origin}/login`, 302);
    }
    return serveSpa(request, env, url);
  },

  async scheduled(controller, env) {
    const cutoff = new Date(
      controller.scheduledTime - PRODUCT_RETENTION_DAYS * DAY_MS,
    ).toISOString();
    for (let batch = 0; batch < PRODUCT_RETENTION_MAX_BATCHES; batch += 1) {
      const result = await env.DB.prepare(
        `DELETE FROM product_events
         WHERE event_id IN (
           SELECT event_id FROM product_events
           WHERE received_at < ? ORDER BY received_at LIMIT ?
         )`,
      )
        .bind(cutoff, PRODUCT_RETENTION_DELETE_BATCH_SIZE)
        .run();
      if ((result.meta?.changes ?? 0) < PRODUCT_RETENTION_DELETE_BATCH_SIZE) break;
    }
  },
} satisfies ExportedHandler<Env>;

// FILE: infra/diagnostics-worker/worker.ts
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
// Deploy: `cd infra/diagnostics-worker && wrangler deploy`

import { redactDiagnosticText } from "../../packages/shared/src/diagnosticsRedaction";

export interface Env {
  DB: D1Database;
  /** Absent when the bucket cannot be provisioned; /v1/crash returns 503. */
  CRASH_DUMPS?: R2Bucket;
  ASSETS: Fetcher;
  /** Per-IP rate limit for ingest endpoints (120 req / 60 s). */
  INGEST_RATE_LIMITER?: RateLimit;
  /** Per-IP rate limit for the dashboard login (10 req / 60 s). */
  LOGIN_RATE_LIMITER?: RateLimit;
  DASHBOARD_PASSWORD?: string;
  DASHBOARD_SESSION_KEY?: string;
  /** Optional shared ingest secret; required when set (Authorization: Bearer). */
  INGEST_TOKEN?: string;
  /** Max crash dump size accepted; default 5 MiB. */
  MAX_DUMP_BYTES?: string;
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
// Redacted events stay a year so regressions can be compared across releases;
// raw minidumps (unredactable process memory) and their index rows go sooner.
const EVENT_RETENTION_DAYS = 365;
const CRASH_DUMP_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
  const outcome = payload.outcome === "error" ? "error" : "ok";
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
  };
}

// INSERT OR IGNORE + the unique index on client_id make retried flushes
// idempotent: the same client event id is stored at most once.
const INSERT_EVENT_SQL = `INSERT OR IGNORE INTO events (
  client_id, ts, received_at, install_id, app_version, platform, arch, event,
  kind, outcome, process_type, reason, error_context, target_version,
  duration_ms, source, fingerprint, message, stack, log_tail
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

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
  );
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
async function overRateLimit(limiter: RateLimit | undefined, request: Request): Promise<boolean> {
  if (!limiter) return false;
  try {
    const key = request.headers.get("cf-connecting-ip") ?? "anonymous";
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

async function passwordMatches(input: string, expected: string): Promise<boolean> {
  // Both sides are SHA-256 digests, so the compare is constant-time over equal
  // lengths regardless of the inputs.
  const a = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
  const b = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
  );
  return timingSafeEqual(a, b);
}

function sessionConfigured(env: Env): boolean {
  return Boolean(env.DASHBOARD_PASSWORD && env.DASHBOARD_SESSION_KEY);
}

async function hasSession(request: Request, env: Env): Promise<boolean> {
  if (!env.DASHBOARD_SESSION_KEY) return false;
  return verifySessionCookie(request.headers.get("cookie"), env.DASHBOARD_SESSION_KEY);
}

// --- Dashboard API -----------------------------------------------------------

function rangeDays(url: URL): number {
  const days = Number(url.searchParams.get("days") ?? "7");
  if (!Number.isFinite(days)) return 7;
  return Math.min(EVENT_RETENTION_DAYS, Math.max(1, Math.floor(days)));
}

function versionFilter(url: URL): string | null {
  const version = url.searchParams.get("version");
  return version && VERSION_PATTERN.test(version) ? version : null;
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
    if (!(await passwordMatches(password, env.DASHBOARD_PASSWORD!))) {
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

  const days = rangeDays(url);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const version = versionFilter(url);
  const versionClause = version ? " AND app_version = ?" : "";
  const bind = (...extra: (string | number)[]) =>
    version ? [since, version, ...extra] : [since, ...extra];

  if (url.pathname === "/api/overview" && request.method === "GET") {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const versions = await env.DB.prepare(
      `SELECT DISTINCT app_version AS version FROM events WHERE ts >= ? ORDER BY version DESC`,
    )
      .bind(since)
      .all();
    const [activeRange, crashByVersion, errorByVersion, timeseries] = await Promise.all([
      env.DB.prepare(
        `SELECT COUNT(DISTINCT install_id) AS n FROM events WHERE ts >= ?${versionClause}`,
      )
        .bind(...bind())
        .first<{ n: number }>(),
      env.DB.prepare(
        `SELECT app_version AS version, COUNT(*) AS n FROM events
         WHERE ts >= ? AND event IN ('app.renderer-crash','app.child-process-crash')${versionClause}
         GROUP BY app_version ORDER BY n DESC`,
      )
        .bind(...bind())
        .all(),
      env.DB.prepare(
        `SELECT app_version AS version, COUNT(*) AS n FROM events
         WHERE ts >= ? AND event = 'app.error'${versionClause}
         GROUP BY app_version ORDER BY n DESC`,
      )
        .bind(...bind())
        .all(),
      env.DB.prepare(
        `SELECT substr(ts, 1, 10) AS day, event, COUNT(*) AS n FROM events
         WHERE ts >= ?${versionClause}
         GROUP BY day, event ORDER BY day`,
      )
        .bind(...bind())
        .all(),
    ]);
    const active24hRow = await env.DB.prepare(
      `SELECT COUNT(DISTINCT install_id) AS n FROM events WHERE ts >= ?${versionClause}`,
    )
      .bind(...(version ? [dayAgo, version] : [dayAgo]))
      .first<{ n: number }>();
    return jsonResponse({
      activeInstalls24h: active24hRow?.n ?? 0,
      activeInstallsRange: activeRange?.n ?? 0,
      crashesByVersion: crashByVersion.results,
      errorsByVersion: errorByVersion.results,
      timeseries: timeseries.results,
      versions: versions.results.map((r) => (r as { version: string }).version),
    });
  }

  if (url.pathname === "/api/crashes" && request.method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT process_type AS processType, reason, COUNT(*) AS count,
              MIN(ts) AS firstSeen, MAX(ts) AS lastSeen,
              GROUP_CONCAT(DISTINCT app_version) AS versions,
              MAX(id) AS latestId
       FROM events
       WHERE ts >= ? AND event IN ('app.renderer-crash','app.child-process-crash')${versionClause}
       GROUP BY process_type, reason ORDER BY count DESC`,
    )
      .bind(...bind())
      .all();
    return jsonResponse({ crashes: rows.results });
  }

  const crashDetail = /^\/api\/crashes\/(\d+)$/.exec(url.pathname);
  if (crashDetail && request.method === "GET") {
    const row = await env.DB.prepare(
      `SELECT * FROM events WHERE id = ? AND event IN ('app.renderer-crash','app.child-process-crash')`,
    )
      .bind(Number(crashDetail[1]))
      .first();
    if (!row) return new Response("not found", { status: 404 });
    const dumps = await env.DB.prepare(
      `SELECT id, r2_key AS r2Key, size, received_at AS receivedAt FROM crash_dumps
       WHERE install_id = ? AND ts >= ? ORDER BY ts DESC LIMIT 10`,
    )
      .bind(String(row.install_id), String(row.ts))
      .all();
    return jsonResponse({ crash: row, dumps: dumps.results });
  }

  if (url.pathname === "/api/errors" && request.method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT fingerprint, COUNT(*) AS count,
              COUNT(DISTINCT install_id) AS installs,
              MIN(ts) AS firstSeen, MAX(ts) AS lastSeen,
              GROUP_CONCAT(DISTINCT app_version) AS versions,
              (SELECT message FROM events e2 WHERE e2.fingerprint = events.fingerprint
               ORDER BY ts DESC LIMIT 1) AS message
       FROM events
       WHERE ts >= ? AND event = 'app.error'${versionClause}
       GROUP BY fingerprint ORDER BY count DESC`,
    )
      .bind(...bind())
      .all();
    return jsonResponse({ errors: rows.results });
  }

  const errorDetail = /^\/api\/errors\/([0-9a-fA-F]{8,32})$/.exec(url.pathname);
  if (errorDetail && request.method === "GET") {
    const fingerprint = errorDetail[1]!;
    const rows = await env.DB.prepare(
      `SELECT id, ts, install_id AS installId, app_version AS appVersion, source,
              message, stack FROM events
       WHERE event = 'app.error' AND fingerprint = ?${versionClause}
       ORDER BY ts DESC LIMIT 50`,
    )
      .bind(...(version ? [fingerprint, version] : [fingerprint]))
      .all();
    if (rows.results.length === 0) return new Response("not found", { status: 404 });
    return jsonResponse({ fingerprint, occurrences: rows.results });
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
  "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; " +
  "base-uri 'none'; form-action 'self'";

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

    if (url.pathname === "/v1/events" && request.method === "POST") {
      if (await overRateLimit(env.INGEST_RATE_LIMITER, request)) {
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
      for (const line of lines) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const normalized = normalizeEvent(parsed);
        if (!normalized) continue;
        statements.push(eventStatement(env, normalized, receivedAt));
      }
      let written = 0;
      if (statements.length > 0) {
        // One D1 round trip for the whole batch.
        const results = await env.DB.batch(statements);
        written = results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
      }
      return Response.json({ accepted: written, received: lines.length });
    }

    if (url.pathname === "/v1/crash" && request.method === "POST") {
      if (await overRateLimit(env.INGEST_RATE_LIMITER, request)) {
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

    // Dashboard SPA. Hashed static assets are public; pages require a session
    // except /login, which the SPA renders from its own session probe.
    if (url.pathname.startsWith("/assets/")) {
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

  // Daily retention by received_at (server-side, so client clock skew cannot
  // extend it). R2 objects expire via the bucket's own 90-day lifecycle rule,
  // matching the crash_dumps index sweep below.
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    const cutoff = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();
    await env.DB.prepare("DELETE FROM events WHERE received_at < ?")
      .bind(cutoff(EVENT_RETENTION_DAYS))
      .run();
    await env.DB.prepare("DELETE FROM crash_dumps WHERE received_at < ?")
      .bind(cutoff(CRASH_DUMP_RETENTION_DAYS))
      .run();
  },
} satisfies ExportedHandler<Env>;

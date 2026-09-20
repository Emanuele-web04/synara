// FILE: infra/diagnostics-worker/worker.ts
// Purpose: Cloudflare Worker ingest for Synara Beta diagnostics.
//
// Endpoints:
//   POST /v1/events  — NDJSON diagnostics events -> Analytics Engine dataset
//   POST /v1/crash   — Electron minidump multipart upload -> R2 bucket
//   GET  /healthz    — liveness
//
// The worker is deliberately allowlist-shaped: unknown event names, unexpected
// field types, and oversized payloads are dropped rather than stored.
// Deploy: `cd infra/diagnostics-worker && wrangler deploy`

export interface Env {
  BETA_EVENTS: AnalyticsEngineDataset;
  CRASH_DUMPS: R2Bucket;
  /** Optional shared ingest secret; required when set (Authorization: Bearer). */
  INGEST_TOKEN?: string;
  /** Max crash dump size accepted; default 5 MiB. */
  MAX_DUMP_BYTES?: string;
}

const KNOWN_EVENTS = new Set([
  "app.start",
  "app.exit",
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
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Returns indexes1..6 for Analytics Engine writeDataPoint, or null to drop. */
function normalizeEvent(raw: unknown): {
  blobs: string[];
  doubles: number[];
  indexes: string[];
} | null {
  if (!isRecord(raw)) return null;
  if (raw.v !== 1 || typeof raw.event !== "string" || !KNOWN_EVENTS.has(raw.event)) {
    return null;
  }
  if (typeof raw.installId !== "string" || !UUID_PATTERN.test(raw.installId)) return null;
  if (raw.flavor !== "beta") return null;
  if (typeof raw.platform !== "string" || raw.platform.length > 16) return null;
  if (typeof raw.arch !== "string" || raw.arch.length > 16) return null;
  if (typeof raw.appVersion !== "string" || !VERSION_PATTERN.test(raw.appVersion)) return null;
  if (typeof raw.ts !== "string" || Number.isNaN(Date.parse(raw.ts))) return null;

  const payload = isRecord(raw.payload) ? raw.payload : {};
  const kind = typeof payload.kind === "string" ? payload.kind : "";
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

  return {
    // Analytics Engine limits: 20 blobs / 20 doubles / 1 index per point.
    blobs: [
      raw.event, // blob1
      raw.platform, // blob2
      raw.appVersion, // blob3
      kind, // blob4
      outcome, // blob5
      `${processType}:${reason}`, // blob6 — fixed-enum crash detail only
      errorContext, // blob7
      targetVersion, // blob8
      raw.arch, // blob9
    ],
    doubles: [
      isFiniteNumber(payload.durationMs) && payload.durationMs >= 0 ? payload.durationMs : 0, // double1
      Date.parse(raw.ts) / 1000, // double2 — event epoch seconds
    ],
    indexes: [raw.installId], // index1 — random install UUID
  };
}

function authorized(request: Request, env: Env): boolean {
  if (!env.INGEST_TOKEN) return true;
  return request.headers.get("authorization") === `Bearer ${env.INGEST_TOKEN}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }
    if (!authorized(request, env)) {
      return new Response("unauthorized", { status: 401 });
    }

    if (url.pathname === "/v1/events" && request.method === "POST") {
      const contentLength = Number(request.headers.get("content-length") ?? "0");
      if (contentLength > MAX_NDJSON_BYTES) {
        return new Response("payload too large", { status: 413 });
      }
      const body = await request.text();
      if (body.length > MAX_NDJSON_BYTES) {
        return new Response("payload too large", { status: 413 });
      }
      const lines = body.split("\n").filter((line) => line.length > 0);
      if (lines.length > MAX_EVENTS_PER_POST) {
        return new Response("too many events", { status: 413 });
      }
      let written = 0;
      for (const line of lines) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const normalized = normalizeEvent(parsed);
        if (!normalized) continue;
        env.BETA_EVENTS.writeDataPoint({
          blobs: normalized.blobs,
          doubles: normalized.doubles,
          indexes: normalized.indexes,
        });
        written += 1;
      }
      return Response.json({ accepted: written, received: lines.length });
    }

    if (url.pathname === "/v1/crash" && request.method === "POST") {
      // Electron's crashReporter POSTs multipart/form-data with the minidump in
      // the `upload_file_minidump` part plus globalExtra fields.
      const contentLength = Number(request.headers.get("content-length") ?? "0");
      const maxBytes = Number(env.MAX_DUMP_BYTES ?? 5 * 1024 * 1024);
      if (contentLength > maxBytes) {
        return new Response("dump too large", { status: 413 });
      }
      const form = await request.formData();
      const dump = form.get("upload_file_minidump");
      if (!(dump instanceof File)) {
        return new Response("missing minidump", { status: 400 });
      }
      if (dump.size > maxBytes) {
        return new Response("dump too large", { status: 413 });
      }
      const installId = String(form.get("installId") ?? "unknown").replace(/[^0-9a-f-]/gi, "");
      const key = `dumps/${new Date().toISOString().slice(0, 10)}/${installId || "unknown"}/${crypto.randomUUID()}.dmp`;
      await env.CRASH_DUMPS.put(key, dump.stream(), {
        customMetadata: {
          installId,
          flavor: String(form.get("flavor") ?? ""),
          receivedAt: new Date().toISOString(),
        },
      });
      return Response.json({ stored: true });
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

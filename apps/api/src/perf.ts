// FILE: perf.ts
// Purpose: Opt-in request instrumentation for the account API. Off unless
// SYNARA_API_PERF=1. Records, per route pattern: request count, latency
// (p50/p95/max), database round trips and time, pool wait, outbound calls and
// time by provider, and bytes in/out. Adds a Server-Timing header and logs one
// aggregate line per window.
// Privacy: only route patterns (`/hosts/:id/authorization`), status classes,
// provider labels and numbers are kept. Never a URL, id, header, body, SQL
// text or parameter.
// Layer: API observability (no behavior change when disabled).

import { AsyncLocalStorage } from "node:async_hooks";
import type { MiddlewareHandler } from "hono";
import type pg from "pg";

export const PERF_ENV_NAME = "SYNARA_API_PERF";

export function isPerfEnabled(env: Record<string, string | undefined>): boolean {
  return env[PERF_ENV_NAME] === "1";
}

/** Outbound hosts worth naming. Anything else is reported as "other". */
const PROVIDER_BY_HOST_SUFFIX: readonly (readonly [string, string])[] = [
  ["workos.com", "workos"],
  ["polar.sh", "polar"],
  ["push.apple.com", "apns"],
  ["cloudflare.com", "cloudflare"],
];

function providerLabel(input: unknown): string {
  let host: string;
  try {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    host = new URL(url).hostname;
  } catch {
    return "other";
  }
  for (const [suffix, label] of PROVIDER_BY_HOST_SUFFIX)
    if (host === suffix || host.endsWith(`.${suffix}`)) return label;
  // A configured identity-provider double or object store has no fixed host.
  return host === "localhost" || host === "127.0.0.1" ? "local" : "other";
}

type Scope = {
  dbCount: number;
  dbMs: number;
  poolWaitMs: number;
  extCount: number;
  extMs: number;
  ext: Map<string, { count: number; ms: number }>;
};

function newScope(): Scope {
  return { dbCount: 0, dbMs: 0, poolWaitMs: 0, extCount: 0, extMs: 0, ext: new Map() };
}

const SAMPLE_CAP = 2_048;

type Bucket = {
  count: number;
  /** Ring of the most recent durations; enough for window percentiles. */
  samples: number[];
  next: number;
  maxMs: number;
  dbCount: number;
  dbMs: number;
  poolWaitMs: number;
  extCount: number;
  extMs: number;
  ext: Map<string, { count: number; ms: number }>;
  bytesIn: number;
  bytesOut: number;
};

function newBucket(): Bucket {
  return {
    count: 0,
    samples: [],
    next: 0,
    maxMs: 0,
    dbCount: 0,
    dbMs: 0,
    poolWaitMs: 0,
    extCount: 0,
    extMs: 0,
    ext: new Map(),
    bytesIn: 0,
    bytesOut: 0,
  };
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
}

const round = (value: number) => Math.round(value * 10) / 10;

export type PerfRow = {
  /** `GET /api/v1/hosts/:id/authorization 2xx`, or `job:<name>` for background work. */
  key: string;
  count: number;
  perMinute: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  dbRoundTripsPerCall: number;
  dbMsPerCall: number;
  poolWaitMsPerCall: number;
  externalCallsPerCall: number;
  externalMsPerCall: number;
  /** Outbound requests per minute by provider, attributed to this caller. */
  externalPerMinute: Record<string, number>;
  bytesIn: number;
  bytesOut: number;
};

export type PerfSnapshot = { windowMs: number; rows: PerfRow[] };

export type PerfRecorder = {
  middleware: MiddlewareHandler;
  /** Counts every query on every client of this pool, and time spent waiting for a client. */
  instrumentPool(pool: pg.Pool): void;
  /** Wraps `globalThis.fetch`; returns the undo. */
  instrumentFetch(): () => void;
  /** Attributes a background job's database and outbound work to `job:<name>`. */
  job<A>(name: string, run: () => Promise<A>): Promise<A>;
  snapshot(): PerfSnapshot;
  reset(): void;
  /** Logs and resets one aggregate line per interval; returns the stop. */
  startReporting(intervalMs?: number, log?: (line: string) => void): () => void;
};

export function createPerfRecorder(now: () => number = () => performance.now()): PerfRecorder {
  const scopes = new AsyncLocalStorage<Scope>();
  const buckets = new Map<string, Bucket>();
  let windowStartedAt = now();

  function record(key: string, durationMs: number, scope: Scope, bytesIn = 0, bytesOut = 0) {
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, (bucket = newBucket()));
    bucket.count += 1;
    if (bucket.samples.length < SAMPLE_CAP) bucket.samples.push(durationMs);
    else {
      bucket.samples[bucket.next] = durationMs;
      bucket.next = (bucket.next + 1) % SAMPLE_CAP;
    }
    bucket.maxMs = Math.max(bucket.maxMs, durationMs);
    bucket.dbCount += scope.dbCount;
    bucket.dbMs += scope.dbMs;
    bucket.poolWaitMs += scope.poolWaitMs;
    bucket.extCount += scope.extCount;
    bucket.extMs += scope.extMs;
    for (const [label, value] of scope.ext) {
      const total = bucket.ext.get(label) ?? { count: 0, ms: 0 };
      total.count += value.count;
      total.ms += value.ms;
      bucket.ext.set(label, total);
    }
    bucket.bytesIn += bytesIn;
    bucket.bytesOut += bytesOut;
  }

  const middleware: MiddlewareHandler = async (c, next) => {
    const scope = newScope();
    const startedAt = now();
    try {
      await scopes.run(scope, next);
    } finally {
      const durationMs = now() - startedAt;
      const status = c.res?.status ?? 500;
      const key = `${c.req.method} ${c.req.routePath} ${Math.floor(status / 100)}xx`;
      const bytesIn = Number(c.req.header("content-length") ?? 0) || 0;
      const bytesOut = Number(c.res?.headers.get("content-length") ?? 0) || 0;
      record(key, durationMs, scope, bytesIn, bytesOut);
      // Not on upgrades or immutable responses; timing must never fail a request.
      try {
        c.res?.headers.set(
          "Server-Timing",
          [
            `total;dur=${round(durationMs)}`,
            `db;dur=${round(scope.dbMs)};desc="${scope.dbCount} round trips"`,
            `pool;dur=${round(scope.poolWaitMs)}`,
            `external;dur=${round(scope.extMs)};desc="${scope.extCount} calls"`,
          ].join(", "),
        );
      } catch {
        // Header is advisory.
      }
    }
  };

  function instrumentClient(client: pg.PoolClient | pg.Client) {
    const marked = client as unknown as { __synaraPerf?: true };
    if (marked.__synaraPerf) return;
    marked.__synaraPerf = true;
    const original = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as unknown as { query: (...args: unknown[]) => unknown }).query = (
      ...args: unknown[]
    ) => {
      const scope = scopes.getStore();
      if (!scope) return original(...args);
      const startedAt = now();
      const done = () => {
        scope.dbCount += 1;
        scope.dbMs += now() - startedAt;
      };
      const last = args[args.length - 1];
      if (typeof last === "function") {
        args[args.length - 1] = (...result: unknown[]) => {
          done();
          return (last as (...result: unknown[]) => unknown)(...result);
        };
        return original(...args);
      }
      const result = original(...args);
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        (result as Promise<unknown>).then(done, done);
      } else {
        // A submittable (cursor/stream) is one round trip of unknown duration.
        scope.dbCount += 1;
      }
      return result;
    };
  }

  function instrumentPool(pool: pg.Pool) {
    pool.on("connect", instrumentClient);
    const original = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
    (pool as unknown as { connect: (...args: unknown[]) => unknown }).connect = (
      ...args: unknown[]
    ) => {
      const scope = scopes.getStore();
      if (!scope) return original(...args);
      const startedAt = now();
      const waited = () => {
        scope.poolWaitMs += now() - startedAt;
      };
      const callback = args[0];
      if (typeof callback === "function") {
        return original((...result: unknown[]) => {
          waited();
          return (callback as (...result: unknown[]) => unknown)(...result);
        });
      }
      const result = original() as Promise<unknown>;
      result.then(waited, waited);
      return result;
    };
  }

  function instrumentFetch() {
    const original = globalThis.fetch;
    const wrapped = ((input: unknown, init?: unknown) => {
      const scope = scopes.getStore();
      if (!scope) return (original as (...args: unknown[]) => Promise<Response>)(input, init);
      const startedAt = now();
      const label = providerLabel(input);
      const done = () => {
        const ms = now() - startedAt;
        scope.extCount += 1;
        scope.extMs += ms;
        const total = scope.ext.get(label) ?? { count: 0, ms: 0 };
        total.count += 1;
        total.ms += ms;
        scope.ext.set(label, total);
      };
      const result = (original as (...args: unknown[]) => Promise<Response>)(input, init);
      result.then(done, done);
      return result;
    }) as typeof fetch;
    globalThis.fetch = Object.assign(wrapped, original);
    return () => {
      if (globalThis.fetch === wrapped) globalThis.fetch = original;
    };
  }

  async function job<A>(name: string, run: () => Promise<A>): Promise<A> {
    const scope = newScope();
    const startedAt = now();
    try {
      return await scopes.run(scope, run);
    } finally {
      record(`job:${name}`, now() - startedAt, scope);
    }
  }

  function snapshot(): PerfSnapshot {
    const windowMs = Math.max(1, now() - windowStartedAt);
    const minutes = windowMs / 60_000;
    const rows = [...buckets.entries()]
      .map(([key, bucket]): PerfRow => {
        const sorted = bucket.samples.toSorted((left, right) => left - right);
        return {
          key,
          count: bucket.count,
          perMinute: round(bucket.count / minutes),
          p50Ms: round(percentile(sorted, 0.5)),
          p95Ms: round(percentile(sorted, 0.95)),
          maxMs: round(bucket.maxMs),
          dbRoundTripsPerCall: round(bucket.dbCount / bucket.count),
          dbMsPerCall: round(bucket.dbMs / bucket.count),
          poolWaitMsPerCall: round(bucket.poolWaitMs / bucket.count),
          externalCallsPerCall: round(bucket.extCount / bucket.count),
          externalMsPerCall: round(bucket.extMs / bucket.count),
          externalPerMinute: Object.fromEntries(
            [...bucket.ext.entries()].map(([label, value]) => [
              label,
              round(value.count / minutes),
            ]),
          ),
          bytesIn: bucket.bytesIn,
          bytesOut: bucket.bytesOut,
        };
      })
      .toSorted((left, right) => right.count - left.count);
    return { windowMs: Math.round(windowMs), rows };
  }

  function reset() {
    buckets.clear();
    windowStartedAt = now();
  }

  function startReporting(
    intervalMs = 60_000,
    log: (line: string) => void = (line) => console.log(line),
  ) {
    const timer = setInterval(() => {
      const current = snapshot();
      reset();
      if (current.rows.length > 0) log(`[api-perf] ${JSON.stringify(current)}`);
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  return { middleware, instrumentPool, instrumentFetch, job, snapshot, reset, startReporting };
}

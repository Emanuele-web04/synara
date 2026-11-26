import { EventEmitter } from "node:events";
import { Hono } from "hono";
import type pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createPerfRecorder, isPerfEnabled } from "./perf";

/** The two pg surfaces the recorder touches: the `connect` event and `connect()`. */
function fakePool() {
  const emitter = new EventEmitter();
  const client = {
    query: (...args: unknown[]) => {
      const last = args[args.length - 1];
      if (typeof last === "function") {
        (last as (error: null, result: { rows: never[] }) => void)(null, { rows: [] });
        return undefined;
      }
      return Promise.resolve({ rows: [] });
    },
    release: () => {},
  };
  const pool = Object.assign(emitter, {
    connect: (callback?: (error: null, client: unknown) => void) => {
      if (callback) return callback(null, client);
      return Promise.resolve(client);
    },
  });
  return {
    pool: pool as unknown as pg.Pool,
    client,
    announce: () => emitter.emit("connect", client),
  };
}

describe("account API perf recorder", () => {
  const restore: (() => void)[] = [];
  afterEach(() => {
    for (const undo of restore.splice(0)) undo();
  });

  it("is off unless the flag is exactly 1", () => {
    expect(isPerfEnabled({})).toBe(false);
    expect(isPerfEnabled({ SYNARA_API_PERF: "true" })).toBe(false);
    expect(isPerfEnabled({ SYNARA_API_PERF: "1" })).toBe(true);
  });

  it("groups by route pattern and counts database and outbound work per request", async () => {
    const perf = createPerfRecorder();
    const { pool, announce } = fakePool();
    perf.instrumentPool(pool);
    announce();

    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}")) as unknown as typeof fetch;
    restore.push(() => {
      globalThis.fetch = original;
    });
    restore.push(perf.instrumentFetch());

    const app = new Hono();
    app.use("*", perf.middleware);
    app.get("/api/v1/hosts/:id/authorization", async (c) => {
      const client = (await pool.connect()) as unknown as {
        query: (...args: unknown[]) => Promise<unknown>;
      };
      await client.query("BEGIN");
      await client.query("SELECT 1");
      await new Promise<void>((resolve) =>
        (client.query as (...args: unknown[]) => unknown)("COMMIT", [], () => resolve()),
      );
      await fetch("https://api.workos.com/user_management/organization_memberships?user_id=u");
      await fetch("https://files.example.test/object");
      return c.json({ ok: true });
    });

    const first = await app.request("/api/v1/hosts/3f1c1c7e-secret-id/authorization");
    await app.request("/api/v1/hosts/another-secret-id/authorization");

    expect(first.headers.get("server-timing")).toMatch(
      /^total;dur=[\d.]+, db;dur=[\d.]+;desc="3 round trips", pool;dur=[\d.]+, external;dur=[\d.]+;desc="2 calls"$/,
    );
    const { rows } = perf.snapshot();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: "GET /api/v1/hosts/:id/authorization 2xx",
      count: 2,
      dbRoundTripsPerCall: 3,
      externalCallsPerCall: 2,
    });
    expect(Object.keys(rows[0]!.externalPerMinute).toSorted()).toEqual(["other", "workos"]);
    // `c.json()` sets no content-length; the body is still counted, and still readable.
    expect(rows[0]!.bytesOut).toBe(2 * JSON.stringify({ ok: true }).length);
    expect(await first.json()).toEqual({ ok: true });
    // No identifier, URL or query string survives into the aggregate.
    expect(JSON.stringify(rows)).not.toMatch(/secret-id|user_id|example\.test/);
  });

  it("attributes background work to its job and leaves untracked work alone", async () => {
    const perf = createPerfRecorder();
    const { pool, client, announce } = fakePool();
    perf.instrumentPool(pool);
    announce();

    // Outside a request or job nothing is recorded and calls pass straight through.
    await client.query("SELECT 1");
    expect(perf.snapshot().rows).toEqual([]);

    await perf.job("push-flush", async () => {
      await client.query("SELECT 1");
      await client.query("DELETE");
    });
    expect(perf.snapshot().rows[0]).toMatchObject({
      key: "job:push-flush",
      count: 1,
      dbRoundTripsPerCall: 2,
    });

    perf.reset();
    expect(perf.snapshot().rows).toEqual([]);
  });

  it("records a failed request under its status class without swallowing the error", async () => {
    const perf = createPerfRecorder();
    const app = new Hono();
    app.use("*", perf.middleware);
    app.get("/api/v1/me", (c) => c.json({ error: "unauthorized" }, 401));
    const response = await app.request("/api/v1/me");
    expect(response.status).toBe(401);
    expect(perf.snapshot().rows[0]?.key).toBe("GET /api/v1/me 4xx");
  });
});

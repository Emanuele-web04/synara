// Projection→frozen snapshot→existing product sender→real SQLite D1 boundary proof.
// All rows and fetches are synthetic/in-process; no provider or external network runs.
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductAnalytics } from "../../desktop/src/productAnalytics.ts";
import worker, { signSession } from "../../analytics/worker.ts";
import { SQLiteD1 } from "../../analytics/testing/sqliteD1.mjs";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { writeHostUsageSnapshots } from "./hostUsageSnapshot.ts";
import * as AtomicWrite from "./atomicWrite.ts";

const DAY = 86_400_000;
const START = Date.parse("2026-11-07T00:00:00.000Z");
const END = START + DAY;
const NOW = END + 12 * 60 * 60 * 1000;
const at = (offset) => new Date(START + offset).toISOString();
const roots = [],
  senders = [],
  databases = [];
const layer = Layer.mergeAll(SqlitePersistenceMemory, NodeServices.layer);
const run = (effect) => effect.pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);
const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "host-usage-"));
  roots.push(root);
  return root;
};
const makeDb = () => {
  const db = new SQLiteD1();
  databases.push(db);
  const directory = new URL("../../analytics/migrations/", import.meta.url);
  for (const file of readdirSync(directory)
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .sort())
    db.database.exec(readFileSync(new URL(file, directory), "utf8"));
  return db;
};
const files = (root) => {
  try {
    return readdirSync(join(root, "product-analytics/host-usage")).filter((name) =>
      name.endsWith(".json"),
    );
  } catch {
    return [];
  }
};
const snapshot = (root) =>
  JSON.parse(readFileSync(join(root, "product-analytics/host-usage", files(root)[0]), "utf8"));
const sender = (root, fetcher, overrides = {}) => {
  const value = new ProductAnalytics({
    homeDir: root,
    channel: "stable",
    appVersion: "1.2.3",
    platform: "darwin",
    defaultEnabled: false,
    fetcher,
    ...overrides,
  });
  senders.push(value);
  if (overrides.enabled !== false) value.setEnabled(true);
  return value;
};
const seedTurn = (
  id,
  {
    state = "completed",
    requestedAt = at(1000),
    completedAt = at(2000),
    usage = null,
    model = "claude-fable-5-1",
    effort = "high",
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_turns (thread_id,turn_id,pending_message_id,state,requested_at,completed_at,checkpoint_files_json)
    VALUES ('host-thread',${id},${id},${state},${requestedAt},${completedAt},'[]')`;
    yield* sql`INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json)
    VALUES (${`request-${id}`},'thread','host-thread',${Number(id.replace(/\D/g, "")) + 1},'thread.turn-start-requested',${requestedAt},'client',
      ${JSON.stringify({ messageId: id, modelSelection: { provider: "claudeAgent", model, options: { effort } } })},'{}')`;
    if (usage !== null)
      yield* sql`INSERT INTO projection_thread_activities (activity_id,thread_id,turn_id,tone,kind,summary,payload_json,created_at)
    VALUES (${`usage-${id}`},'host-thread',${id},'info','turn.completed','done',${JSON.stringify({ modelUsage: usage })},${completedAt ?? at(3000)})`;
  });
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
});
afterEach(() => {
  for (const value of senders.splice(0)) value.dispose();
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("product-consent host usage", () => {
  it("keeps missing/partial tokens unknown, freezes UTC bounds, and deduplicates retries/restarts without host identity", async () => {
    const root = makeRoot(),
      db = makeDb(),
      bodies = [];
    const collect = sender(root, async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return worker.fetch(new Request("https://worker.invalid/v1/product-events", init), {
        DB: db,
      });
    });
    await run(
      Effect.gen(function* () {
        yield* seedTurn("t1");
        yield* seedTurn("t2", { usage: {} });
        yield* seedTurn("t3", { usage: { privateModelKey: { inputTokens: 0 } } });
        yield* seedTurn("t4", {
          usage: { privateModelKey: { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 0 } },
        });
        yield* seedTurn("t5", {
          state: "error",
          usage: { privateModelKey: { inputTokens: 7, outputTokens: 3 } },
        });
        yield* seedTurn("t6", {
          state: "interrupted",
          usage: { privateModelKey: { inputTokens: -1, outputTokens: 0 } },
        });
        yield* seedTurn("t7", {
          usage: Object.fromEntries(
            Array.from({ length: 65 }, (_, n) => [
              `private-${n}`,
              { inputTokens: 1, outputTokens: 1 },
            ]),
          ),
        });
        yield* seedTurn("t8", { usage: { a: { inputTokens: 2 }, b: { outputTokens: 3 } } });
        yield* seedTurn("t9", { state: "error", completedAt: null });
        yield* seedTurn("t10", { requestedAt: at(-1000) });
        yield* seedTurn("t11", { completedAt: new Date(END).toISOString() });
        yield* writeHostUsageSnapshots(root, END + 5 * 60 * 1000);
        expect(files(root)).toEqual([]);
        yield* writeHostUsageSnapshots(root, NOW);
        const frozen = readFileSync(
          join(root, "product-analytics/host-usage", files(root)[0]),
          "utf8",
        );
        yield* seedTurn("t12", { usage: { m: { inputTokens: 999 } } });
        yield* writeHostUsageSnapshots(root, NOW + 1000);
        expect(
          readFileSync(join(root, "product-analytics/host-usage", files(root)[0]), "utf8"),
        ).toBe(frozen);
      }),
    );
    const local = snapshot(root);
    expect(local).toMatchObject({
      windowStart: at(0),
      windowEnd: new Date(END).toISOString(),
      coveredFrom: at(0),
      eligibleTurns: 8,
      includedTurns: 8,
      missingCompletionTimes: 1,
      tokenTruncatedTurns: 1,
    });
    expect(JSON.stringify(local)).not.toContain("private");
    expect(local.rows).toContainEqual(
      expect.objectContaining({
        outcome: "succeeded",
        turns: 6,
        effort: "high",
        origin: "other",
        runtimeMode: "other",
        interactionMode: "other",
        inputTokens: 5,
        inputSamples: 2,
        outputTokens: 2,
        outputSamples: 1,
        cachedInputTokens: 0,
        cachedInputSamples: 1,
      }),
    );
    vi.setSystemTime(NOW);
    collect.track({ event: "feature.used", outcome: "succeeded", feature: "settings" });
    await collect.flush();
    expect(bodies[0].events).toEqual([expect.objectContaining({ event: "feature.used" })]);
    await collect.flush();
    expect(bodies).toHaveLength(2);
    expect(bodies[1].hostUsage).not.toHaveProperty("policyId");
    expect(bodies[1].hostUsage).not.toHaveProperty("installId");
    const retry = await worker.fetch(
      new Request("https://worker.invalid/v1/product-events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bodies[1]),
      }),
      { DB: db },
    );
    expect(retry.status).toBe(200);
    expect(db.database.prepare("SELECT COUNT(*) AS n FROM host_usage_receipts").get()).toEqual({
      n: 1,
    });
    expect(
      db.database.prepare("SELECT SUM(turns) AS n FROM usage_turns WHERE source='product'").get(),
    ).toEqual({ n: 8 });
    expect(
      db.database
        .prepare(
          "SELECT DISTINCT install_id,event_id,platform,app_version FROM usage_turns WHERE source='product'",
        )
        .all(),
    ).toEqual([{ install_id: "aggregate", event_id: 0, platform: "", app_version: "" }]);
    expect(
      db.database
        .prepare("SELECT DISTINCT received_at FROM usage_turns WHERE source='product'")
        .all(),
    ).toEqual([{ received_at: new Date(END).toISOString() }]);
    expect(db.database.prepare("SELECT received_at FROM host_usage_daily_quality").get()).toEqual({
      received_at: new Date(END).toISOString(),
    });
    expect(db.database.prepare("SELECT received_at FROM host_usage_receipts").get()).toEqual({
      received_at: new Date(NOW).toISOString(),
    });
    collect.dispose();
    await sender(root, async () => {
      throw Error("Restart must not replay a delivered window");
    }).flush();
    expect(files(root)).toEqual([]);
    const token = await signSession("test-key", Math.floor(NOW / 1000) + 3600);
    const dashboard = await worker.fetch(
      new Request(
        "https://worker.invalid/api/product?from=2026-11-07&to=2026-11-07&channel=stable",
        { headers: { cookie: `synara_beta_dash=${token}` } },
      ),
      { DB: db, DASHBOARD_SESSION_KEY: "test-key" },
    );
    const data = await dashboard.json();
    expect(data.hostExecutions.coverage).toMatchObject({
      reportWindows: 1,
      eligibleTurns: 8,
      includedTurns: 8,
      missingCompletionTimes: 1,
      tokenTruncatedTurns: 1,
    });
    expect(data.observedDesktopTurns.total).toBe(0);
    expect(data.hostExecutions.rows).toContainEqual(
      expect.objectContaining({
        inputSamples: 3,
        outputSamples: 3,
        meanInputTokens: 4,
        meanOutputTokens: 2,
      }),
    );
  });

  it("makes a capped projection window explicit and excludes time before sharing resumed", async () => {
    const root = makeRoot();
    vi.setSystemTime(START + 12 * 60 * 60 * 1000);
    const collect = sender(root, async () => new Response(null, { status: 503 }));
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedTurn("t1", { requestedAt: at(1000), completedAt: at(13 * 60 * 60 * 1000) });
        yield* sql`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<5001)
        INSERT INTO projection_turns (thread_id,turn_id,state,requested_at,completed_at,checkpoint_files_json)
        SELECT 'capped',printf('turn-%05d',x),'completed',${at(13 * 60 * 60 * 1000)},${at(14 * 60 * 60 * 1000)},'[]' FROM n`;
        yield* writeHostUsageSnapshots(root, NOW);
      }),
    );
    expect(snapshot(root)).toMatchObject({
      coveredFrom: at(12 * 60 * 60 * 1000),
      eligibleTurns: 5001,
      includedTurns: 5000,
    });
    const old = snapshot(root);
    collect.setEnabled(false);
    expect(files(root)).toEqual([]);
    vi.setSystemTime(NOW);
    collect.setEnabled(true);
    const directory = join(root, "product-analytics/host-usage");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${old.policyId}-2026-11-07.json`), JSON.stringify(old));
    await collect.flush();
    expect(
      JSON.parse(readFileSync(join(root, "product-analytics/host-usage-policy.json"), "utf8"))
        .policyId,
    ).not.toBe(old.policyId);
  });

  it("reports row limits explicitly and never places model/token fields on legacy diagnostic ingestion", async () => {
    const root = makeRoot(),
      db = makeDb();
    sender(root, async () => new Response(null, { status: 503 }));
    await run(
      Effect.gen(function* () {
        for (let n = 0; n < 101; n++)
          yield* seedTurn(`t${n}`, {
            effort: [
              "default",
              "none",
              "off",
              "minimal",
              "low",
              "medium",
              "high",
              "xhigh",
              "max",
              "ultrathink",
              "ultracode",
            ][n % 11],
            model:
              n < 11
                ? "claude-fable-5-1"
                : [
                    "claude-fable-5",
                    "claude-opus-5-5",
                    "claude-opus-5",
                    "claude-opus-4-8",
                    "claude-opus-4-7",
                    "claude-opus-4-6",
                    "claude-opus-4-5",
                    "claude-sonnet-5",
                    "claude-sonnet-4-6",
                  ][Math.floor(n / 11) - 1],
          });
        yield* writeHostUsageSnapshots(root, NOW);
      }),
    );
    expect(snapshot(root)).toMatchObject({ eligibleTurns: 101, includedTurns: 100 });
    expect(snapshot(root).rows).toHaveLength(100);
    vi.setSystemTime(NOW);
    for (const flavor of ["beta", "remote"]) {
      const response = await worker.fetch(
        new Request("https://worker.invalid/v1/events", {
          method: "POST",
          headers: { "content-type": "application/x-ndjson" },
          body: JSON.stringify({
            v: 1,
            id: crypto.randomUUID(),
            ts: new Date(NOW).toISOString(),
            installId: crypto.randomUUID(),
            appVersion: `1.2.3-${flavor}.1`,
            flavor,
            platform: "darwin",
            arch: "arm64",
            event: "usage.daily",
            payload: {
              kind: "usage",
              projects: 1,
              activeThreads: 1,
              providers: [{ provider: "codex", threads: 2, turns: 999, turnsFailed: 5 }],
              turnBreakdown: snapshot(root).rows,
            },
          }),
        }),
        { DB: db },
      );
      expect(response.status).toBe(200);
    }
    expect(db.database.prepare("SELECT COUNT(*) AS n FROM usage_turns").get()).toEqual({ n: 0 });
    expect(db.database.prepare("SELECT COUNT(*) AS n FROM usage_providers").get()).toEqual({
      n: 0,
    });
  });

  it("expires daily receipts after14days and host counters after90UTCdays while retaining recent aggregates", async () => {
    const db = makeDb();
    const oldReceipt = new Date(NOW - 15 * DAY).toISOString(),
      recentReceipt = new Date(NOW - 13 * DAY).toISOString();
    for (const [id, received] of [
      ["a".repeat(64), oldReceipt],
      ["b".repeat(64), recentReceipt],
    ])
      db.database
        .prepare("INSERT INTO host_usage_receipts VALUES (?, 'synthetic-attempt', ?)")
        .run(id, received);
    for (const [day, received] of [
      [new Date(NOW - 91 * DAY).toISOString().slice(0, 10), new Date(NOW).toISOString()],
      [new Date(NOW - 89 * DAY).toISOString().slice(0, 10), new Date(NOW).toISOString()],
    ]) {
      db.database
        .prepare(`INSERT INTO usage_turns (event_id,install_id,day,app_version,provider,model,effort,interaction_mode,runtime_mode,origin,outcome,received_at,source,channel)
        VALUES (0,'aggregate',?,'','codex','other','other','other','other','other','succeeded',?,'product','stable')`)
        .run(day, received);
      db.database
        .prepare(
          "INSERT INTO host_usage_daily_quality(day,channel,received_at) VALUES (?,'stable',?)",
        )
        .run(day, received);
    }
    await worker.scheduled({ scheduledTime: NOW }, { DB: db }, {});
    expect(db.database.prepare("SELECT window_id FROM host_usage_receipts").all()).toEqual([
      { window_id: "b".repeat(64) },
    ]);
    expect(
      db.database.prepare("SELECT COUNT(*) AS n FROM usage_turns WHERE source='product'").get(),
    ).toEqual({ n: 1 });
    expect(db.database.prepare("SELECT COUNT(*) AS n FROM host_usage_daily_quality").get()).toEqual(
      { n: 1 },
    );
  });

  it("aborts a host upload and ignores its delayed JSON receipt after opt-out/re-enable", async () => {
    const root = makeRoot();
    let signal, release, started;
    const reading = new Promise((resolve) => {
      started = resolve;
    });
    const late = new Promise((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const collect = sender(root, async (_url, init) => {
      calls++;
      signal = init.signal;
      const body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: () => {
          started();
          return late.then(() => ({ stored: true, windowId: body.hostUsage.windowId }));
        },
      };
    });
    await run(
      Effect.gen(function* () {
        yield* seedTurn("t1");
        yield* writeHostUsageSnapshots(root, NOW);
      }),
    );
    const old = snapshot(root);
    vi.setSystemTime(NOW);
    const uploading = collect.flush();
    await reading;
    collect.setEnabled(false);
    expect(signal.aborted).toBe(true);
    collect.setEnabled(true);
    const dir = join(root, "product-analytics/host-usage");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${old.policyId}-2026-11-07.json`), JSON.stringify(old));
    release();
    await uploading;
    expect(() =>
      readFileSync(join(root, "product-analytics/host-usage-receipts.json"), "utf8"),
    ).toThrow();
    await collect.flush();
    expect(calls).toBe(1);
  });

  it("marks an overflowing token field unknown while preserving independently measured zero", async () => {
    const root = makeRoot(),
      db = makeDb();
    const collect = sender(root, async (_url, init) =>
      worker.fetch(new Request("https://worker.invalid/v1/product-events", init), { DB: db }),
    );
    await run(
      Effect.gen(function* () {
        yield* seedTurn("t1", {
          usage: { m: { inputTokens: 800_000_000_000, outputTokens: 0, cacheReadInputTokens: 0 } },
        });
        yield* seedTurn("t2", {
          usage: { m: { inputTokens: 800_000_000_000, outputTokens: 0, cacheReadInputTokens: 0 } },
        });
        yield* writeHostUsageSnapshots(root, NOW);
      }),
    );
    expect(snapshot(root)).toMatchObject({
      cappedMeasurements: 1,
      includedTurns: 2,
      rows: [
        expect.objectContaining({
          inputTokens: 0,
          inputSamples: 0,
          outputTokens: 0,
          outputSamples: 2,
        }),
      ],
    });
    vi.setSystemTime(NOW);
    await collect.flush();
    const token = await signSession("test-key", Math.floor(NOW / 1000) + 3600);
    const response = await worker.fetch(
      new Request("https://worker.invalid/api/product?from=2026-11-07&to=2026-11-07", {
        headers: { cookie: `synara_beta_dash=${token}` },
      }),
      { DB: db, DASHBOARD_SESSION_KEY: "test-key" },
    );
    const data = await response.json();
    expect(data.hostExecutions.rows).toEqual([
      expect.objectContaining({
        inputTokens: null,
        inputSamples: 0,
        outputTokens: 0,
        outputSamples: 2,
        cachedInputTokens: 0,
        cachedInputSamples: 2,
      }),
    ]);
  });

  it.each([false, true])(
    "removes an old snapshot published during opt-out (sharing re-enabled: %s)",
    async (reenable) => {
      const root = makeRoot();
      const collect = sender(root, async () => new Response(null, { status: 503 }));
      const policyFile = join(root, "product-analytics/host-usage-policy.json");
      const oldPolicy = JSON.parse(readFileSync(policyFile, "utf8"));
      let releaseWrite, markWrite;
      const held = new Promise((resolve) => {
          releaseWrite = resolve;
        }),
        reached = new Promise((resolve) => {
          markWrite = resolve;
        });
      const realWrite = AtomicWrite.writeFileStringAtomically;
      const writing = vi
        .spyOn(AtomicWrite, "writeFileStringAtomically")
        .mockImplementation((input) =>
          Effect.gen(function* () {
            // Hold the actual atomic writer after the producer's final consent read.
            markWrite();
            yield* Effect.promise(() => held);
            return yield* realWrite(input);
          }),
        );
      let freshFile;
      try {
        await run(
          Effect.gen(function* () {
            yield* seedTurn("t1");
            const publishing = yield* Effect.forkChild(writeHostUsageSnapshots(root, NOW));
            yield* Effect.promise(() => reached);
            collect.setEnabled(false);
            expect(files(root)).toEqual([]);
            if (reenable) {
              collect.setEnabled(true);
              const fresh = JSON.parse(readFileSync(policyFile, "utf8"));
              expect(fresh.policyId).not.toBe(oldPolicy.policyId);
              freshFile = `${fresh.policyId}-2026-11-07.json`;
              const directory = join(root, "product-analytics/host-usage");
              mkdirSync(directory, { recursive: true });
              writeFileSync(join(directory, freshFile), "new generation");
            }
            releaseWrite();
            yield* Fiber.join(publishing);
          }),
        );
        expect(files(root)).toEqual(freshFile ? [freshFile] : []);
        if (freshFile)
          expect(readFileSync(join(root, "product-analytics/host-usage", freshFile), "utf8")).toBe(
            "new generation",
          );
      } finally {
        releaseWrite();
        writing.mockRestore();
      }
    },
  );

  it("rechecks durable opt-out after held SQL when the old policy could not be removed", async () => {
    const root = makeRoot();
    sender(root, async () => new Response(null, { status: 503 }));
    let releaseSql, markSql;
    const held = new Promise((resolve) => {
        releaseSql = resolve;
      }),
      reached = new Promise((resolve) => {
        markSql = resolve;
      });
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedTurn("t1");
        const guarded = Object.assign((...args) => sql(...args), sql, {
          withTransaction: (effect) =>
            sql.withTransaction(
              Effect.gen(function* () {
                markSql();
                yield* Effect.promise(() => held);
                return yield* effect;
              }),
            ),
        });
        const publishing = yield* Effect.forkChild(
          writeHostUsageSnapshots(root, NOW).pipe(
            Effect.provideService(SqlClient.SqlClient, guarded),
          ),
        );
        yield* Effect.promise(() => reached);
        // A failed policy unlink leaves this file intact, but durable consent is already off.
        expect(
          JSON.parse(readFileSync(join(root, "product-analytics/host-usage-policy.json"), "utf8"))
            .enabled,
        ).toBe(true);
        writeFileSync(
          join(root, "product-analytics/consent.json"),
          JSON.stringify({ enabled: false }),
        );
        releaseSql();
        yield* Fiber.join(publishing);
      }),
    );
    expect(files(root)).toEqual([]);
  });

  it("preserves a still-valid boundary-day frozen snapshot instead of regenerating late records", async () => {
    const root = makeRoot();
    sender(root, async () => new Response(null, { status: 503 }));
    await run(
      Effect.gen(function* () {
        yield* seedTurn("t1");
        yield* writeHostUsageSnapshots(root, NOW);
        const file = join(root, "product-analytics/host-usage", files(root)[0]);
        const frozen = readFileSync(file, "utf8");
        yield* seedTurn("t2");
        yield* writeHostUsageSnapshots(root, END + 13 * DAY + 12 * 60 * 60 * 1000);
        expect(readFileSync(file, "utf8")).toBe(frozen);
      }),
    );
  });

  it("merges newer catalog model collisions into other without losing independent samples", async () => {
    const db = makeDb();
    vi.setSystemTime(NOW);
    const row = {
      provider: "codex",
      effort: "high",
      interactionMode: "default",
      runtimeMode: "full-access",
      origin: "user",
      outcome: "succeeded",
      turns: 1,
      durationMs: 0,
      durationSamples: 0,
      inputTokens: 0,
      inputSamples: 0,
      outputTokens: 0,
      outputSamples: 0,
      cachedInputTokens: 0,
      cachedInputSamples: 0,
    };
    const response = await worker.fetch(
      new Request("https://worker.invalid/v1/product-events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hostUsage: {
            v: 1,
            windowId: "f".repeat(64),
            channel: "stable",
            windowStart: at(0),
            windowEnd: new Date(END).toISOString(),
            coveredFrom: at(0),
            generatedAt: new Date(NOW).toISOString(),
            eligibleTurns: 2,
            includedTurns: 2,
            missingCompletionTimes: 0,
            tokenTruncatedTurns: 0,
            cappedMeasurements: 0,
            rows: [
              { ...row, model: "gpt-next-release-a", inputTokens: 4, inputSamples: 1 },
              { ...row, model: "gpt-next-release-b", outputTokens: 7, outputSamples: 1 },
            ],
          },
        }),
      }),
      { DB: db },
    );
    expect(response.status).toBe(200);
    expect(
      db.database
        .prepare(
          "SELECT provider,model,turns,input_tokens,input_samples,output_tokens,output_samples,cached_input_tokens,cached_input_samples FROM usage_turns WHERE source='product'",
        )
        .all(),
    ).toEqual([
      {
        provider: "codex",
        model: "other",
        turns: 2,
        input_tokens: 4,
        input_samples: 1,
        output_tokens: 7,
        output_samples: 1,
        cached_input_tokens: 0,
        cached_input_samples: 0,
      },
    ]);
  });

  it("does no projection collection without product consent on Stable", async () => {
    const root = makeRoot();
    sender(
      root,
      async () => {
        throw Error("Disabled analytics must not send");
      },
      { defaultEnabled: false, enabled: false },
    );
    await run(writeHostUsageSnapshots(root, NOW));
    expect(files(root)).toEqual([]);
    expect(readdirSync(root)).not.toContain("diagnostics");
  });
});

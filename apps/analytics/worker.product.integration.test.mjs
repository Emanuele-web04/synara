import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import worker, { signSession } from "./worker.ts";

class SQLiteD1Statement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new SQLiteD1Statement(this.database, this.sql, values);
  }

  run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({
      meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
    });
  }

  all() {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) });
  }

  first() {
    return Promise.resolve(this.database.prepare(this.sql).get(...this.values) ?? null);
  }
}

class SQLiteD1 {
  constructor() {
    this.database = new DatabaseSync(":memory:");
  }

  prepare(sql) {
    return new SQLiteD1Statement(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.database.close();
  }
}

describe("product event route and D1 storage", () => {
  let db;
  let env;
  let now;
  let day;

  beforeEach(() => {
    db = new SQLiteD1();
    const migrationFiles = readdirSync(new URL("./migrations/", import.meta.url))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const name of migrationFiles) {
      db.database.exec(readFileSync(new URL(`./migrations/${name}`, import.meta.url), "utf8"));
    }
    env = { DB: db, DASHBOARD_SESSION_KEY: "test-session-key" };
    now = Date.now();
    day = new Date(now).toISOString().slice(0, 10);
  });

  afterEach(() => db.close());

  const envelope = (overrides = {}) => ({
    v: 1,
    id: crypto.randomUUID(),
    ts: new Date(now).toISOString(),
    installId: "00000000-0000-4000-8000-000000000001",
    channel: "stable",
    surface: "desktop",
    platform: "darwin",
    appVersion: "1.2.3",
    event: "feature.used",
    outcome: "succeeded",
    feature: "settings",
    durationMs: 120,
    ...overrides,
  });

  const postEvents = (events, headers = { "content-type": "application/json" }) =>
    worker.fetch(
      new Request("https://worker.invalid/v1/product-events", {
        method: "POST",
        headers,
        body: JSON.stringify({ events }),
      }),
      env,
    );

  it("validates, strips unknown fields, deduplicates, and serves aggregate data behind dashboard auth", async () => {
    const stable = envelope({ privateValue: "must not persist" });
    const beta = envelope({
      id: crypto.randomUUID(),
      installId: "00000000-0000-4000-8000-000000000002",
      channel: "beta",
      event: "connection.connect",
      outcome: "failed",
      feature: undefined,
      mode: "remote",
      durationMs: 300,
    });
    const desktopTurnA = envelope({
      id: crypto.randomUUID(),
      event: "turn.completed",
      feature: undefined,
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 2,
      durationMs: undefined,
    });
    const desktopTurnB = envelope({
      id: crypto.randomUUID(),
      event: "turn.completed",
      feature: undefined,
      inputTokens: 20,
      durationMs: undefined,
    });
    const mobileTurn = envelope({
      id: crypto.randomUUID(),
      surface: "ios",
      platform: "ios",
      event: "turn.completed",
      feature: undefined,
      inputTokens: 1000,
      outputTokens: 1000,
      durationMs: undefined,
    });
    const response = await postEvents([
      stable,
      stable,
      beta,
      desktopTurnA,
      desktopTurnB,
      mobileTurn,
      { ...stable, event: "unknown" },
    ]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 5, received: 7 });

    const stored = db.database.prepare("SELECT * FROM product_events ORDER BY channel").all();
    expect(stored).toHaveLength(5);
    expect(Object.keys(stored[0])).not.toContain("privateValue");
    expect(stored.find((row) => row.channel === "stable")).toMatchObject({
      event: "feature.used",
      feature: "settings",
      duration_ms: 120,
    });

    const unauthorized = await worker.fetch(
      new Request(`https://worker.invalid/api/product?from=${day}&to=${day}`),
      env,
    );
    expect(unauthorized.status).toBe(401);

    const token = await signSession("test-session-key", Math.floor(Date.now() / 1000) + 3600);
    const dashboard = await worker.fetch(
      new Request(
        `https://worker.invalid/api/product?from=${day}&to=${day}&channel=stable&surface=desktop`,
        {
          headers: { cookie: `synara_beta_dash=${token}` },
        },
      ),
      env,
    );
    expect(dashboard.status).toBe(200);
    expect(await dashboard.json()).toMatchObject({
      channel: "stable",
      surface: "desktop",
      events: 3,
      activeInstallations: 1,
      daily: [{ events: 3, installations: 1 }],
      features: [{ feature: "settings", events: 1, installations: 1 }],
      outcomes: [
        { event: "feature.used", outcome: "succeeded", events: 1 },
        { event: "turn.completed", outcome: "succeeded", events: 2 },
      ],
      latency: [{ event: "feature.used", meanDurationMs: 120, samples: 1 }],
      observedDesktopCompletions: {
        inputTokens: { total: 30, samples: 2 },
        outputTokens: { total: 5, samples: 1 },
        cachedInputTokens: { total: 2, samples: 1 },
      },
      eventTypes: [
        { event: "turn.completed", events: 2, installations: 1 },
        { event: "feature.used", events: 1, installations: 1 },
      ],
    });
  });

  it("counts terminal desktop observations by provider without treating requests or missing usage as completed turns", async () => {
    const turn = (patch) =>
      envelope({ event: "turn.completed", feature: undefined, durationMs: undefined, ...patch });
    const first = turn({ provider: "codex", inputTokens: 0, outputTokens: 3 });
    await postEvents([
      first,
      first,
      turn({ provider: "codex", outcome: "failed", inputTokens: 10 }),
      turn({ provider: "claude", outcome: "cancelled", cachedInputTokens: 4 }),
      turn({ provider: undefined }),
      turn({ provider: "codex", outcome: "started", inputTokens: 999 }),
      turn({ provider: "codex", event: "chat.request", inputTokens: 999 }),
      turn({ provider: "codex", surface: "ios", platform: "ios", inputTokens: 999 }),
      turn({ provider: "codex", channel: "beta", inputTokens: 999 }),
    ]);
    const token = await signSession("test-session-key", Math.floor(Date.now() / 1000) + 3600);
    const read = async (surface) =>
      (
        await worker.fetch(
          new Request(
            `https://worker.invalid/api/product?from=${day}&to=${day}&channel=stable&surface=${surface}`,
            { headers: { cookie: `synara_beta_dash=${token}` } },
          ),
          env,
        )
      ).json();
    const data = await read("desktop");
    expect(data.daily).toEqual([{ day, events: 6, installations: 1, turns: 4 }]);
    expect(data.observedDesktopTurns).toMatchObject({
      total: 4,
      succeeded: 2,
      failed: 1,
      cancelled: 1,
      providers: [
        {
          provider: "codex",
          turns: 2,
          succeeded: 1,
          failed: 1,
          cancelled: 0,
          inputTokens: 10,
          inputSamples: 2,
          outputTokens: 3,
          outputSamples: 1,
          cachedInputTokens: null,
          cachedInputSamples: 0,
        },
        {
          provider: "claude",
          turns: 1,
          succeeded: 0,
          failed: 0,
          cancelled: 1,
          inputTokens: null,
          inputSamples: 0,
          outputTokens: null,
          outputSamples: 0,
          cachedInputTokens: 4,
          cachedInputSamples: 1,
        },
        {
          provider: "unknown",
          turns: 1,
          succeeded: 1,
          failed: 0,
          cancelled: 0,
          inputTokens: null,
          inputSamples: 0,
          outputTokens: null,
          outputSamples: 0,
          cachedInputTokens: null,
          cachedInputSamples: 0,
        },
      ],
    });
    expect(data.observedDesktopCompletions.inputTokens).toEqual({ total: 10, samples: 2 });
    const mobile = await read("ios");
    expect(mobile.observedDesktopTurns).toMatchObject({
      total: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      providers: [],
    });
    expect(mobile.observedDesktopCompletions.inputTokens).toEqual({ total: null, samples: 0 });
  });

  it("compares provider observations over equal complete UTC periods with the same filters", async () => {
    const date = (days) => new Date(now - days * 86_400_000).toISOString().slice(0, 10);
    const turn = (days, provider, patch = {}) =>
      envelope({
        ts: `${date(days)}T12:00:00.000Z`,
        event: "turn.completed",
        feature: undefined,
        provider,
        ...patch,
      });
    await postEvents([
      turn(1, "claude"),
      turn(1, "claude"),
      turn(2, "codex"),
      turn(3, "claude"),
      turn(4, "codex"),
      turn(3, "codex", { channel: "beta" }),
      turn(1, "codex", { surface: "ios", platform: "ios" }),
    ]);
    const token = await signSession("test-session-key", Math.floor(Date.now() / 1000) + 3600);
    const read = async (from, to) =>
      (
        await worker.fetch(
          new Request(
            `https://worker.invalid/api/product?from=${from}&to=${to}&channel=stable&surface=desktop`,
            { headers: { cookie: `synara_beta_dash=${token}` } },
          ),
          env,
        )
      ).json();
    const data = await read(date(2), date(1));
    expect(data.observedDesktopTurns.daily).toEqual([
      { day: date(2), provider: "codex", turns: 1 },
      { day: date(1), provider: "claude", turns: 2 },
    ]);
    expect(data.observedDesktopTurns.previous).toEqual({
      from: date(4),
      to: date(3),
      providers: [
        { provider: "claude", turns: 1 },
        { provider: "codex", turns: 1 },
      ],
    });
    expect((await read(date(1), date(0))).observedDesktopTurns.previous).toBeNull();
    expect((await read(date(29), date(1))).observedDesktopTurns.previous).toBeNull();
  });

  it("rejects malformed requests and bounds request size and dashboard date filters", async () => {
    expect((await postEvents([envelope()], { "content-type": "text/plain" })).status).toBe(415);
    const tooMany = await postEvents(Array.from({ length: 51 }, () => envelope()));
    expect(tooMany.status).toBe(413);
    const badBody = await worker.fetch(
      new Request("https://worker.invalid/v1/product-events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      env,
    );
    expect(badBody.status).toBe(400);
    const token = await signSession("test-session-key", Math.floor(Date.now() / 1000) + 3600);
    const badRange = await worker.fetch(
      new Request("https://worker.invalid/api/product?from=2026-09-01&to=2026-10-05", {
        headers: { cookie: `synara_beta_dash=${token}` },
      }),
      env,
    );
    expect(badRange.status).toBe(400);
  });

  it("sweeps only product events older than 30 days", async () => {
    const oldReceived = new Date(now - 31 * 86_400_000).toISOString();
    const insertOldProduct = db.database.prepare(
      `INSERT INTO product_events (
        event_id, ts, received_at, install_id, channel, surface, platform, app_version,
        event, outcome
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.database.exec("BEGIN");
    for (let index = 0; index < 10_001; index += 1) {
      insertOldProduct.run(
        `old-${index}`,
        oldReceived,
        oldReceived,
        "00000000-0000-4000-8000-000000000003",
        "stable",
        "desktop",
        "darwin",
        "1.2.3",
        "app.open",
        "started",
      );
    }
    db.database.exec("COMMIT");
    await worker.fetch(
      new Request("https://worker.invalid/v1/product-events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: [envelope()] }),
      }),
      env,
    );
    db.database
      .prepare(
        `INSERT INTO events (ts, received_at, install_id, app_version, event)
       VALUES (?, ?, ?, ?, ?)`,
      )
      .run(oldReceived, oldReceived, "00000000-0000-4000-8000-000000000004", "1.2.3", "app.error");

    await worker.scheduled({ scheduledTime: now }, env, {});

    expect(db.database.prepare("SELECT COUNT(*) AS n FROM product_events").get().n).toBe(1);
    expect(db.database.prepare("SELECT COUNT(*) AS n FROM events").get().n).toBe(1);
  });
});

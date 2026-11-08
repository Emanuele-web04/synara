// Integration boundary: synthetic requests, SQLite-backed D1, migrations and retention.
// No network, credentials or production data are used.
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker, {
  purgeLegacyDiagnosticContent,
  purgeLegacyDiagnosticDumps,
  signSession,
} from "./worker.ts";
import { BetaDiagnostics } from "../desktop/src/betaDiagnostics.ts";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
} from "../desktop/src/updateMachine.ts";

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

// Run the real ordered SQL migrations, optionally stopping at a deployed schema.
function applyMigrations(database, through = "9999") {
  const files = readdirSync(new URL("./migrations/", import.meta.url))
    .filter((name) => /^\d{4}_.*\.sql$/.test(name) && name.slice(0, 4) <= through)
    .sort();
  for (const name of files)
    database.exec(readFileSync(new URL(`./migrations/${name}`, import.meta.url), "utf8"));
}

describe("analytics ingest and D1 storage", () => {
  let db;
  let env;
  let now;
  let day;

  beforeEach(() => {
    db = new SQLiteD1();
    applyMigrations(db.database);
    env = { DB: db, DASHBOARD_SESSION_KEY: "test-session-key" };
    now = Date.now();
    day = new Date(now).toISOString().slice(0, 10);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();

vi.unstubAllGlobals();
  });

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

  it("excludes diagnostic content from Beta queues, legacy uploads and stored rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "diagnostic-canary-"));
    const canary = "violet kettle private draft";
    const diagnostics = new BetaDiagnostics({
      homeDir: root,
      appVersion: "1.2.3-beta.1",
      platform: "darwin",
      arch: "arm64",
      env: {},
    });
    try {
      const error = new TypeError(canary);
      error.stack = `TypeError: ${canary}\n    at privateDocument (violet-notes.txt:10:5)`;
      diagnostics.trackError("main", error);
      diagnostics.track("app.child-process-crash", {
        kind: "crash",
        processType: "backend",
        reason: "code=1 signal=null",
        logTail: canary,
      });
      diagnostics.track("update.error", {
        kind: "update",
        outcome: "error",
        reason: "network",
        message: canary,
      });
      const queue = join(root, "diagnostics", "events.jsonl");
      expect(readFileSync(queue, "utf8")).not.toContain(canary);
      const old = {
        v: 1,
        id: crypto.randomUUID(),
        ts: new Date(now).toISOString(),
        installId: diagnostics.installId,
        appVersion: "1.2.3-beta.1",
        flavor: "beta",
        platform: "darwin",
        arch: "arm64",
        event: "app.error",
        payload: {
          kind: "error",
          source: "renderer",
          message: canary,
          stack: `TypeError: ${canary}\n at privateFile (violet-notes.txt:20:7)`,
          fingerprint: "abcdef0123456789",
          privateExtra: canary,
        },
        privateExtra: canary,
      };
      appendFileSync(queue, `${JSON.stringify(old)}\n`);
      const bodies = [];
      vi.stubGlobal("fetch", async (_url, options) => {
        bodies.push(options.body);
        return bodies.length === 1
          ? new Response("synthetic offline", { status: 503 })
          : worker.fetch(new Request("https://worker.invalid/v1/events", options), env);
      });
      await diagnostics.flush();
      expect(readFileSync(queue, "utf8")).not.toMatch(/violet|private draft|privateExtra/);
      await diagnostics.flush();
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).not.toMatch(/violet|private draft|privateExtra/);
      const rows = db.database.prepare("SELECT message, stack, log_tail, reason FROM events").all();
      expect(rows).toHaveLength(4);
      expect(JSON.stringify(rows)).not.toMatch(/violet|private draft/);
      expect(rows[0]).toMatchObject({
        message: "TypeError at main:10:5",
        stack: "at main:10:5",
        log_tail: null,
      });
      expect(rows[1]).toMatchObject({ reason: "code=1 signal=null", log_tail: null });
    } finally {
      await diagnostics.dispose(0);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["beta", "remote"])(
    "guards historical and handcrafted %s diagnostic content at storage and read boundaries",
    async (flavor) => {
      const canary = "violet kettle private draft";
      const event = {
        v: 1,
        id: crypto.randomUUID(),
        ts: new Date(now).toISOString(),
        installId: "00000000-0000-4000-8000-000000000001",
        appVersion: "1.2.3-beta.1",
        flavor,
        platform: "darwin",
        arch: "arm64",
        event: "app.error",
        payload: {
          kind: "error",
          source: "renderer",
          message: canary,
          stack: `TypeError: ${canary}\n at privateFile (violet-notes.txt:10:5)`,
          logTail: canary,
          fingerprint: "1234567812345678",
        },
      };
      await worker.fetch(
        new Request("https://worker.invalid/v1/events", {
          method: "POST",
          body: JSON.stringify(event),
        }),
        env,
      );
      const stored = db.database.prepare("SELECT * FROM events").get();
      expect(JSON.stringify(stored)).not.toMatch(/violet|private draft/);
      // Existing deployed rows must stay safe before the cleanup migration is applied.
      db.database
        .prepare("UPDATE events SET message = ?, stack = ?, log_tail = ?, fingerprint = ?")
        .run(
          canary,
          `TypeError: ${canary}\n at privateFile (violet-notes.txt:30:9)`,
          canary,
          "1234567812345678",
        );
      const token = await signSession("test-session-key", Math.floor(Date.now() / 1000) + 3600);
      const response = await worker.fetch(
        new Request("https://worker.invalid/api/issues/err:1234567812345678?days=7", {
          headers: { cookie: `synara_beta_dash=${token}` },
        }),
        env,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).not.toMatch(/violet|private draft/);
    },
  );

  it("rejects raw dump uploads and downloads without consuming content or accessing storage", async () => {
    const put = vi.fn();
    const get = vi.fn();
    env.CRASH_DUMPS = { put, get };
    const form = new FormData();
    form.set("upload_file_minidump", new File(["violet kettle private draft"], "synthetic.dmp"));
    const request = new Request("https://worker.invalid/v1/crash", { method: "POST", body: form });
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(410);
    expect(request.bodyUsed).toBe(false);
    expect(put).not.toHaveBeenCalled();
    expect(db.database.prepare("SELECT COUNT(*) AS n FROM crash_dumps").get()).toEqual({ n: 0 });
    const token = await signSession("test-session-key", Math.floor(Date.now() / 1000) + 3600);
    const download = await worker.fetch(
      new Request("https://worker.invalid/api/dumps/dumps/synthetic.dmp", {
        headers: { cookie: `synara_beta_dash=${token}` },
      }),
      env,
    );
    expect(download.status).toBe(410);
    expect(get).not.toHaveBeenCalled();
  });

  it("scrubs historical diagnostic content and safely retries bounded dump cleanup including orphans", async () => {
    db.close();
    db = new SQLiteD1();
    applyMigrations(db.database, "0007");
    env.DB = db;
    const canary = "violet kettle private draft";
    db.database
      .prepare(
        `INSERT INTO events (ts, received_at, install_id, app_version, event, kind, message, stack, log_tail, fingerprint, process_type, reason) VALUES (?, ?, 'synthetic-install', '1.2.3-beta.1', 'app.error', 'error', ?, ?, ?, '1234567812345678', ?, ?)`,
      )
      .run(
        new Date(now).toISOString(),
        new Date(now).toISOString(),
        canary,
        canary,
        canary,
        canary,
        canary,
      );
    for (let index = 0; index < 100; index++) {
      db.database
        .prepare(
          "INSERT INTO events (ts, received_at, install_id, app_version, event, kind, message) SELECT ts, received_at, install_id, app_version, event, kind, message FROM events WHERE id = 1",
        )
        .run();
    }
    db.database
      .prepare("INSERT INTO issue_status VALUES (?, 'resolved', ?)")
      .run(`err:${canary}`, new Date(now).toISOString());
    db.database.exec(
      readFileSync(
        new URL("./migrations/0009_diagnostics_content_boundary.sql", import.meta.url),
        "utf8",
      ),
    );
    expect(await purgeLegacyDiagnosticContent(env)).toEqual({
      eventsScrubbed: 100,
      statusRowsDeleted: 0,
      complete: false,
    });
    expect(await purgeLegacyDiagnosticContent(env)).toEqual({
      eventsScrubbed: 1,
      statusRowsDeleted: 1,
      complete: true,
    });
    expect(await purgeLegacyDiagnosticContent(env)).toEqual({
      eventsScrubbed: 0,
      statusRowsDeleted: 0,
      complete: true,
    });
    const rows = db.database
      .prepare("SELECT message, stack, log_tail, process_type, reason, fingerprint FROM events")
      .all();
    expect(rows).toHaveLength(101);
    for (const row of rows)
      expect(row).toEqual({
        message: null,
        stack: null,
        log_tail: null,
        process_type: "",
        reason: "",
        fingerprint: "0000000000000000",
      });
    expect(db.database.prepare("SELECT COUNT(*) AS n FROM issue_status").get()).toEqual({ n: 0 });
    const objects = new Set([
      "dumps/indexed.dmp",
      "dumps/orphan.dmp",
      ...Array.from({ length: 100 }, (_, index) => `dumps/orphan-${index}.dmp`),
      "unrelated/keep",
    ]);
    db.database
      .prepare(
        "INSERT INTO crash_dumps (r2_key, install_id, ts, received_at) VALUES ('dumps/indexed.dmp', 'synthetic-install', ?, ?)",
      )
      .run(new Date(now).toISOString(), new Date(now).toISOString());
    db.database
      .prepare(
        "INSERT INTO crash_dumps (r2_key, install_id, ts, received_at) VALUES ('dumps/already-absent.dmp', 'synthetic-install', ?, ?)",
      )
      .run(new Date(now).toISOString(), new Date(now).toISOString());
    let fail = true;
    env.CRASH_DUMPS = {
      list: vi.fn(async ({ prefix, limit }) => ({
        objects: [...objects]
          .filter((key) => key.startsWith(prefix))
          .slice(0, limit)
          .map((key) => ({ key })),
        truncated: false,
      })),
      delete: async (keys) => {
        if (fail) {
          fail = false;
          throw new Error("synthetic deletion failure");
        }
        for (const key of keys) objects.delete(key);
      },
    };
    await worker.scheduled({ scheduledTime: now }, env);
    expect(env.CRASH_DUMPS.list).not.toHaveBeenCalled();
    await expect(purgeLegacyDiagnosticDumps(env)).rejects.toThrow("synthetic deletion failure");
    expect(db.database.prepare("SELECT COUNT(*) AS n FROM crash_dumps").get()).toEqual({ n: 2 });
    expect(await purgeLegacyDiagnosticDumps(env)).toEqual({ objectsDeleted: 100, rowsDeleted: 1 });
    expect(await purgeLegacyDiagnosticDumps(env)).toEqual({ objectsDeleted: 2, rowsDeleted: 0 });
    expect(await purgeLegacyDiagnosticDumps(env)).toEqual({ objectsDeleted: 0, rowsDeleted: 1 });
    expect(await purgeLegacyDiagnosticDumps(env)).toEqual({ objectsDeleted: 0, rowsDeleted: 0 });
    expect([...objects]).toEqual(["unrelated/keep"]);
  });

  it("upgrades the legacy D1 schema by removing account linkage and preserving product fields", () => {
    const legacy = new SQLiteD1();
    try {
      applyMigrations(legacy.database, "0006");
      legacy.database
        .prepare(`INSERT INTO product_events (
        event_id, ts, received_at, install_id, account_hash, channel, surface, platform, app_version,
        event, outcome, feature, mode, provider, reason, command, duration_ms, input_tokens, output_tokens, cached_input_tokens
      ) VALUES ('synthetic-event', ?, ?, 'synthetic-install', ?, 'remote', 'desktop', 'darwin', '1.2.3',
        'command.used', 'failed', 'chat', 'remote', 'codex', 'timeout', 'slash:plan', 9, 11, 12, 13)`)
        .run(new Date(now).toISOString(), new Date(now).toISOString(), "f".repeat(32));
      const { account_hash, ...preserved } = legacy.database
        .prepare("SELECT * FROM product_events")
        .get();
      expect(account_hash).toBe("f".repeat(32));
      legacy.database.exec(
        readFileSync(
          new URL("./migrations/0007_installation_privacy.sql", import.meta.url),
          "utf8",
        ),
      );
      expect(legacy.database.prepare("SELECT * FROM product_events").get()).toEqual(preserved);
      expect(
        legacy.database
          .prepare("PRAGMA table_info(product_events)")
          .all()
          .map((column) => column.name),
      ).not.toContain("account_hash");
      // Existing rows still participate in the installation-only aggregates.
      expect(
        legacy.database
          .prepare("SELECT COUNT(DISTINCT install_id) AS installations FROM product_events")
          .get(),
      ).toEqual({ installations: 1 });
    } finally {
      legacy.close();
    }
  });

  it("sanitizes historical categories before migration and preserves their aggregates after migration", async () => {
    const legacy = new SQLiteD1();
    try {
      applyMigrations(legacy.database, "0006");
      legacy.database.exec(
        readFileSync(new URL("./migrations/0008_product_cohorts.sql", import.meta.url), "utf8"),
      );
      const at = new Date(now).toISOString();
      const installId = "00000000-0000-4000-8000-0000000000f1";
      const eventId = Number(
        legacy.database
          .prepare(`INSERT INTO events
        (ts, received_at, install_id, app_version, platform, arch, event, kind, flavor)
        VALUES (?, ?, ?, '1.2.3', 'darwin', 'arm64', 'usage.daily', 'usage', 'beta')`)
          .run(at, at, installId).lastInsertRowid,
      );
      for (const [provider, turns] of [
        ["codex", 2],
        ["other", 7],
        ["privateProviderA", 3],
        ["privateProviderB", 5],
      ]) {
        legacy.database
          .prepare(`INSERT INTO usage_providers
          (event_id, install_id, day, app_version, platform, provider, threads, turns, turns_failed, received_at)
          VALUES (?, ?, ?, '1.2.3', 'darwin', ?, 1, ?, 1, ?)`)
          .run(eventId, installId, day, provider, turns, at);
      }
      for (const [provider, model, effort, interaction, runtime, origin, outcome, turns] of [
        ["claudeAgent", "claude-fable-5-1", "high", "plan", "full-access", "user", "succeeded", 2],
        [
          "privateProviderA",
          "privateModelA",
          "privateEffort",
          "privateMode",
          "privateRuntime",
          "privateOrigin",
          "failed",
          3,
        ],
        [
          "privateProviderB",
          "privateModelB",
          "privateEffort",
          "privateMode",
          "privateRuntime",
          "privateOrigin",
          "cancelled",
          5,
        ],
        // A catalog model is safe only for its own provider.
        ["codex", "claude-fable-5-1", "high", "plan", "full-access", "user", "succeeded", 1],
      ]) {
        legacy.database
          .prepare(`INSERT INTO usage_turns
          (event_id, install_id, day, app_version, platform, flavor, provider, model, effort,
           interaction_mode, runtime_mode, origin, outcome, turns, duration_ms, duration_samples,
           input_tokens, output_tokens, cached_input_tokens, token_samples, received_at)
          VALUES (?, ?, ?, '1.2.3', 'darwin', 'beta', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1, ?)`)
          .run(
            eventId,
            installId,
            day,
            provider,
            model,
            effort,
            interaction,
            runtime,
            origin,
            outcome,
            turns,
            turns * 1000,
            turns * 10,
            turns * 2,
            turns,
            at,
          );
      }
      for (const [index, command] of [
        "slash:plan",
        "slash:privateCustomerA",
        "slash:privateCustomerB",
        "shortcut:privateCustomer",
      ].entries()) {
        legacy.database
          .prepare(`INSERT INTO product_events
          (event_id, ts, received_at, install_id, channel, surface, platform, app_version, event, outcome, command)
          VALUES (?, ?, ?, ?, 'beta', 'desktop', 'darwin', '1.2.3', 'command.used', 'succeeded', ?)`)
          .run(`legacy-command-${index}`, at, at, installId, command);
      }
      const totals = () => ({
        product: legacy.database.prepare("SELECT COUNT(*) AS events FROM product_events").get(),
        providers: legacy.database
          .prepare(
            "SELECT SUM(threads) AS threads, SUM(turns) AS turns, SUM(turns_failed) AS failed FROM usage_providers",
          )
          .get(),
        turns: legacy.database
          .prepare(`SELECT SUM(turns) AS turns, SUM(duration_ms) AS durationMs,
          SUM(duration_samples) AS durationSamples, SUM(input_tokens) AS inputTokens,
          SUM(output_tokens) AS outputTokens, SUM(cached_input_tokens) AS cachedInputTokens,
          SUM(token_samples) AS tokenSamples FROM usage_turns`)
          .get(),
      });
      const originalTotals = totals();
      const token = await signSession("test-session-key", Math.floor(Date.now() / 1000) + 3600);
      const read = async (path) => {
        const response = await worker.fetch(
          new Request(`https://worker.invalid${path}`, {
            headers: { cookie: `synara_beta_dash=${token}` },
          }),
          { DB: legacy, DASHBOARD_SESSION_KEY: "test-session-key" },
        );
        expect(response.status).toBe(200);
        return response.json();
      };
      const usagePath = "/api/usage?days=7&flavor=beta&version=1.2.3&platform=darwin";
      const productPath = `/api/product?from=${day}&to=${day}&channel=beta&surface=desktop`;
      const before = { usage: await read(usagePath), product: await read(productPath) };
      expect(JSON.stringify(before)).not.toContain("private");
      expect(before.usage.providers).toHaveLength(2);
      expect(before.usage.providers).toContainEqual(
        expect.objectContaining({ provider: "other", installs: 1, threads: 3, turns: 15 }),
      );
      expect(before.usage.turnBreakdown).toHaveLength(3);
      expect(before.usage.turnBreakdown).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider: "claudeAgent",
            model: "claude-fable-5-1",
            effort: "high",
            turns: 2,
            installs: 1,
          }),
          expect.objectContaining({ provider: "codex", model: "other", turns: 1, installs: 1 }),
          expect.objectContaining({
            provider: "other",
            model: "other",
            effort: "other",
            interactionMode: "other",
            runtimeMode: "other",
            origin: "other",
            turns: 8,
            failed: 3,
            cancelled: 5,
            installs: 1,
            meanDurationMs: 4000,
            meanInputTokens: 40,
          }),
        ]),
      );
      expect(before.product.commands).toEqual(
        expect.arrayContaining([
          { command: "slash:plan", events: 1, installations: 1 },
          { command: "slash:custom", events: 2, installations: 1 },
          { command: "shortcut:custom", events: 1, installations: 1 },
        ]),
      );
      legacy.database.exec(
        readFileSync(
          new URL("./migrations/0007_installation_privacy.sql", import.meta.url),
          "utf8",
        ),
      );
      expect(totals()).toEqual(originalTotals);
      expect({ usage: await read(usagePath), product: await read(productPath) }).toEqual(before);
      const stored = ["usage_providers", "usage_turns", "product_events"].map((table) =>
        legacy.database.prepare(`SELECT * FROM ${table}`).all(),
      );
      expect(JSON.stringify(stored)).not.toContain("private");
      expect(
        legacy.database
          .prepare("SELECT provider, turns FROM usage_providers ORDER BY provider")
          .all(),
      ).toEqual([
        { provider: "codex", turns: 2 },
        { provider: "other", turns: 15 },
      ]);
    } finally {
      legacy.close();
    }
  });

  it("accepts legacy clients with cohort columns before and after account-column removal", async () => {
    const legacy = new SQLiteD1();
    try {
      applyMigrations(legacy.database, "0006");
      // The cohort receiver requires its additive columns; account removal is independent.
      legacy.database.exec(
        readFileSync(new URL("./migrations/0008_product_cohorts.sql", import.meta.url), "utf8"),
      );
      const send = () =>
        worker.fetch(
          new Request("https://worker.invalid/v1/product-events", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ events: [envelope({ accountHash: "f".repeat(32) })] }),
          }),
          { DB: legacy },
        );
      expect(await (await send()).json()).toEqual({ accepted: 1, received: 1 });
      expect(legacy.database.prepare("SELECT account_hash FROM product_events").get()).toEqual({
        account_hash: null,
      });
      legacy.database.exec(
        readFileSync(
          new URL("./migrations/0007_installation_privacy.sql", import.meta.url),
          "utf8",
        ),
      );
      expect(await (await send()).json()).toEqual({ accepted: 1, received: 1 });
      expect(legacy.database.prepare("SELECT COUNT(*) AS n FROM product_events").get()).toEqual({
        n: 2,
      });
    } finally {
      legacy.close();
    }
  });

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

  it("stores the Remote lane and reports active installations, platforms and failure reasons", async () => {
    const remote = (patch) =>
      envelope({
        id: crypto.randomUUID(),
        channel: "remote",
        feature: undefined,
        durationMs: undefined,
        ...patch,
      });
    const mac = "00000000-0000-4000-8000-0000000000a1";
    const phone = "00000000-0000-4000-8000-0000000000a2";
    const windows = "00000000-0000-4000-8000-0000000000a3";
    // Legacy account fields never join the Mac and phone installations.
    const person = "0123456789abcdef0123456789abcdef";
    const response = await postEvents([
      remote({ installId: mac, accountHash: person, event: "app.active", outcome: "succeeded" }),
      remote({ installId: mac, event: "chat.request", outcome: "succeeded" }),
      remote({
        installId: phone,
        accountHash: person,
        surface: "ios",
        platform: "ios",
        event: "connection.connect",
        outcome: "failed",
        mode: "remote",
        reason: "not_accepting",
      }),
      remote({
        installId: windows,
        platform: "win32",
        event: "chat.request",
        outcome: "failed",
        reason: "timeout",
      }),
      // A cause on a success is malformed and dropped.
      remote({ installId: mac, event: "chat.request", outcome: "succeeded", reason: "timeout" }),
      remote({ installId: mac, event: "chat.request", outcome: "failed", reason: "made_up" }),
      remote({
        installId: mac,
        accountHash: "not-a-hash",
        event: "app.open",
        outcome: "succeeded",
      }),
      remote({
        installId: mac,
        event: "command.used",
        outcome: "succeeded",
        command: "slash:plan",
      }),
      remote({
        installId: windows,
        platform: "win32",
        event: "command.used",
        outcome: "succeeded",
        command: "shortcut:terminal.toggle",
      }),
      // Free text, a missing command, or a command on another event is dropped.
      remote({
        installId: mac,
        event: "command.used",
        outcome: "succeeded",
        command: "slash:my secret",
      }),
      remote({ installId: mac, event: "command.used", outcome: "succeeded" }),
      remote({ installId: mac, event: "app.open", outcome: "succeeded", command: "slash:plan" }),
    ]);
    expect(await response.json()).toEqual({ accepted: 7, received: 12 });

    const token = await signSession("test-session-key", Math.floor(Date.now() / 1000) + 3600);
    const dashboard = await worker.fetch(
      new Request(`https://worker.invalid/api/product?from=${day}&to=${day}&channel=remote`, {
        headers: { cookie: `synara_beta_dash=${token}` },
      }),
      env,
    );
    const body = await dashboard.json();
    expect(body.activeUsers).toEqual({
      day: 3,
      week: 3,
      month: 3,
      engagedDay: 2,
      engagedWeek: 2,
      engagedMonth: 2,
    });
    expect(body.platforms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ surface: "desktop", platform: "darwin", installations: 1 }),
        expect.objectContaining({
          surface: "desktop",
          platform: "win32",
          installations: 1,
          failedRequests: 1,
        }),
        expect.objectContaining({
          surface: "ios",
          platform: "ios",
          installations: 1,
          failedConnections: 1,
        }),
      ]),
    );
    expect(body.commands).toEqual(
      expect.arrayContaining([
        { command: "slash:plan", events: 1, installations: 1 },
        { command: "shortcut:terminal.toggle", events: 1, installations: 1 },
      ]),
    );
    expect(body.failureReasons).toEqual(
      expect.arrayContaining([
        {
          event: "connection.connect",
          reason: "not_accepting",
          surface: "ios",
          events: 1,
          installations: 1,
        },
        {
          event: "chat.request",
          reason: "timeout",
          surface: "desktop",
          events: 1,
          installations: 1,
        },
      ]),
    );
  });

  it("discards valid and malformed legacy account identifiers without linking installations", async () => {
    const desktop = "00000000-0000-4000-8000-0000000000d1";
    const phone = "00000000-0000-4000-8000-0000000000d2";
    const before = "f".repeat(32);
    const after = "1".repeat(32);
    const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
    const event = (installId, accountHash, minutesAgo) =>
      envelope({
        id: crypto.randomUUID(),
        ts: at(minutesAgo),
        installId,
        accountHash,
        channel: "remote",
        event: "app.active",
        feature: undefined,
        durationMs: undefined,
      });
    await postEvents([
      event(desktop, before, 30),
      event(desktop, after, 10),
      event(phone, after, 5),
      event(phone, { privateIdentity: "synthetic-account" }, 1),
    ]);
    const stored = db.database.prepare("SELECT * FROM product_events").all();
    expect(stored).toHaveLength(4);
    expect(stored.every((row) => !("account_hash" in row))).toBe(true);
    expect(JSON.stringify(stored)).not.toContain("synthetic-account");
    const token = await signSession("test-session-key", Math.floor(Date.now() / 1000) + 3600);
    const body = await worker
      .fetch(
        new Request(`https://worker.invalid/api/product?from=${day}&to=${day}&channel=remote`, {
          headers: { cookie: `synara_beta_dash=${token}` },
        }),
        env,
      )
      .then((response) => response.json());
    expect(body.activeUsers).toEqual({
      day: 2,
      week: 2,
      month: 2,
      engagedDay: 0,
      engagedWeek: 0,
      engagedMonth: 0,
    });
  });

  it("accepts Remote diagnostics and filters them apart from Beta", async () => {
    const diagnostic = (flavor, installId) => ({
      v: 1,
      id: crypto.randomUUID(),
      ts: new Date(now).toISOString(),
      installId,
      appVersion: flavor === "remote" ? "1.0.6-remote.17" : "1.0.6-beta.1",
      flavor,
      platform: "darwin",
      arch: "arm64",
      event: "app.start",
      payload: { kind: "lifecycle" },
    });
    const response = await worker.fetch(
      new Request("https://worker.invalid/v1/events", {
        method: "POST",
        headers: { "content-type": "application/x-ndjson" },
        body: [
          {
            ...diagnostic("remote", "00000000-0000-4000-8000-0000000000b1"),
            event: "app.error",
            payload: {
              kind: "error",
              source: "renderer",
              message: "PrivateCustomerError: customer renewal draft",
              stack: "at customer renewal draft\n    at PrivateCustomer (secret-project.js:10:5)",
              logTail: "customer renewal draft",
              fingerprint: "12345678",
            },
          },
          diagnostic("beta", "00000000-0000-4000-8000-0000000000b2"),
          { ...diagnostic("stable", "00000000-0000-4000-8000-0000000000b3") },
        ]
          .map((event) => JSON.stringify(event))
          .join("\n"),
      }),
      env,
    );
    expect(response.status).toBeLessThan(300);
    expect(
      db.database
        .prepare("SELECT flavor, COUNT(*) AS n FROM events GROUP BY flavor ORDER BY flavor")
        .all(),
    ).toEqual([
      { flavor: "beta", n: 1 },
      { flavor: "remote", n: 1 },
    ]);
    expect(
      db.database
        .prepare("SELECT message, stack, log_tail FROM events WHERE flavor = 'remote'")
        .get(),
    ).toEqual({ message: "Error at renderer:10:5", stack: "at renderer:10:5", log_tail: null });

    const token = await signSession("test-session-key", Math.floor(Date.now() / 1000) + 3600);
    const filters = await worker.fetch(
      new Request("https://worker.invalid/api/filters", {
        headers: { cookie: `synara_beta_dash=${token}` },
      }),
      env,
    );
    expect((await filters.json()).flavors).toEqual(["beta", "remote"]);
  });

  it("preserves Remote updater reasons from the desktop queue through ingest into D1 aggregates", async () => {
    const root = mkdtempSync(join(tmpdir(), "synara-updater-reasons-"));
    try {
      const events = [];
      for (const [platform, messages] of [
        ["darwin", ["Request timed out", "Request timed out", "net::ERR_INTERNET_DISCONNECTED"]],
        [
          "win32",
          [
            "Cannot find remote.yml in the latest release artifacts (https://private/customer?token=secret)",
            "customer-secret failure",
          ],
        ],
      ]) {
        const homeDir = join(root, platform);
        const diagnostics = new BetaDiagnostics({
          homeDir,
          appVersion: "1.0.6-remote.39",
          platform,
          arch: "x64",
          env: {},
          flavor: "remote",
        });
        const initial = createInitialDesktopUpdateState(
          "1.0.6-remote.39",
          { hostArch: "x64", appArch: "x64", runningUnderArm64Translation: false },
          "remote",
        );
        for (const message of messages) {
          const checking = reduceDesktopUpdateStateOnCheckStart(
            initial,
            new Date(now).toISOString(),
          );
          diagnostics.trackUpdateStateChange(
            checking,
            reduceDesktopUpdateStateOnCheckFailure(checking, message, new Date(now).toISOString()),
          );
        }
        events.push(
          ...readFileSync(join(homeDir, "diagnostics/events.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        );
      }
      expect(events).toHaveLength(5);
      expect(events.every((event) => !("message" in event.payload))).toBe(true);
      expect(JSON.stringify(events)).not.toMatch(/private|customer|secret/);
      const response = await worker.fetch(
        new Request("https://worker.invalid/v1/events", {
          method: "POST",
          headers: { "content-type": "application/x-ndjson" },
          body: events.map((event) => JSON.stringify(event)).join("\n"),
        }),
        env,
      );
      expect(await response.json()).toEqual({ accepted: 5, received: 5 });
      expect(
        db.database
          .prepare(`
        SELECT platform, error_context AS context, reason, COUNT(*) AS n
        FROM events WHERE flavor = 'remote' AND event = 'update.error'
        GROUP BY platform, error_context, reason ORDER BY platform, reason
      `)
          .all(),
      ).toEqual([
        { platform: "darwin", context: "check", reason: "network", n: 1 },
        { platform: "darwin", context: "check", reason: "timeout", n: 2 },
        { platform: "win32", context: "check", reason: "manifest", n: 1 },
        { platform: "win32", context: "check", reason: "unknown", n: 1 },
      ]);
      expect(
        db.database
          .prepare(`
        SELECT COUNT(*) AS n FROM events
        WHERE message IS NOT NULL OR stack IS NOT NULL OR log_tail IS NOT NULL
      `)
          .get(),
      ).toEqual({ n: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stores the daily turn breakdown and reports it per lane", async () => {
    const usage = {
      v: 1,
      id: crypto.randomUUID(),
      ts: new Date(now).toISOString(),
      installId: "00000000-0000-4000-8000-0000000000c1",
      appVersion: "1.0.6-remote.17",
      flavor: "remote",
      platform: "win32",
      arch: "x64",
      event: "usage.daily",
      payload: {
        kind: "usage",
        providers: [{ provider: "claudeAgent", threads: 1, turns: 3, turnsFailed: 1 }],
        projects: 1,
        activeThreads: 1,
        turnBreakdown: [
          {
            provider: "claudeAgent",
            model: "claude-fable-5-1",
            effort: "high",
            interactionMode: "plan",
            runtimeMode: "full-access",
            origin: "user",
            outcome: "succeeded",
            turns: 2,
            durationMs: 30000,
            durationSamples: 2,
            inputTokens: 1000,
            outputTokens: 200,
            cachedInputTokens: 50,
            tokenSamples: 2,
          },
          {
            provider: "claudeAgent",
            model: "claude-fable-5-1",
            effort: "high",
            interactionMode: "plan",
            runtimeMode: "full-access",
            origin: "user",
            outcome: "failed",
            turns: 1,
          },
        ],
      },
    };
    const response = await worker.fetch(
      new Request("https://worker.invalid/v1/events", {
        method: "POST",
        headers: { "content-type": "application/x-ndjson" },
        body: JSON.stringify(usage),
      }),
      env,
    );
    expect(response.status).toBeLessThan(300);
    expect(db.database.prepare("SELECT COUNT(*) AS n FROM usage_turns").get().n).toBe(2);

    const token = await signSession("test-session-key", Math.floor(Date.now() / 1000) + 3600);
    const read = (flavor) =>
      worker
        .fetch(
          new Request(
            `https://worker.invalid/api/usage?days=7&flavor=${flavor}&version=1.0.6-remote.17&platform=win32`,
            {
              headers: { cookie: `synara_beta_dash=${token}` },
            },
          ),
          env,
        )
        .then((result) => result.json());
    const remote = await read("remote");
    expect(remote.turnBreakdown).toEqual([
      expect.objectContaining({
        model: "claude-fable-5-1",
        effort: "high",
        interactionMode: "plan",
        turns: 3,
        succeeded: 2,
        failed: 1,
        meanDurationMs: 15000,
        meanInputTokens: 500,
        meanOutputTokens: 100,
        installs: 1,
      }),
    ]);
    expect(remote.turns).toBe(3);
    expect((await read("beta")).turnBreakdown).toEqual([]);
  });

  it("stores only finite usage categories from handcrafted requests", async () => {
    const category = {
      provider: "claudeAgent",
      model: "claude-fable-5-1",
      effort: "high",
      interactionMode: "plan",
      runtimeMode: "full-access",
      origin: "user",
      outcome: "succeeded",
      turns: 1,
    };
    const privateValues = {
      provider: "customerProject",
      model: "claude-opus-42-7",
      effort: "privateEffort",
      interactionMode: "privateMode",
      runtimeMode: "privatePermission",
      origin: "privateOrigin",
    };
    const usage = {
      v: 1,
      id: crypto.randomUUID(),
      ts: new Date(now).toISOString(),
      installId: "00000000-0000-4000-8000-0000000000c1",
      appVersion: "1.0.6-beta.1",
      flavor: "beta",
      platform: "darwin",
      arch: "arm64",
      event: "usage.daily",
      payload: {
        kind: "usage",
        providers: [
          { provider: "codex", threads: 1, turns: 1 },
          { provider: "customerProject", threads: 1, turns: 1 },
        ],
        turnBreakdown: [
          category,
          ...Object.entries(privateValues).map(([key, value]) => ({ ...category, [key]: value })),
        ],
      },
    };
    const response = await worker.fetch(
      new Request("https://worker.invalid/v1/events", {
        method: "POST",
        headers: { "content-type": "application/x-ndjson" },
        body: JSON.stringify(usage),
      }),
      env,
    );
    expect(response.status).toBeLessThan(300);
    const turns = db.database
      .prepare(
        "SELECT provider, model, effort, interaction_mode, runtime_mode, origin FROM usage_turns",
      )
      .all();
    expect(turns).toHaveLength(7);
    for (const value of Object.values(privateValues))
      expect(JSON.stringify(turns)).not.toContain(value);
    expect(turns).toContainEqual({
      provider: "claudeAgent",
      model: "claude-fable-5-1",
      effort: "high",
      interaction_mode: "plan",
      runtime_mode: "full-access",
      origin: "user",
    });
    expect(turns).toContainEqual({
      provider: "other",
      model: "other",
      effort: "high",
      interaction_mode: "plan",
      runtime_mode: "full-access",
      origin: "user",
    });
    expect(db.database.prepare("SELECT provider FROM usage_providers").all()).toEqual([
      { provider: "codex" },
    ]);
  });

  it("rejects invented command tokens and accepts only the built-in custom bucket", async () => {
    const commands = await postEvents([
      envelope({ event: "command.used", command: "slash:privateCustomer", feature: undefined }),
      envelope({ event: "command.used", command: "shortcut:privateCustomer", feature: undefined }),
      envelope({ event: "command.used", command: "slash:custom", feature: undefined }),
    ]);
    expect(await commands.json()).toEqual({ accepted: 1, received: 3 });
    expect(db.database.prepare("SELECT command FROM product_events").all()).toEqual([
      { command: "slash:custom" },
    ]);
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

  it("sweeps raw usage after 90 days and product after 30 without deleting general diagnostics", async () => {
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

    const usageCutoff = new Date(now - 90 * 86_400_000).toISOString();
    const expiredUsage = new Date(now - 91 * 86_400_000).toISOString();
    for (const [eventId, receivedAt] of [
      [1, expiredUsage],
      [2, usageCutoff],
      [3, oldReceived],
    ]) {
      db.database
        .prepare(`INSERT INTO usage_providers
        (event_id, install_id, day, app_version, provider, received_at)
        VALUES (?, 'synthetic-install', ?, '1.2.3', 'codex', ?)`)
        .run(eventId, receivedAt.slice(0, 10), receivedAt);
      db.database
        .prepare(`INSERT INTO usage_turns
        (event_id, install_id, day, app_version, provider, model, effort, interaction_mode, runtime_mode, origin, outcome, received_at)
        VALUES (?, 'synthetic-install', ?, '1.2.3', 'codex', 'other', 'default', 'default', 'full-access', 'user', 'succeeded', ?)`)
        .run(eventId, receivedAt.slice(0, 10), receivedAt);
    }
    await worker.scheduled({ scheduledTime: now }, env, {});

    expect(
      db.database.prepare("SELECT event_id FROM usage_providers ORDER BY event_id").all(),
    ).toEqual([{ event_id: 2 }, { event_id: 3 }]);
    expect(db.database.prepare("SELECT event_id FROM usage_turns ORDER BY event_id").all()).toEqual(
      [{ event_id: 2 }, { event_id: 3 }],
    );
    expect(db.database.prepare("SELECT COUNT(*) AS n FROM product_events").get().n).toBe(1);
    expect(db.database.prepare("SELECT COUNT(*) AS n FROM events").get().n).toBe(1);
  });
  it("validates stage windows, atomically deduplicates cohorts and repairs an older receiver's plain row", async () => {
    const entry = envelope({
      event: "app.active",
      feature: undefined,
      durationMs: undefined,
      cohortDay: day,
      cohortStage: "new",
    });
    const bad = [
      { ...entry, id: crypto.randomUUID(), cohortStage: "private-team" },
      { ...entry, id: crypto.randomUUID(), cohortDay: "2026-02-30" },
      { ...entry, id: crypto.randomUUID(), cohortStage: "week1" },
      { ...entry, id: crypto.randomUUID(), cohortDay: undefined },
      { ...entry, id: crypto.randomUUID(), event: "feature.used", feature: "settings" },
    ];
    expect(await (await postEvents(bad)).json()).toMatchObject({ accepted: 0 });
    const { cohortDay: _cohortDay, cohortStage: _cohortStage, ...plain } = entry;
    await postEvents([plain]); // Matches a rollout rollback: the raw UUID exists without metadata.
    const upgraded = await postEvents([entry]);
    expect(upgraded.headers.get("x-synara-product-cohorts")).toBe("1");
    expect(await upgraded.json()).toMatchObject({ accepted: 1, cohortAcknowledged: [entry.id] });
    expect(
      await (await postEvents([entry, entry, { ...entry, id: crypto.randomUUID() }])).json(),
    ).toMatchObject({ accepted: 0 });
    expect(
      db.database
        .prepare("SELECT entries, week1_returns, month1_returns FROM product_cohorts")
        .get(),
    ).toEqual({ entries: 1, week1_returns: 0, month1_returns: 0 });
    expect(
      db.database
        .prepare("PRAGMA table_info(product_cohorts)")
        .all()
        .map((row) => row.name),
    ).not.toEqual(expect.arrayContaining(["install_id", "event_id"]));

    db.database.exec(
      "CREATE TRIGGER synthetic_cohort_failure BEFORE INSERT ON product_cohorts WHEN NEW.channel = 'beta' BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END;",
    );
    await expect(
      postEvents([
        { ...entry, id: crypto.randomUUID(), installId: crypto.randomUUID() },
        { ...entry, id: crypto.randomUUID(), channel: "beta" },
      ]),
    ).rejects.toThrow("synthetic storage failure");
    expect(db.database.prepare("SELECT entries FROM product_cohorts").get().entries).toBe(1);
    expect(db.database.prepare("SELECT COUNT(*) AS n FROM product_events").get().n).toBe(1);
  });

  it("keeps only aggregate 90-day history and excludes immature cohorts until upload grace ends", async () => {
    vi.useFakeTimers();
    const origin = Date.parse("2026-07-01T12:00:00.000Z");
    const setDay = (offset) => {
      now = origin + offset * 86400000;
      vi.setSystemTime(now);
    };
    setDay(0);
    const specs = [
      { installId: crypto.randomUUID(), channel: "remote", surface: "desktop" },
      { installId: crypto.randomUUID(), channel: "stable", surface: "desktop" },
      { installId: crypto.randomUUID(), channel: "remote", surface: "ios", platform: "ios" },
    ];
    const stage = (spec, cohortStage) =>
      envelope({
        ...spec,
        event: "app.active",
        feature: undefined,
        durationMs: undefined,
        cohortDay: "2026-07-01",
        cohortStage,
      });
    await postEvents(specs.map((spec) => stage(spec, "new")));
    setDay(7);
    const returns = [stage(specs[0], "week1")];
    await postEvents(returns);
    await postEvents(returns);
    setDay(13);
    const lateReturn = stage(specs[2], "week1");
    setDay(20);
    await postEvents([lateReturn]);
    const outsideWindow = {
      ...lateReturn,
      id: crypto.randomUUID(),
      ts: new Date(origin + 14 * 86400000).toISOString(),
    };
    expect(await (await postEvents([outsideWindow])).json()).toMatchObject({ accepted: 0 });
    setDay(30);
    await postEvents([stage(specs[0], "month1")]);
    setDay(31);
    await worker.scheduled({ scheduledTime: now }, env);
    expect(
      db.database
        .prepare("SELECT COUNT(*) AS n FROM product_events WHERE cohort_stage = 'new'")
        .get().n,
    ).toBe(0);
    const query = async (scope = "") => {
      const token = await signSession("test-session-key", Math.floor(Date.now() / 1000) + 3600);
      return (
        await worker.fetch(
          new Request(`https://worker.invalid/api/product?${scope}`, {
            headers: { cookie: `synara_beta_dash=${token}` },
          }),
          env,
        )
      ).json();
    };
    setDay(43);
    const pending = (await query()).cohorts;
    expect(pending.week1).toEqual({ entries: 3, returned: 2, ratePct: 66.7 });
    expect(pending.month1).toEqual({ entries: 0, returned: 0, ratePct: null });
    setDay(44);
    const mature = (await query()).cohorts;
    expect(mature.newReportingInstallations).toBe(3);
    expect(mature.month1).toEqual({ entries: 3, returned: 1, ratePct: 33.3 });
    expect((await query("channel=remote&surface=desktop")).cohorts.month1).toEqual({
      entries: 1,
      returned: 1,
      ratePct: 100,
    });
    expect((await query("surface=ios")).cohorts.month1).toEqual({
      entries: 1,
      returned: 0,
      ratePct: 0,
    });
    setDay(91);
    await worker.scheduled({ scheduledTime: now }, env);
    expect(db.database.prepare("SELECT COUNT(*) AS n FROM product_cohorts").get().n).toBe(0);
    expect(db.database.prepare("SELECT COUNT(*) AS n FROM product_events").get().n).toBe(0);
  });
  it("acknowledges only persisted matching cohort tuples and valid retries", async () => {
    const entry = () =>
      envelope({
        event: "app.active",
        feature: undefined,
        durationMs: undefined,
        cohortDay: day,
        cohortStage: "new",
      });
    for (const mismatch of [
      { installId: crypto.randomUUID() },
      { ts: new Date(now - 60_000).toISOString() },
      { channel: "beta" },
      { surface: "ios", platform: "ios" },
      { event: "app.open" },
      { outcome: "failed" },
    ]) {
      const candidate = entry();
      const { cohortDay: _cohortDay, cohortStage: _cohortStage, ...plain } = candidate;
      expect(await (await postEvents([{ ...plain, ...mismatch }])).json()).toMatchObject({
        accepted: 1,
      });
      expect(await (await postEvents([candidate])).json()).toMatchObject({
        accepted: 0,
        cohortAcknowledged: [],
      });
    }
    // Losing only cohort state can reconstruct the same stage UUID later that day.
    const counted = entry();
    expect(await (await postEvents([counted])).json()).toMatchObject({
      accepted: 1,
      cohortAcknowledged: [counted.id],
    });
    expect(
      await (await postEvents([{ ...counted, ts: new Date(now + 60_000).toISOString() }])).json(),
    ).toMatchObject({ accepted: 0, cohortAcknowledged: [counted.id] });
    expect(
      db.database.prepare("SELECT SUM(entries) AS entries FROM product_cohorts").get(),
    ).toEqual({
      entries: 1,
    });
    vi.useFakeTimers();
    now = Date.parse("2026-07-08T12:00:00.000Z");
    vi.setSystemTime(now);
    for (const existingDay of ["2026-06-30", "2026-07-01"]) {
      const stored = envelope({
        event: "app.active",
        feature: undefined,
        durationMs: undefined,
        cohortDay: existingDay,
        cohortStage: "week1",
      });
      expect(await (await postEvents([stored])).json()).toMatchObject({
        accepted: 1,
        cohortAcknowledged: [stored.id],
      });
      const changedDay = {
        ...stored,
        cohortDay: existingDay === "2026-06-30" ? "2026-07-01" : "2026-06-30",
      };
      expect(await (await postEvents([changedDay])).json()).toMatchObject({
        accepted: 0,
        cohortAcknowledged: [],
      });
      const candidate = { ...stored, cohortDay: "2026-07-08", cohortStage: "new" };
      expect(await (await postEvents([candidate])).json()).toMatchObject({
        accepted: 0,
        cohortAcknowledged: [],
      });
      expect(await (await postEvents([stored])).json()).toMatchObject({
        accepted: 0,
        cohortAcknowledged: [stored.id],
      });
    }
  });

  it("accepts the exact shared native cohort wire fixture at each event's clock", async () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "../../packages/contracts/fixtures/product-analytics/cohort-v1.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    vi.useFakeTimers();
    for (const event of fixture.events) {
      vi.setSystemTime(new Date(event.ts));
      expect(await (await postEvents([event])).json()).toMatchObject({
        accepted: 1,
        cohortAcknowledged: [event.id],
      });
      expect(await (await postEvents([event])).json()).toMatchObject({
        accepted: 0,
        cohortAcknowledged: [event.id],
      });
      expect(
        db.database
          .prepare(`SELECT event_id AS id, ts, install_id AS installId, channel, surface, platform,
        app_version AS appVersion, event, outcome, cohort_day AS cohortDay, cohort_stage AS cohortStage
        FROM product_events WHERE event_id = ?`)
          .get(event.id),
      ).toEqual((({ v: _v, ...stored }) => stored)(event));
    }
  });
});

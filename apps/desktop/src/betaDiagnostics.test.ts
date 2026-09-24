// FILE: betaDiagnostics.test.ts
// Purpose: Queue, sanitize, and flush behavior for beta-only diagnostics.

import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  BetaDiagnostics,
  readLogTail,
  resolveBetaDiagnosticsEndpoint,
  sanitizeBetaDiagnosticsPayload,
  BETA_DIAGNOSTICS_ENDPOINT,
} from "./betaDiagnostics";

const roots: string[] = [];
const servers: Server[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "synara-beta-diag-test-"));
  roots.push(root);
  return root;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

afterEach(async () => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
  while (servers.length > 0) {
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
  }
});

const makeDiagnostics = (root: string, endpoint?: string) =>
  new BetaDiagnostics({
    homeDir: root,
    appVersion: "9.9.9-beta.1",
    platform: "linux",
    arch: "x64",
    env: endpoint ? { SYNARA_BETA_DIAGNOSTICS_URL: endpoint } : {},
  });

describe("sanitizeBetaDiagnosticsPayload", () => {
  it("drops non-allowlisted fields", () => {
    const sanitized = sanitizeBetaDiagnosticsPayload({
      kind: "update",
      outcome: "error",
      errorContext: "download",
      targetVersion: "1.2.3-beta.4",
      // @ts-expect-error deliberately smuggling a forbidden field
      promptText: "secret prompt",
      path: "/home/user/project",
    });
    expect(JSON.stringify(sanitized)).not.toContain("secret prompt");
    expect(JSON.stringify(sanitized)).not.toContain("/home/user");
    expect(sanitized).toEqual({
      kind: "update",
      outcome: "error",
      errorContext: "download",
      targetVersion: "1.2.3-beta.4",
    });
  });

  it("rejects malformed version strings", () => {
    const sanitized = sanitizeBetaDiagnosticsPayload({
      kind: "update",
      outcome: "ok",
      targetVersion: "../../etc/passwd",
    });
    expect("targetVersion" in sanitized).toBe(false);
  });

  it("redacts free text in error payloads", () => {
    const sanitized = sanitizeBetaDiagnosticsPayload(
      {
        kind: "error",
        source: "renderer",
        message: "failed for user@example.com at /Users/alice/app",
        stack: "Error: token ghp_0123456789abcdefABCDEF1234\n    at x (f.ts:1:1)",
        fingerprint: "abcdef0123456789",
      },
      "/Users/alice",
    );
    expect(sanitized).toEqual({
      kind: "error",
      source: "renderer",
      message: "failed for <email> at ~/…/app",
      stack: expect.stringContaining("[redacted]"),
      fingerprint: "abcdef0123456789",
    });
    expect(JSON.stringify(sanitized)).not.toContain("ghp_");
    expect(JSON.stringify(sanitized)).not.toContain("alice");
  });

  it("sanitizes usage payloads: providers, counts, duplicates", () => {
    const sanitized = sanitizeBetaDiagnosticsPayload(
      {
        kind: "usage",
        providers: [
          { provider: "claudeAgent", threads: 3.7, turns: 9.9, turnsFailed: 1 },
          // Legacy name migrates to the current ProviderKind and merges.
          { provider: "gemini" as never, threads: 2, turns: 4, turnsFailed: 0 },
          { provider: "antigravity", threads: 1, turns: 5, turnsFailed: 2 },
          { provider: "notaprovider" as never, threads: 9, turns: 9, turnsFailed: 9 },
          { provider: "claudeAgent", threads: 1, turns: Number.NaN, turnsFailed: -3 },
        ],
        projects: 4.6,
        activeThreads: -2,
      },
      "/tmp/x",
      "usage.daily",
    );
    expect(sanitized).toEqual({
      kind: "usage",
      providers: [
        { provider: "claudeAgent", threads: 4, turns: 9, turnsFailed: 1 },
        { provider: "antigravity", threads: 3, turns: 9, turnsFailed: 2 },
      ],
      projects: 4,
      activeThreads: 0,
    });
  });

  it("clamps usage counts and drops extra fields", () => {
    const sanitized = sanitizeBetaDiagnosticsPayload(
      {
        kind: "usage",
        providers: [
          {
            provider: "codex",
            threads: 200_000,
            turns: 1,
            turnsFailed: 0,
            // @ts-expect-error smuggled field
            note: "user@example.com",
          },
        ],
        projects: 1e9,
        activeThreads: 1,
      },
      "/tmp/x",
      "usage.daily",
    );
    expect(JSON.stringify(sanitized)).not.toContain("user@example.com");
    expect(sanitized).toEqual({
      kind: "usage",
      providers: [{ provider: "codex", threads: 100_000, turns: 1, turnsFailed: 0 }],
      projects: 100_000,
      activeThreads: 1,
    });
  });

  it("validates beta outcomes per event", () => {
    const installed = sanitizeBetaDiagnosticsPayload(
      { kind: "beta", outcome: "imported" },
      "/tmp/x",
      "beta.installed",
    );
    expect(installed).toEqual({ kind: "beta", outcome: "imported" });
    const left = sanitizeBetaDiagnosticsPayload(
      { kind: "beta", outcome: "trash" },
      "/tmp/x",
      "beta.left",
    );
    expect(left).toEqual({ kind: "beta", outcome: "trash" });
    // Outcomes are not interchangeable across the two events.
    expect(
      sanitizeBetaDiagnosticsPayload(
        { kind: "beta", outcome: "trash" },
        "/tmp/x",
        "beta.installed",
      ),
    ).toEqual({ kind: "beta" });
    expect(
      sanitizeBetaDiagnosticsPayload({ kind: "beta", outcome: "imported" }, "/tmp/x", "beta.left"),
    ).toEqual({ kind: "beta" });
    // A beta payload under a non-beta event drops the outcome entirely.
    expect(
      sanitizeBetaDiagnosticsPayload({ kind: "beta", outcome: "fresh" }, "/tmp/x", "app.start"),
    ).toEqual({ kind: "beta" });
  });

  it("keeps only major.minor osVersion and a two/three-letter locale", () => {
    const sanitized = sanitizeBetaDiagnosticsPayload(
      { kind: "lifecycle", osVersion: "15.3.1", locale: "en-US" },
      "/tmp/x",
      "app.start",
    );
    expect(sanitized).toEqual({ kind: "lifecycle", osVersion: "15.3", locale: "en" });
    const bad = sanitizeBetaDiagnosticsPayload(
      { kind: "lifecycle", osVersion: "not a version", locale: "english-US" },
      "/tmp/x",
      "app.start",
    );
    expect(bad).toEqual({ kind: "lifecycle" });
  });

  it("redacts and caps crash logTail", () => {
    const longTail = `line with password=hunter2\n${"x".repeat(40 * 1024)}`;
    const sanitized = sanitizeBetaDiagnosticsPayload(
      {
        kind: "crash",
        processType: "renderer",
        reason: "oom",
        logTail: longTail,
      },
      "/Users/alice",
    );
    const logTail = "logTail" in sanitized ? sanitized.logTail : undefined;
    expect(logTail).toBeDefined();
    expect(logTail!.length).toBeLessThanOrEqual(16 * 1024);
    expect(logTail).not.toContain("hunter2");
  });
});

describe("readLogTail", () => {
  it("returns the last lines of a log file and undefined for missing files", () => {
    const root = makeRoot();
    const logPath = join(root, "desktop-main.log");
    writeFileSync(logPath, Array.from({ length: 300 }, (_, i) => `line-${i}`).join("\n"));
    const tail = readLogTail(logPath)!;
    expect(tail).toContain("line-299");
    expect(tail).not.toContain("line-50");
    expect(readLogTail(join(root, "missing.log"))).toBeUndefined();
  });
});

describe("BetaDiagnostics error tracking", () => {
  const readQueue = (root: string) =>
    readFileSync(join(root, "diagnostics", "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

  it("records redacted app.error events with a fingerprint", () => {
    const root = makeRoot();
    const diag = new BetaDiagnostics({
      homeDir: root,
      appVersion: "9.9.9-beta.1",
      platform: "linux",
      arch: "x64",
      env: {},
    });
    diag.trackError(
      "main",
      new Error("boom in /Users/alice/.synara-beta with sk-AbCdEfGhIjKlMnOpQrStUvWx"),
    );
    const events = readQueue(root);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("app.error");
    expect(events[0].payload.kind).toBe("error");
    expect(events[0].payload.source).toBe("main");
    expect(events[0].payload.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(events[0])).not.toContain("alice");
    expect(JSON.stringify(events[0])).not.toContain("sk-");
  });

  it("throttles the same fingerprint to once per 10 minutes", () => {
    const root = makeRoot();
    let now = new Date("2026-09-23T00:00:00Z");
    const diag = new BetaDiagnostics({
      homeDir: root,
      appVersion: "9.9.9-beta.1",
      platform: "linux",
      arch: "x64",
      env: {},
      now: () => now,
    });
    // Same message and no stack: identical fingerprint.
    diag.trackError("renderer", "same failure");
    diag.trackError("renderer", "same failure");
    expect(readQueue(root)).toHaveLength(1);
    now = new Date(now.getTime() + 11 * 60 * 1000);
    diag.trackError("renderer", "same failure");
    expect(readQueue(root)).toHaveLength(2);
  });

  it("caps app.error at 30 per hour", () => {
    const root = makeRoot();
    let now = new Date("2026-09-23T00:00:00Z");
    const diag = new BetaDiagnostics({
      homeDir: root,
      appVersion: "9.9.9-beta.1",
      platform: "linux",
      arch: "x64",
      env: {},
      now: () => now,
    });
    for (let i = 0; i < 40; i += 1) {
      // Distinct messages so the per-fingerprint throttle does not apply.
      diag.trackError("main", new Error(`failure-${i}`));
      now = new Date(now.getTime() + 1000);
    }
    expect(readQueue(root)).toHaveLength(30);
  });
});

describe("BetaDiagnostics", () => {
  it("queues allowlisted events with a stable install id", () => {
    const root = makeRoot();
    const diag = makeDiagnostics(root);
    diag.track("app.start", { kind: "lifecycle" });
    diag.track("update.downloaded", {
      kind: "update",
      outcome: "ok",
      targetVersion: "9.9.9-beta.2",
    });
    const queuePath = join(root, "diagnostics", "events.jsonl");
    const lines = readFileSync(queuePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      v: 1,
      event: "app.start",
      flavor: "beta",
      platform: "linux",
      appVersion: "9.9.9-beta.1",
    });
    expect(lines[0].installId).toBe(diag.installId);
    expect(lines[1].payload).toEqual({
      kind: "update",
      outcome: "ok",
      targetVersion: "9.9.9-beta.2",
    });
    // Same install id is reused across instances (persisted).
    expect(makeDiagnostics(root).installId).toBe(diag.installId);
  });

  it("flushes queued events as NDJSON and drains the queue", async () => {
    const received: string[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.url === "/v1/events") {
          received.push(...body.trim().split("\n"));
        }
        res.writeHead(200).end();
      });
    });
    servers.push(server);
    const port = await listen(server);

    const root = makeRoot();
    const diag = makeDiagnostics(root, `http://127.0.0.1:${port}`);
    diag.track("app.start", { kind: "lifecycle" });
    diag.track("app.exit", { kind: "lifecycle" });
    await diag.flush();

    const events = received.map((line) => JSON.parse(line));
    expect(events.map((e) => e.event)).toEqual(["app.start", "app.exit"]);
    const queuePath = join(root, "diagnostics", "events.jsonl");
    expect(existsSync(queuePath)).toBe(false);
  });

  it("keeps the queue when the endpoint is unreachable", async () => {
    const root = makeRoot();
    const diag = makeDiagnostics(root, "http://127.0.0.1:1");
    diag.track("app.start", { kind: "lifecycle" });
    await diag.flush();
    const queuePath = join(root, "diagnostics", "events.jsonl");
    expect(statSync(queuePath).size).toBeGreaterThan(0);
  });

  it("does not flush after dispose", async () => {
    const root = makeRoot();
    const diag = makeDiagnostics(root, "http://127.0.0.1:1");
    diag.track("app.start", { kind: "lifecycle" });
    await diag.dispose();
    diag.track("app.exit", { kind: "lifecycle" });
    const lines = readFileSync(join(root, "diagnostics", "events.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
  });

  const readQueue = (root: string) => {
    const queuePath = join(root, "diagnostics", "events.jsonl");
    if (!existsSync(queuePath)) return [];
    return readFileSync(queuePath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };

  const writeSnapshot = (root: string, generatedAt: string) => {
    const dir = join(root, "diagnostics");
    writeFileSync(
      join(dir, "usage-snapshot.json"),
      JSON.stringify({
        v: 1,
        generatedAt,
        providers: [{ provider: "claudeAgent", threads: 2, turns: 5, turnsFailed: 1 }],
        projects: 3,
        activeThreads: 2,
      }),
    );
  };

  it("reports whether the install id was created this launch", () => {
    const root = makeRoot();
    const first = makeDiagnostics(root);
    expect(first.installIdIsNew).toBe(true);
    const second = makeDiagnostics(root);
    expect(second.installIdIsNew).toBe(false);
    expect(second.installId).toBe(first.installId);
  });

  it("maybeTrackDailyUsage sends once per UTC day and records the day", () => {
    const root = makeRoot();
    const now = new Date("2026-09-24T12:00:00.000Z");
    const diag = new BetaDiagnostics({
      homeDir: root,
      appVersion: "9.9.9-beta.1",
      platform: "linux",
      arch: "x64",
      env: {},
      now: () => now,
    });
    writeSnapshot(root, new Date(now.getTime() - 60_000).toISOString());
    diag.maybeTrackDailyUsage();
    diag.maybeTrackDailyUsage();
    const events = readQueue(root).filter((e) => e.event === "usage.daily");
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({
      kind: "usage",
      providers: [{ provider: "claudeAgent", threads: 2, turns: 5, turnsFailed: 1 }],
      projects: 3,
      activeThreads: 2,
    });
    expect(readFileSync(join(root, "diagnostics", "usage-last-day"), "utf8").trim()).toBe(
      "2026-09-24",
    );
    // The next UTC day sends again (the server refreshes the snapshot file
    // every 6h, so write a fresh one).
    const nextNow = new Date("2026-09-25T00:10:00.000Z");
    writeSnapshot(root, new Date(nextNow.getTime() - 60_000).toISOString());
    const diagNext = new BetaDiagnostics({
      homeDir: root,
      appVersion: "9.9.9-beta.1",
      platform: "linux",
      arch: "x64",
      env: {},
      now: () => nextNow,
    });
    diagNext.maybeTrackDailyUsage();
    expect(readQueue(root).filter((e) => e.event === "usage.daily")).toHaveLength(2);
  });

  it("maybeTrackDailyUsage skips stale, missing, and corrupt snapshots", () => {
    const root = makeRoot();
    const now = new Date("2026-09-24T12:00:00.000Z");
    const diag = new BetaDiagnostics({
      homeDir: root,
      appVersion: "9.9.9-beta.1",
      platform: "linux",
      arch: "x64",
      env: {},
      now: () => now,
    });
    // Missing file: nothing queued.
    diag.maybeTrackDailyUsage();
    expect(readQueue(root)).toHaveLength(0);
    // Corrupt file: nothing queued.
    writeFileSync(join(root, "diagnostics", "usage-snapshot.json"), "{not json");
    diag.maybeTrackDailyUsage();
    expect(readQueue(root)).toHaveLength(0);
    // Stale (>12h old): nothing queued.
    writeSnapshot(root, new Date(now.getTime() - 13 * 60 * 60 * 1000).toISOString());
    diag.maybeTrackDailyUsage();
    expect(readQueue(root)).toHaveLength(0);
  });
});

describe("production gate", () => {
  it("main.ts constructs BetaDiagnostics only for the baked beta flavor", () => {
    const mainSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "main.ts"),
      "utf8",
    );
    const construction = mainSource.slice(
      mainSource.indexOf("const betaDiagnostics ="),
      mainSource.indexOf("const trackBetaDiagnostics"),
    );
    expect(construction).toContain('desktopFlavor === "beta"');
    expect(construction).toContain("new BetaDiagnostics(");
    expect(construction).toContain(": null");
  });
});

describe("resolveBetaDiagnosticsEndpoint", () => {
  it("uses the production default and honors a secure override", () => {
    expect(resolveBetaDiagnosticsEndpoint({})).toBe(BETA_DIAGNOSTICS_ENDPOINT);
    expect(
      resolveBetaDiagnosticsEndpoint({
        SYNARA_BETA_DIAGNOSTICS_URL: "https://staging.example.workers.dev",
      }),
    ).toBe("https://staging.example.workers.dev");
    // Loopback http targets are allowed for local worker development; other
    // plain-http overrides are ignored.
    expect(
      resolveBetaDiagnosticsEndpoint({ SYNARA_BETA_DIAGNOSTICS_URL: "http://127.0.0.1:8787" }),
    ).toBe("http://127.0.0.1:8787");
    expect(
      resolveBetaDiagnosticsEndpoint({ SYNARA_BETA_DIAGNOSTICS_URL: "http://localhost:8787" }),
    ).toBe("http://localhost:8787");
    expect(
      resolveBetaDiagnosticsEndpoint({ SYNARA_BETA_DIAGNOSTICS_URL: "http://[::1]:8787" }),
    ).toBe("http://[::1]:8787");
    expect(
      resolveBetaDiagnosticsEndpoint({
        SYNARA_BETA_DIAGNOSTICS_URL: "http://diagnostics.example.com",
      }),
    ).toBe(BETA_DIAGNOSTICS_ENDPOINT);
  });

  it("rejects loopback lookalikes and unparseable overrides", () => {
    // A prefix match would let these through; the hostname must be exact.
    for (const override of [
      "http://localhost.evil.com",
      "http://localhost@evil.com",
      "http://127.0.0.1.evil.com",
      "http://evil.com/localhost",
      "ftp://localhost",
      "not a url",
      "localhost:8787",
    ]) {
      expect(resolveBetaDiagnosticsEndpoint({ SYNARA_BETA_DIAGNOSTICS_URL: override })).toBe(
        BETA_DIAGNOSTICS_ENDPOINT,
      );
    }
  });
});

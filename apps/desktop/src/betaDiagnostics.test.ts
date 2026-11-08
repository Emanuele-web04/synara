// FILE: betaDiagnostics.test.ts
// Purpose: Queue, sanitize, and flush behavior for beta-only diagnostics.

import { createServer, type Server } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  existsSync,
  lstatSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BackendIssueDetector } from "./backendIssueDetector";
import { DESKTOP_DIAGNOSTIC_ISSUE_PREFIX } from "@synara/contracts";

import {
  BetaDiagnostics,
  resolveBetaDiagnosticsEndpoint,
  sanitizeBetaDiagnosticsPayload,
  BETA_DIAGNOSTICS_ENDPOINT,
} from "./betaDiagnostics";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnInstallStart,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine";

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

  it("keeps technical error fields and rebuilds the content-independent fingerprint", () => {
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
      message: "Error at renderer:1:1",
      stack: "at renderer:1:1",
      fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
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

  it("drops crash log tails entirely", () => {
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
    expect(logTail).toBeUndefined();
  });
});

describe("BetaDiagnostics error tracking", () => {
  const readQueue = (root: string) =>
    (existsSync(join(root, "diagnostics", "events.jsonl"))
      ? readFileSync(join(root, "diagnostics", "events.jsonl"), "utf8")
          .trim()
          .split("\n")
      : []
    ).map((line) => JSON.parse(line));

  it("keeps only bounded, recent allowlisted actions and redacts before adding crash context", () => {
    const root = makeRoot();
    let now = new Date("2026-10-04T20:00:00Z");
    const diag = new BetaDiagnostics({
      homeDir: root,
      appVersion: "1.0.0-beta.1",
      platform: "linux",
      arch: "x64",
      now: () => now,
    });
    diag.recordActivity({
      activity: "chat.send",
      phase: "started",
      prompt: "private prompt",
      threadId: "private-thread",
    });
    diag.recordActivity({ activity: "private action name", phase: "started" });
    expect(readQueue(root)).toEqual([]);
    diag.track("app.renderer-crash", {
      kind: "crash",
      processType: "renderer",
      reason: "crashed",
      logTail:
        "-----BEGIN PRIVATE KEY-----\n" +
        "SyntheticKeyPart+/12\n".repeat(2000) +
        "-----END PRIVATE KEY-----\nexitCode=5",
    });
    const first = readQueue(root)[0].payload.logTail;
    expect(first).toBeUndefined();
    now = new Date(now.getTime() + 11 * 60_000);
    for (let i = 0; i < 30; i++) {
      diag.recordActivity({ activity: "project.import", phase: i % 2 ? "failed" : "started" });
    }
    diag.trackError("renderer", new Error("import failed"));
    const stack = readQueue(root)[1].payload.stack;
    expect(stack ?? "").not.toMatch(/chat.send|project.import|import failed/);
    now = new Date(now.getTime() + 11 * 60_000);
    diag.trackError("renderer", new Error("later failure"));
    expect(readQueue(root)[2].payload.stack ?? "").not.toContain("Beta diagnostic context");
  });

  it("samples bounded numeric memory history and stops its timer on disposal", async () => {
    vi.useFakeTimers();
    const root = makeRoot();
    let value = 1;
    const sampleMemory = vi.fn(() => ({
      mainRssMb: value++,
      rendererRssMb: 20,
      gpuRssMb: 30,
      utilityRssMb: 40,
      privateName: "never send",
    }));
    const diag = new BetaDiagnostics({
      homeDir: root,
      appVersion: "1.0.0-beta.1",
      platform: "linux",
      arch: "x64",
      sampleMemory,
    });
    try {
      diag.start();
      vi.advanceTimersByTime(90_000);
      diag.trackError("main", new Error("memory context"));
      const stack = readQueue(root)[0].payload.stack;
      expect(stack ?? "").not.toMatch(/memory MiB|never send|main=4/);
      await diag.dispose(0);
      const calls = sampleMemory.mock.calls.length;
      vi.advanceTimersByTime(90_000);
      expect(sampleMemory).toHaveBeenCalledTimes(calls);
    } finally {
      await diag.dispose(0);
      vi.useRealTimers();
    }
  });

  it.each(["check", "download", "install"] as const)(
    "reports %s failures once per attempt even when the updater keeps a retryable status",
    (context) => {
      const root = makeRoot();
      const diag = makeDiagnostics(root);
      const initial = createInitialDesktopUpdateState(
        "9.9.9-beta.1",
        { hostArch: "arm64", appArch: "arm64", runningUnderArm64Translation: false },
        "beta",
      );
      const checkedAt = "2026-09-28T00:00:00Z";
      const available = reduceDesktopUpdateStateOnUpdateAvailable(
        initial,
        "9.9.9-beta.2",
        checkedAt,
      );
      const begin =
        context === "check"
          ? (state: typeof initial) => reduceDesktopUpdateStateOnCheckStart(state, checkedAt)
          : context === "download"
            ? reduceDesktopUpdateStateOnDownloadStart
            : reduceDesktopUpdateStateOnInstallStart;
      const fail =
        context === "check"
          ? (state: typeof initial, message: string) =>
              reduceDesktopUpdateStateOnCheckFailure(state, message, checkedAt)
          : context === "download"
            ? reduceDesktopUpdateStateOnDownloadFailure
            : reduceDesktopUpdateStateOnInstallFailure;
      const previous = begin(
        context === "install"
          ? reduceDesktopUpdateStateOnDownloadComplete(available, "9.9.9-beta.2")
          : available,
      );
      const failed = fail(previous, "Updater failure for user@example.com");
      diag.trackUpdateStateChange(previous, failed);
      diag.trackUpdateStateChange(failed, { ...failed, installFailureCount: 1 });
      expect(readQueue(root)).toMatchObject([
        {
          event: "update.error",
          payload: {
            kind: "update",
            outcome: "error",
            errorContext: context,
          },
        },
      ]);
      const retry = begin(failed);
      diag.trackUpdateStateChange(failed, retry);
      diag.trackUpdateStateChange(retry, fail(retry, "Updater failure for user@example.com"));
      expect(readQueue(root).filter((event) => event.event === "update.error")).toHaveLength(2);
    },
  );

  it("preserves a renderer exception stack without accepting extra IPC fields", () => {
    const root = makeRoot();
    const diag = makeDiagnostics(root);
    diag.trackError("renderer", {
      message: "Cannot read properties of undefined (reading '_nonReactive')",
      stack: "TypeError: _nonReactive\n    at render (/Users/alice/private-project/View.tsx:12:3)",
      prompt: "private chat content",
    });
    const [event] = readQueue(root);
    expect(event.payload.message).toBe("TypeError at renderer:12:3");
    expect(event.payload.stack).toBe("at renderer:12:3");
    expect(JSON.stringify(event)).not.toMatch(/alice|private-project|private chat content/);
  });

  it.each(["http://127.0.0.1", "https://localhost", "ws://127.0.0.1", "wss://[::1]"])(
    "groups %s and external failures without retaining addresses or message-derived identity",
    (origin) => {
      const root = makeRoot();
      const diag = makeDiagnostics(root);
      for (const port of [56268, 57314]) {
        diag.trackError("renderer", `Connection to '${origin}:${port}/private-route' failed`);
      }
      expect(readQueue(root)).toHaveLength(1);
      for (const port of [8443, 9443]) {
        diag.trackError(
          "renderer",
          `Connection to '${origin.split(":")[0]}://example.com:${port}/private-route' failed`,
        );
      }
      const events = readQueue(root);
      expect(events).toHaveLength(1);
      expect(events[0].payload.message).toBe("Error");
      expect(JSON.stringify(events)).not.toContain("private-route");
    },
  );

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
      // Distinct technical frames exercise the session cap without hashing message text.
      const error = new Error(`failure-${i}`);
      error.stack = `Error: ignored\n    at task (main.js:${i + 1}:1)`;
      diag.trackError("main", error);
      now = new Date(now.getTime() + 1000);
    }
    expect(readQueue(root)).toHaveLength(30);
  });
});

describe("BetaDiagnostics", () => {
  it("keeps updater categories while dropping every failure message", () => {
    const root = makeRoot();
    const diag = makeDiagnostics(root);
    const payload = {
      kind: "update" as const,
      outcome: "error" as const,
      errorContext: "check" as const,
      message:
        "Cannot find beta-mac.yml at https://user:secret@example.com/private/feed?token=secret for user@example.com",
    };
    diag.track("update.error", payload);
    diag.track("update.check", payload);
    const events = readFileSync(join(root, "diagnostics", "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events[0].payload.message).toBeUndefined();
    expect(events[1].payload.message).toBeUndefined();
    expect(JSON.stringify(events)).not.toMatch(/secret|private\/feed|user@example/);
  });

  it("excludes clean exits while retaining an unexpected killed process", () => {
    const root = makeRoot();
    const diag = makeDiagnostics(root);
    diag.track("app.child-process-crash", {
      kind: "crash",
      processType: "GPU",
      reason: "clean-exit",
    });
    diag.track("app.renderer-crash", {
      kind: "crash",
      processType: "renderer",
      reason: "clean-exit",
    });
    diag.track("app.renderer-crash", { kind: "crash", processType: "renderer", reason: "killed" });
    const events = readFileSync(join(root, "diagnostics", "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toHaveLength(1);
    expect(events[0].payload.reason).toBe("killed");
  });

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

  it("keeps events tracked while a flush request is in flight", async () => {
    // First request is held open until the test releases it; later requests
    // answer immediately.
    const received: string[] = [];
    let firstRequest = true;
    let landed: () => void = () => {};
    let release: () => void = () => {};
    const requestLanded = new Promise<void>((resolve) => (landed = resolve));
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push(...body.trim().split("\n"));
        if (firstRequest) {
          firstRequest = false;
          release = () => res.writeHead(200).end();
          landed();
        } else {
          res.writeHead(200).end();
        }
      });
    });
    servers.push(server);
    const port = await listen(server);

    const root = makeRoot();
    const diag = makeDiagnostics(root, `http://127.0.0.1:${port}`);
    diag.track("app.start", { kind: "lifecycle" });
    const flushing = diag.flush();
    await requestLanded;
    // Tracked while the fetch is still waiting for a response.
    diag.track("app.exit", { kind: "lifecycle" });
    release();
    await flushing;

    const queuePath = join(root, "diagnostics", "events.jsonl");
    const queued = readFileSync(queuePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).event);
    expect(queued).toEqual(["app.exit"]);
    expect(received.map((line) => JSON.parse(line).event)).toEqual(["app.start"]);

    await diag.flush();
    expect(received.map((line) => JSON.parse(line).event)).toEqual(["app.start", "app.exit"]);
    expect(existsSync(queuePath)).toBe(false);
  });

  it("aborts revoked uploads and keeps a re-enabled queue independent of late receipts", async () => {
    const root = makeRoot();
    let sharing = true;
    const diagnostics = new BetaDiagnostics({
      homeDir: root,
      appVersion: "1.0.6-remote.17",
      platform: "linux",
      arch: "x64",
      env: {},
      flavor: "remote",
      isEnabled: () => sharing,
    });
    const requests: Array<{ signal: AbortSignal; resolve: (response: Response) => void }> = [];
    const fetchMock = vi.fn(
      (_url: unknown, init: RequestInit) =>
        new Promise<Response>((resolve) => {
          requests.push({ signal: init.signal as AbortSignal, resolve });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      diagnostics.track("app.start", { kind: "lifecycle" });
      const revoked = diagnostics.flush();
      expect(requests).toHaveLength(1);
      sharing = false;
      diagnostics.discardQueue();
      expect(requests[0]!.signal.aborted).toBe(true);
      sharing = true;
      diagnostics.resumeSharing();
      diagnostics.track("app.exit", { kind: "lifecycle" });
      const current = diagnostics.flush();
      expect(requests).toHaveLength(2);
      // A transport may settle after abort; it no longer owns this queue.
      requests[0]!.resolve(new Response(null, { status: 200 }));
      await revoked;
      diagnostics.track("app.start", { kind: "lifecycle" });
      await diagnostics.flush();
      expect(requests).toHaveLength(2);
      requests[1]!.resolve(new Response(null, { status: 200 }));
      await current;
      expect(readQueue(root).map((record) => record.event)).toEqual(["app.start"]);
      const final = diagnostics.flush();
      requests[2]!.resolve(new Response(null, { status: 200 }));
      await final;
      expect(readQueue(root)).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sanitizes offline legacy usage records again before sending them after restart", async () => {
    const received: string[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push(body);
        res.writeHead(200).end();
      });
    });
    servers.push(server);
    const port = await listen(server);
    const root = makeRoot();
    const diagnostics = makeDiagnostics(root, `http://127.0.0.1:${port}`);
    diagnostics.track("usage.daily", {
      kind: "usage",
      providers: [],
      projects: 1,
      activeThreads: 1,
    });
    const queuePath = join(root, "diagnostics", "events.jsonl");
    const legacy = JSON.parse(readFileSync(queuePath, "utf8"));
    legacy.privateEnvelope = "privateCustomer";
    legacy.payload.providers = [{ provider: "privateProvider", threads: 1, turns: 1 }];
    legacy.payload.turnBreakdown = [
      {
        provider: "claudeAgent",
        model: "claude-opus-42-7",
        effort: "privateEffort",
        interactionMode: "plan",
        runtimeMode: "full-access",
        origin: "user",
        outcome: "succeeded",
        turns: 1,
      },
    ];
    writeFileSync(queuePath, `${JSON.stringify(legacy)}\n`);
    await makeDiagnostics(root, `http://127.0.0.1:${port}`).flush();
    expect(received).toHaveLength(1);
    expect(received[0]).not.toMatch(
      /privateCustomer|privateProvider|privateEffort|claude-opus-42-7/,
    );
    expect(JSON.parse(received[0]!).payload).toMatchObject({
      providers: [],
      turnBreakdown: [{ provider: "claudeAgent", model: "other", effort: "other" }],
    });
    expect(readQueue(root)).toEqual([]);
  });

  it("dispose waits for an in-flight flush, then sends what queued meanwhile", async () => {
    const received: string[] = [];
    let firstRequest = true;
    let landed: () => void = () => {};
    let release: () => void = () => {};
    const requestLanded = new Promise<void>((resolve) => (landed = resolve));
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push(...body.trim().split("\n"));
        if (firstRequest) {
          firstRequest = false;
          release = () => res.writeHead(200).end();
          landed();
        } else {
          res.writeHead(200).end();
        }
      });
    });
    servers.push(server);
    const port = await listen(server);

    const root = makeRoot();
    const diag = makeDiagnostics(root, `http://127.0.0.1:${port}`);
    diag.track("app.start", { kind: "lifecycle" });
    const flushing = diag.flush();
    await requestLanded;
    diag.track("beta.left", { kind: "beta", outcome: "trash" });
    const disposing = diag.dispose(5_000);
    release();
    await Promise.all([flushing, disposing]);

    expect(received.map((line) => JSON.parse(line).event)).toEqual(["app.start", "beta.left"]);
    expect(existsSync(join(root, "diagnostics", "events.jsonl"))).toBe(false);
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

  it("marks a new install pending until the marker is cleared", () => {
    const root = makeRoot();
    const pendingPath = join(root, "diagnostics", "install-pending");
    const first = makeDiagnostics(root);
    expect(first.hasInstallPending()).toBe(true);
    // Relaunches keep the marker until the event is queued and cleared.
    const second = makeDiagnostics(root);
    expect(second.hasInstallPending()).toBe(true);
    expect(second.installId).toBe(first.installId);
    second.clearInstallPending();
    expect(existsSync(pendingPath)).toBe(false);
    expect(makeDiagnostics(root).hasInstallPending()).toBe(false);
  });

  it("drops a beta event whose outcome is invalid for the event name", () => {
    const root = makeRoot();
    const diag = makeDiagnostics(root);
    diag.track("beta.installed", { kind: "beta", outcome: "trash" });
    diag.track("beta.left", { kind: "beta", outcome: "fresh" });
    diag.track("beta.installed", { kind: "beta", outcome: "imported" });
    const events = readQueue(root);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ kind: "beta", outcome: "imported" });
  });

  it("dispose relays a fresh snapshot so short sessions still report", async () => {
    const root = makeRoot();
    const diag = makeDiagnostics(root, "http://127.0.0.1:1");
    writeSnapshot(root, new Date().toISOString());
    await diag.dispose();
    expect(readQueue(root).filter((event) => event.event === "usage.daily")).toHaveLength(1);
  });

  it("relays the turn breakdown with categories only", () => {
    const root = makeRoot();
    const now = new Date("2026-10-17T12:00:00.000Z");
    const diag = new BetaDiagnostics({
      homeDir: root,
      appVersion: "1.0.6-remote.17",
      platform: "darwin",
      arch: "arm64",
      env: {},
      now: () => now,
      flavor: "remote",
    });
    const row = {
      provider: "claudeAgent",
      model: "claude-fable-5-1",
      effort: "high",
      interactionMode: "plan",
      runtimeMode: "full-access",
      origin: "user",
      outcome: "succeeded",
      turns: 2,
      durationMs: 1000,
      durationSamples: 2,
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 1,
      tokenSamples: 2,
    };
    writeFileSync(
      join(root, "diagnostics", "usage-snapshot.json"),
      JSON.stringify({
        v: 1,
        generatedAt: new Date(now.getTime() - 60_000).toISOString(),
        providers: [],
        projects: 0,
        activeThreads: 0,
        turnBreakdown: [
          row,
          { ...row, model: "a model with spaces" },
          {
            ...row,
            provider: "privateClient",
            model: "claude-opus-42-7",
            effort: "privateEffort",
            interactionMode: "privateMode",
            runtimeMode: "privatePermission",
            origin: "privateOrigin",
          },
          { ...row, outcome: "running" },
          { ...row, secret: "dropped" },
        ],
      }),
    );
    diag.maybeTrackDailyUsage();
    const [event] = readQueue(root).filter((e) => e.event === "usage.daily");
    expect(event.flavor).toBe("remote");
    expect(event.payload.turnBreakdown).toEqual([
      row,
      { ...row, model: "other" },
      {
        ...row,
        provider: "other",
        model: "other",
        effort: "other",
        interactionMode: "other",
        runtimeMode: "other",
        origin: "other",
      },
      row,
    ]);
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

describe("handled issue reports", () => {
  it("keeps a searchable ID through offline retry and deduplicates backend/UI reports", async () => {
    let accept = false;
    let requests = 0;
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        requests += 1;
        if (accept)
          received.push(
            ...body
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line)),
          );
        response.writeHead(accept ? 204 : 503).end();
      });
    });
    servers.push(server);
    const root = makeRoot();
    const diagnostics = makeDiagnostics(root, `http://127.0.0.1:${await listen(server)}`);
    const id = diagnostics.trackIssue("main", { code: "git.push.failed", reason: "timeout" });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await vi.waitFor(() => expect(diagnostics.getReportStatus(id)).toBe("queued"));
    await vi.waitFor(() => expect(requests).toBe(1));
    expect(
      diagnostics.trackIssue("renderer", {
        code: "git.push.failed",
        reason: "timeout",
        durationMs: 1234,
      }),
    ).toBe(id);
    expect(
      readFileSync(join(root, "diagnostics/events.jsonl"), "utf8").trim().split("\n"),
    ).toHaveLength(1);
    accept = true;
    await vi.waitFor(async () => {
      await diagnostics.flush();
      expect(diagnostics.getReportStatus(id)).toBe("sent");
    });
    expect(received).toEqual([
      expect.objectContaining({
        id,
        event: "app.error",
        payload: expect.objectContaining({ message: "Handled issue: git.push.failed (timeout)" }),
      }),
    ]);
    expect(existsSync(join(root, "diagnostics/events.jsonl"))).toBe(false);
    await diagnostics.dispose();
  });

  it("validates fragmented backend reports and never uploads arbitrary fields or oversized lines", async () => {
    const root = makeRoot();
    const diagnostics = makeDiagnostics(root, "http://127.0.0.1:1");
    const detector = new BackendIssueDetector((issue) => {
      diagnostics.trackIssue("main", issue);
    });
    const line =
      DESKTOP_DIAGNOSTIC_ISSUE_PREFIX +
      JSON.stringify({
        code: "claude.cache.uncertain",
        reason: "timeout",
        durationMs: 120000,
        prompt: "private chat text",
        path: "/Users/person/private",
        token: "private credentials",
      }) +
      "\n";
    detector.push(Buffer.from(line.slice(0, 12)), "stdout");
    detector.push(Buffer.from("ordinary error\n"), "stderr");
    detector.push(Buffer.from(line.slice(12)), "stdout");
    detector.push(Buffer.from(DESKTOP_DIAGNOSTIC_ISSUE_PREFIX + "x".repeat(4096) + line), "stdout");
    detector.push(
      Buffer.from(DESKTOP_DIAGNOSTIC_ISSUE_PREFIX + '{"code":"private payload"}\n'),
      "stdout",
    );
    expect(
      diagnostics.trackIssue("renderer", { code: "voice.transcribe.failed", durationMs: Infinity }),
    ).toBeNull();
    expect(
      diagnostics.trackIssue("renderer", {
        code: "voice.transcribe.failed",
        reason: "private text",
      }),
    ).toBeNull();
    const queued = readFileSync(join(root, "diagnostics/events.jsonl"), "utf8");
    expect(queued.trim().split("\n")).toHaveLength(1);
    expect(queued).not.toMatch(/private|credentials|person/);
    expect(JSON.parse(queued).payload).toMatchObject({
      message: "Handled issue: claude.cache.uncertain (timeout)",
      stack: "durationMs=120000",
    });
    await diagnostics.dispose();
  });

  it("offers an ID after a transient queue write failure without consuming its rate limit", async () => {
    const root = makeRoot();
    const diagnostics = makeDiagnostics(root, "http://127.0.0.1:1");
    rmSync(join(root, "diagnostics"), { recursive: true });
    writeFileSync(join(root, "diagnostics"), "not a directory");
    expect(
      diagnostics.trackIssue("main", { code: "startup.database-locked", reason: "unknown-owner" }),
    ).toBeNull();
    expect(diagnostics.getReportStatus("made-up-id")).toBe("unavailable");
    rmSync(join(root, "diagnostics"));
    const id = diagnostics.trackIssue("main", {
      code: "startup.database-locked",
      reason: "unknown-owner",
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(diagnostics.getReportStatus(id)).toBe("queued");
    expect(JSON.parse(readFileSync(join(root, "diagnostics/events.jsonl"), "utf8")).id).toBe(id);
    await diagnostics.dispose();
  });
});

it("passes stall reports through the shared issue allowlist and redaction pipeline", async () => {
  const root = makeRoot();
  const diagnostics = makeDiagnostics(root, "http://127.0.0.1:1");
  const id = diagnostics.trackIssue("main", {
    code: "server.event-loop.stall",
    durationMs: 5200,
    prompt: "private text",
    stack: "/Users/person/private",
  });
  expect(id).not.toBeNull();
  const queued = readFileSync(join(root, "diagnostics/events.jsonl"), "utf8");
  expect(JSON.parse(queued).payload).toMatchObject({
    message: "Handled issue: server.event-loop.stall (unknown)",
    stack: "durationMs=5200",
  });
  expect(queued).not.toMatch(/private|person/);
  await diagnostics.dispose();
});

describe("Remote diagnostics", () => {
  it("labels events as Remote and collects nothing while sharing is off", () => {
    const root = makeRoot();
    let sharing = true;
    const diagnostics = new BetaDiagnostics({
      homeDir: root,
      appVersion: "1.0.6-remote.17",
      platform: "linux",
      arch: "x64",
      flavor: "remote",
      isEnabled: () => sharing,
    });
    const queuePath = join(root, "diagnostics", "events.jsonl");
    diagnostics.track("app.start", { kind: "lifecycle" });
    expect(JSON.parse(readFileSync(queuePath, "utf8").trim())).toMatchObject({
      flavor: "remote",
      event: "app.start",
    });

    sharing = false;
    diagnostics.discardQueue();
    expect(diagnostics.isCollecting()).toBe(false);
    diagnostics.track("app.start", { kind: "lifecycle" });
    diagnostics.trackError("main", new Error("boom"));
    expect(existsSync(queuePath)).toBe(false);
    // A saved off choice must discard a queue left by a previous interrupted process.
    writeFileSync(queuePath, "old queued diagnostics\n");
    const restoredOff = new BetaDiagnostics({
      homeDir: root,
      appVersion: "1.0.6-remote.18",
      platform: "linux",
      arch: "x64",
      flavor: "remote",
      isEnabled: () => false,
    });
    expect(restoredOff.isCollecting()).toBe(false);
    expect(existsSync(queuePath)).toBe(false);
  });
});

describe("Remote keeps free text on the device", () => {
  const remote = (root: string, isEnabled: () => boolean = () => true) =>
    new BetaDiagnostics({
      homeDir: root,
      appVersion: "1.0.6-remote.17",
      platform: "darwin",
      arch: "arm64",
      env: {},
      flavor: "remote",
      isEnabled,
    });
  const queued = (root: string) => {
    const path = join(root, "diagnostics", "events.jsonl");
    return existsSync(path)
      ? readFileSync(path, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  };

  it("sends an error's type and frames, never its message, and no crash log", () => {
    const root = makeRoot();
    const diagnostics = remote(root);
    const error = new TypeError(
      "Failed to read /Volumes/Work/AcmeSecret/strategy.txt: customer renewal draft\n    at customer renewal draft",
    );
    error.stack = `TypeError: ${error.message}\n    at readPlan (main.js:10:5)\n    at run (main.js:20:3)`;
    diagnostics.trackError("main", error);
    diagnostics.track("app.child-process-crash", {
      kind: "crash",
      processType: "backend",
      reason: "crashed",
      logTail: "customer renewal draft",
    });
    diagnostics.trackIssue("main", { code: "git.push.failed", reason: "timeout", durationMs: 120 });
    diagnostics.trackError("main", "Handled issue: private-customer-secret (private_reason)");
    const named = new Error("PrivateCustomer");
    named.stack = "PrivateCustomerError: hidden\n    at PrivateCustomer (main.js:30:7)";
    diagnostics.trackError("main", named);
    const raw = readFileSync(join(root, "diagnostics", "events.jsonl"), "utf8");
    expect(raw).not.toContain("AcmeSecret");
    expect(raw).not.toContain("renewal");
    expect(raw).not.toMatch(/private-customer|private_reason|PrivateCustomer/);
    const [errorEvent, crashEvent, issueEvent] = queued(root);
    expect(errorEvent.payload).toMatchObject({
      message: "TypeError at main:10:5",
      stack: "at main:10:5\nat main:20:3",
    });
    expect(crashEvent.payload.logTail).toBeUndefined();
    expect(issueEvent.payload.message).toBe("Handled issue: git.push.failed (timeout)");
  });

  it("keeps a fixed updater reason while stripping the failure message", () => {
    const root = makeRoot();
    const diagnostics = remote(root);
    const initial = createInitialDesktopUpdateState(
      "1.0.6-remote.39",
      { hostArch: "arm64", appArch: "arm64", runningUnderArm64Translation: false },
      "remote",
    );
    const checking = reduceDesktopUpdateStateOnCheckStart(initial, new Date().toISOString());
    diagnostics.trackUpdateStateChange(
      checking,
      reduceDesktopUpdateStateOnCheckFailure(
        checking,
        "Cannot find remote-mac.yml in the latest release artifacts (https://private/customer?token=secret)",
        new Date().toISOString(),
      ),
    );
    diagnostics.track("update.error", {
      kind: "update",
      outcome: "error",
      // @ts-expect-error Untrusted categories must be rejected before queueing.
      reason: "private-customer",
      message: "private customer message",
    });
    diagnostics.track("update.check", { kind: "update", outcome: "ok", reason: "timeout" });
    const events = queued(root);
    expect(events[0].payload).toEqual({
      kind: "update",
      outcome: "error",
      errorContext: "check",
      reason: "manifest",
    });
    expect(events[1].payload.reason).toBeUndefined();
    expect(events[2].payload.reason).toBeUndefined();
    expect(JSON.stringify(events)).not.toMatch(/private|customer|secret|message|stack|logTail/);
  });

  it("collects no context while sharing is off and skips snapshots reaching into that time", () => {
    const root = makeRoot();
    let sharing = false;
    const diagnostics = remote(root, () => sharing);
    diagnostics.recordActivity({ activity: "git.push", phase: "started" });
    sharing = true;
    diagnostics.resumeSharing();
    writeFileSync(
      join(root, "diagnostics", "usage-snapshot.json"),
      JSON.stringify({
        v: 1,
        generatedAt: new Date().toISOString(),
        providers: [],
        projects: 0,
        activeThreads: 0,
      }),
    );
    diagnostics.maybeTrackDailyUsage();
    diagnostics.trackError("main", new Error("boom"));
    const events = queued(root);
    expect(events.some((event) => event.event === "usage.daily")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("git.push");
  });
});

it("clears only regular diagnostic staging files across startup, revocation and flush", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 204 })),
  );
  try {
    for (const phase of [
      "constructor-on",
      "constructor-off",
      "start",
      "opt-out",
      "flush",
    ] as const) {
      const root = makeRoot();
      const dir = join(root, "diagnostics");
      mkdirSync(dir, { recursive: true });
      let sharing = phase !== "constructor-off";
      const make = () =>
        new BetaDiagnostics({
          homeDir: root,
          appVersion: "1.0.6-remote.18",
          platform: "linux",
          arch: "x64",
          flavor: "remote",
          isEnabled: () => sharing,
          env: {},
        });
      const owned = [
        `events.jsonl.trim-${process.pid + 1}`,
        `events.jsonl.flush-${process.pid + 2}`,
        `events.jsonl.sanitize-${process.pid + 3}`,
      ];
      const unrelated = [
        "notes.txt",
        "events.jsonl.trim-0",
        "events.jsonl.flush-01",
        "events.jsonl.sanitize-user",
        "other.jsonl.trim-4321",
      ];
      const links = ["trim", "flush", "sanitize"].map(
        (kind) => `events.jsonl.${kind}-${process.pid}`,
      );
      const target = join(root, "preserved-target.txt");
      const seed = () => {
        for (const name of owned)
          writeFileSync(join(dir, name), "private customer prompt from interrupted write");
        for (const name of unrelated) writeFileSync(join(dir, name), "preserve unrelated file");
        mkdirSync(join(dir, `events.jsonl.trim-${process.pid + 4}`));
        writeFileSync(target, "preserve private link target");
        for (const name of links) symlinkSync(target, join(dir, name));
      };
      let diagnostics: BetaDiagnostics;
      if (phase.startsWith("constructor")) {
        seed();
        if (!sharing) writeFileSync(join(dir, "events.jsonl"), "private queued content");
        diagnostics = make();
      } else {
        diagnostics = make();
        if (phase === "flush") diagnostics.track("app.start", { kind: "lifecycle" });
        seed();
        if (phase === "start") diagnostics.start();
        else if (phase === "opt-out") {
          sharing = false;
          diagnostics.discardQueue();
        } else await diagnostics.flush();
      }
      try {
        for (const name of owned)
          expect(existsSync(join(dir, name)), `${phase}: ${name}`).toBe(false);
        for (const name of unrelated)
          expect(readFileSync(join(dir, name), "utf8")).toBe("preserve unrelated file");
        expect(lstatSync(join(dir, `events.jsonl.trim-${process.pid + 4}`)).isDirectory()).toBe(
          true,
        );
        for (const name of links) expect(lstatSync(join(dir, name)).isSymbolicLink()).toBe(true);
        expect(readFileSync(target, "utf8")).toBe("preserve private link target");
        if (!sharing || phase !== "flush")
          expect(existsSync(join(dir, "events.jsonl"))).toBe(false);
      } finally {
        await diagnostics.dispose();
      }
    }
  } finally {
    vi.unstubAllGlobals();
  }
});

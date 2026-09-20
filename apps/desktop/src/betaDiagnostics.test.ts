// FILE: betaDiagnostics.test.ts
// Purpose: Queue, sanitize, and flush behavior for beta-only diagnostics.

import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  BetaDiagnostics,
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
      resolveBetaDiagnosticsEndpoint({
        SYNARA_BETA_DIAGNOSTICS_URL: "http://diagnostics.example.com",
      }),
    ).toBe(BETA_DIAGNOSTICS_ENDPOINT);
  });
});

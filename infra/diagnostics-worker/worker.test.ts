// FILE: worker.test.ts
// Purpose: Unit coverage for ingest validation, server-side redaction, and
// dashboard session auth. Runs in plain vitest (no workerd pool): the tested
// helpers are pure functions over plain inputs.

import { describe, expect, it } from "vitest";

import { normalizeEvent, signSession, verifySessionCookie } from "./worker";

const baseEvent = {
  v: 1,
  id: "11111111-2222-3333-4444-555555555555",
  ts: "2026-09-23T12:00:00.000Z",
  installId: "00000000-0000-4000-8000-000000000000",
  appVersion: "9.9.9-beta.1",
  flavor: "beta",
  platform: "darwin",
  arch: "arm64",
  event: "app.start",
  payload: { kind: "lifecycle" },
};

describe("normalizeEvent", () => {
  it("accepts a minimal #1265-era lifecycle event", () => {
    const row = normalizeEvent(baseEvent);
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      event: "app.start",
      kind: "lifecycle",
      installId: baseEvent.installId,
      appVersion: "9.9.9-beta.1",
      message: null,
      stack: null,
      logTail: null,
    });
  });

  it("accepts app.error and redacts free text server-side", () => {
    const row = normalizeEvent({
      ...baseEvent,
      event: "app.error",
      payload: {
        kind: "error",
        source: "renderer",
        message: "failed for user@example.com at /Users/alice/x",
        stack: "Error: key=sk-AbCdEfGhIjKlMnOpQrStUvWx\n    at f (a.ts:1:1)",
        fingerprint: "abcdef0123456789",
      },
    });
    expect(row).not.toBeNull();
    expect(row!.source).toBe("renderer");
    expect(row!.fingerprint).toBe("abcdef0123456789");
    expect(row!.message).toContain("<email>");
    expect(row!.message).toContain("<user>");
    expect(JSON.stringify(row)).not.toContain("user@example.com");
    expect(JSON.stringify(row)).not.toContain("sk-AbCd");
    expect(JSON.stringify(row)).not.toContain("alice");
  });

  it("accepts crash events with a redacted logTail", () => {
    const row = normalizeEvent({
      ...baseEvent,
      event: "app.child-process-crash",
      payload: {
        kind: "crash",
        processType: "backend",
        reason: "code=1",
        logTail: "dial 10.0.0.8:8080 failed, password=hunter2",
      },
    });
    expect(row!.logTail).toContain("<ip>");
    expect(row!.logTail).not.toContain("hunter2");
    expect(row!.processType).toBe("backend");
  });

  it.each([
    ["unknown event", { ...baseEvent, event: "chat.message" }],
    ["non-beta flavor", { ...baseEvent, flavor: "production" }],
    ["bad version", { ...baseEvent, appVersion: "not-semver" }],
    ["bad install id", { ...baseEvent, installId: "not-a-uuid" }],
    ["missing v", { ...baseEvent, v: 2 }],
    ["bad ts", { ...baseEvent, ts: "yesterday" }],
  ])("drops %s", (_name, event) => {
    expect(normalizeEvent(event)).toBeNull();
  });
});

describe("session cookie", () => {
  it("round-trips a signed session", async () => {
    const secret = "test-session-key";
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const token = await signSession(secret, expiresAt);
    expect(await verifySessionCookie(`synara_beta_dash=${token}`, secret)).toBe(true);
  });

  it("rejects expired, tampered, and wrong-key sessions", async () => {
    const secret = "test-session-key";
    const future = Math.floor(Date.now() / 1000) + 3600;
    const token = await signSession(secret, future);
    const [expiry] = token.split(".");
    expect(await verifySessionCookie(`synara_beta_dash=${expiry}.badbadbad`, secret)).toBe(false);
    expect(await verifySessionCookie(`synara_beta_dash=${token}`, "other-key")).toBe(false);
    const expired = await signSession(secret, Math.floor(Date.now() / 1000) - 10);
    expect(await verifySessionCookie(`synara_beta_dash=${expired}`, secret)).toBe(false);
    expect(await verifySessionCookie(null, secret)).toBe(false);
    expect(await verifySessionCookie("other=1", secret)).toBe(false);
  });
});

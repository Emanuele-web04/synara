import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeAccountConnect, type AccountConnectShape } from "./accountConnect";
import { makeAccountStorage, type AccountStorageShape } from "./accountStorage";
import type { OAuthLoginOutcome, OAuthLoginRunner } from "./oauthLogin";

const expectFailureDetail = async (
  effect: Effect.Effect<unknown, { readonly detail: string }>,
  pattern: RegExp,
) => {
  const failure = await Effect.runPromise(Effect.flip(effect));
  expect(failure.detail).toMatch(pattern);
};

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("accountConnect", () => {
  let root: string;
  let storage: AccountStorageShape;
  let connect: AccountConnectShape;
  let resolveLogin: ((outcome: OAuthLoginOutcome) => void) | null;
  let cancelled: boolean;

  const fakeOauthRunner: OAuthLoginRunner = (request) => {
    const done = new Promise<OAuthLoginOutcome>((resolve) => {
      resolveLogin = resolve;
    });
    request.onVerification({ verificationUrl: "https://example.com/device", userCode: "AB-12" });
    return {
      done,
      cancel: () => {
        cancelled = true;
      },
    };
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "synara-connect-"));
    storage = makeAccountStorage({ root });
    connect = makeAccountConnect({
      storage,
      oauthLoginRunners: { codex: fakeOauthRunner },
    });
    resolveLogin = null;
    cancelled = false;
    await Effect.runPromise(storage.ensureRoot);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects unsupported provider/surface/auth combinations", async () => {
    await expectFailureDetail(
      connect.beginConnect({ kind: "agent-oauth", provider: "cursor" }),
      /not supported/,
    );
    await expectFailureDetail(
      connect.beginConnect({ kind: "app-oauth", provider: "codex" }),
      /not supported/,
    );
  });

  it("connects an API-key account transactionally and activates the first one", async () => {
    const { operationId } = await Effect.runPromise(
      connect.beginConnect({ kind: "agent-api-key", provider: "cursor", apiKey: "key_test1234" }),
    );
    const status = await Effect.runPromise(connect.getConnectStatus(operationId));
    expect(status.state).toBe("succeeded");
    expect(status.ordinal).toBe(1);

    const record = await Effect.runPromise(storage.readAccount("cursor", 1));
    expect(record?.agent?.state).toBe("connected");
    expect(record?.agent?.authMethod).toBe("apiKey");
    await expect(Effect.runPromise(storage.readSecret("cursor", 1, "agent"))).resolves.toBe(
      "key_test1234",
    );
    await expect(Effect.runPromise(storage.readActiveOrdinal("cursor"))).resolves.toBe(1);
  });

  it("reconnects an existing API-key account in place with a new key", async () => {
    await Effect.runPromise(
      connect.beginConnect({ kind: "agent-api-key", provider: "grok", apiKey: "xai-old" }),
    );
    const before = await Effect.runPromise(storage.readAccount("grok", 1));
    const { operationId } = await Effect.runPromise(
      connect.beginConnect({
        kind: "agent-api-key",
        provider: "grok",
        ordinal: 1,
        apiKey: "xai-new",
      }),
    );
    const status = await Effect.runPromise(connect.getConnectStatus(operationId));
    expect(status.state).toBe("succeeded");
    expect(status.ordinal).toBe(1);
    const after = await Effect.runPromise(storage.readAccount("grok", 1));
    expect(after?.agent?.generation).toBe((before?.agent?.generation ?? 0) + 1);
    await expect(Effect.runPromise(storage.readSecret("grok", 1, "agent"))).resolves.toBe(
      "xai-new",
    );
  });

  it("rejects reconnecting a slot that does not exist", async () => {
    await expectFailureDetail(
      connect.beginConnect({ kind: "agent-api-key", provider: "grok", ordinal: 9, apiKey: "x" }),
      /missing account/,
    );
  });

  it("drives the OAuth lifecycle: verification info, finalize, success", async () => {
    const { operationId } = await Effect.runPromise(
      connect.beginConnect({ kind: "agent-oauth", provider: "codex" }),
    );
    const waiting = await Effect.runPromise(connect.getConnectStatus(operationId));
    expect(waiting.state).toBe("waiting-for-user");
    expect(waiting.verificationUrl).toBe("https://example.com/device");
    expect(waiting.userCode).toBe("AB-12");

    resolveLogin!({ ok: true, identityHint: "k***@example.com" });
    let status = waiting;
    await waitFor(() => {
      status = Effect.runSync(connect.getConnectStatus(operationId));
      return status.state === "succeeded";
    });
    expect(status.ordinal).toBe(1);
    const record = await Effect.runPromise(storage.readAccount("codex", 1));
    expect(record?.agent?.state).toBe("connected");
    expect(record?.identity?.hint).toBe("k***@example.com");
  });

  it("marks the operation failed when the login process fails", async () => {
    const { operationId } = await Effect.runPromise(
      connect.beginConnect({ kind: "agent-oauth", provider: "codex" }),
    );
    resolveLogin!({ ok: false, error: "login exited with code 1" });
    let status = await Effect.runPromise(connect.getConnectStatus(operationId));
    await waitFor(() => {
      status = Effect.runSync(connect.getConnectStatus(operationId));
      return status.state === "failed";
    });
    expect(status.error).toContain("login exited");
    await expect(Effect.runPromise(storage.listOrdinals("codex"))).resolves.toEqual([]);
  });

  it("cancels a waiting OAuth operation and cleans its pending directory", async () => {
    const { operationId } = await Effect.runPromise(
      connect.beginConnect({ kind: "agent-oauth", provider: "codex" }),
    );
    const status = await Effect.runPromise(connect.cancelConnect(operationId));
    expect(status.state).toBe("cancelled");
    expect(cancelled).toBe(true);
    await expect(Effect.runPromise(storage.listPendingOperations("codex"))).resolves.toEqual([]);
  });

  it("refuses to activate accounts without a connected agent binding", async () => {
    await Effect.runPromise(
      connect.beginConnect({ kind: "agent-api-key", provider: "cursor", apiKey: "key_a" }),
    );
    await Effect.runPromise(connect.disconnectBinding("cursor", 1, "agent"));
    await expectFailureDetail(connect.setActive("cursor", 1), /agent binding/);
    await expectFailureDetail(connect.setActive("cursor", 9), /missing/);
    await Effect.runPromise(connect.setActive("cursor", 0));
    await expect(Effect.runPromise(storage.readActiveOrdinal("cursor"))).resolves.toBe(0);
  });

  it("disconnects surfaces independently and deletes the agent secret", async () => {
    await Effect.runPromise(
      connect.beginConnect({ kind: "agent-api-key", provider: "cursor", apiKey: "key_b" }),
    );
    await Effect.runPromise(connect.disconnectBinding("cursor", 1, "agent"));
    const record = await Effect.runPromise(storage.readAccount("cursor", 1));
    expect(record?.agent?.state).toBe("needs-auth");
    expect(record?.agent?.generation).toBe(2);
    await expect(Effect.runPromise(storage.readSecret("cursor", 1, "agent"))).resolves.toBeNull();
  });

  it("persists non-secret operation metadata into the pending directory", async () => {
    const { operationId } = await Effect.runPromise(
      connect.beginConnect({ kind: "agent-oauth", provider: "codex" }),
    );
    const raw = await Effect.runPromise(storage.readPendingOperation("codex", operationId));
    expect(raw).not.toBeNull();
    const metadata = JSON.parse(raw!) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      operationId,
      provider: "codex",
      surface: "agent",
      authMethod: "oauth",
    });
    expect(JSON.stringify(metadata)).not.toContain("apiKey");
  });

  it("does not leak operation.json into the finalized account directory", async () => {
    const { operationId } = await Effect.runPromise(
      connect.beginConnect({ kind: "agent-oauth", provider: "codex" }),
    );
    resolveLogin!({ ok: true });
    await waitFor(
      () => Effect.runSync(connect.getConnectStatus(operationId)).state === "succeeded",
    );
    const leaked = await Effect.runPromise(
      storage.readPendingOperation("codex", operationId).pipe(Effect.orElseSucceed(() => null)),
    );
    expect(leaked).toBeNull();
    expect(existsSync(join(root, "accounts", "codex", "1", "operation.json"))).toBe(false);
  });

  it("recovers an interrupted OAuth connect as terminal after a restart", async () => {
    const { operationId } = await Effect.runPromise(
      connect.beginConnect({ kind: "agent-oauth", provider: "codex" }),
    );
    // Simulate a server restart: a fresh service over the same root.
    const restarted = makeAccountConnect({ storage: makeAccountStorage({ root }) });
    await Effect.runPromise(restarted.recoverInterruptedOperations);
    const status = await Effect.runPromise(restarted.getConnectStatus(operationId));
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/interrupted by a server restart/);
    expect(status.provider).toBe("codex");
    await expect(Effect.runPromise(storage.listPendingOperations("codex"))).resolves.toEqual([]);
    await expect(Effect.runPromise(storage.listOrdinals("codex"))).resolves.toEqual([]);
  });

  it("protects the native account 0 from disconnect and hide", async () => {
    await expectFailureDetail(connect.disconnectBinding("codex", 0, "agent"), /native account/);
    await expectFailureDetail(connect.hide("codex", 0), /native account/);
  });
});

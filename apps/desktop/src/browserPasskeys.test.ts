import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import type { BrowserPasskeyCredential, BrowserPasskeyRequest } from "@synara/contracts";
import type { BrowserAutomationVisibleRuntime } from "./browserManager";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: () => true }));
vi.mock("@synara/shared/processRuntime", () => ({
  spawnProcess: mocks.spawn,
  didProcessFailToSpawn: () => false,
}));
import { BrowserPasskeys, passkeyRelyingParty, validatePasskeyCredential } from "./browserPasskeys";

const request: BrowserPasskeyRequest = {
  id: "11111111-1111-4111-8111-111111111111",
  publicKey: { challenge: "AQID", userVerification: "required", allowCredentials: [] },
};
const origin = "https://login.example.com";
function credential(): BrowserPasskeyCredential {
  const data = Buffer.alloc(37);
  createHash("sha256").update("login.example.com").digest().copy(data);
  data[32] = 5;
  return {
    id: "AQID",
    rawId: "AQID",
    type: "public-key",
    response: {
      authenticatorData: data.toString("base64url"),
      signature: "AQID",
      userHandle: "AQID",
      clientDataJSON: Buffer.from(
        JSON.stringify({ type: "webauthn.get", challenge: "AQID", origin, crossOrigin: false }),
      ).toString("base64url"),
    },
  };
}
function setup() {
  const contents = Object.assign(new EventEmitter(), {
    getURL: () => origin,
    isDestroyed: () => false,
    mainFrame: { url: origin },
  });
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn(() => {
      queueMicrotask(() => {
        child.emit("exit", null);
        child.emit("close", null);
      });
      return true;
    }),
  });
  mocks.spawn.mockReturnValue(child);
  const releaseHuman = vi.fn();
  const beginHuman = vi.fn(() => releaseHuman);
  const host = new BrowserPasskeys("/synthetic/helper", vi.fn(), beginHuman);
  const release = host.register({
    webContents: contents,
  } as unknown as BrowserAutomationVisibleRuntime);
  const event = {
    sender: contents,
    senderFrame: contents.mainFrame,
  } as unknown as IpcMainInvokeEvent;
  return { contents, child, host, event, release, beginHuman, releaseHuman };
}
afterEach(() => {
  mocks.spawn.mockReset();
  vi.useRealTimers();
});

describe("phone passkey boundaries", () => {
  it.each(["com", "co.uk", "github.io", "other.example", "example.com.evil.test", "example.com."])(
    "rejects unsafe relying party %s",
    (rp) => {
      expect(() => passkeyRelyingParty(origin, rp)).toThrow();
    },
  );
  it("accepts exact origins and registrable parent domains", () => {
    expect(passkeyRelyingParty(origin)).toBe("login.example.com");
    expect(passkeyRelyingParty(origin, "example.com")).toBe("example.com");
    expect(() => passkeyRelyingParty("http://example.com")).toThrow();
  });
  it.each(["origin", "challenge", "rpHash", "uv", "userHandle"])(
    "rejects an assertion with mismatched %s",
    (field) => {
      const original = credential();
      const value = { ...original, response: { ...original.response } };
      if (field === "userHandle") value.response.userHandle = null;
      if (field === "rpHash" || field === "uv") {
        const data = Buffer.from(value.response.authenticatorData, "base64url");
        data[field === "rpHash" ? 0 : 32] = 0;
        value.response.authenticatorData = data.toString("base64url");
      }
      if (field === "origin" || field === "challenge")
        value.response.clientDataJSON = Buffer.from(
          JSON.stringify({
            type: "webauthn.get",
            origin: field === "origin" ? "https://evil.test" : origin,
            challenge: field === "challenge" ? "BAUG" : "AQID",
          }),
        ).toString("base64url");
      expect(() =>
        validatePasskeyCredential(value, request, origin, "login.example.com"),
      ).toThrow();
    },
  );
  it("requires a registered main frame and explicit trusted-shell confirmation", async () => {
    const { host, event, release } = setup();
    await expect(
      host.request({ ...event, senderFrame: {} } as IpcMainInvokeEvent, request),
    ).resolves.toEqual({ ok: false, code: "SecurityError" });
    const pending = host.request(event, request);
    expect(host.snapshot()?.phase).toBe("confirm");
    expect(mocks.spawn).not.toHaveBeenCalled();
    await host.abortFrom({} as WebContents, request.id);
    expect(host.snapshot()).not.toBeNull();
    await host.cancel(request.id);
    await expect(pending).resolves.toEqual({ ok: false, code: "AbortError" });
    release();
  });
  it("returns the origin-bound assertion only after the helper exits", async () => {
    const { host, event, child, release, releaseHuman, beginHuman } = setup();
    const pending = host.request(event, request);
    const settled = vi.fn();
    void pending.then(settled);
    host.start(request.id);
    expect(beginHuman).toHaveBeenCalledOnce();
    child.stdout.write(JSON.stringify({ type: "result", credential: credential() }) + "\n");
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(releaseHuman).not.toHaveBeenCalled();
    child.emit("exit", 0);
    child.emit("close", 0);
    await expect(pending).resolves.toEqual({ ok: true, credential: credential() });
    expect(host.snapshot()).toBeNull();
    expect(releaseHuman).toHaveBeenCalledOnce();
    release();
  });
  it("cancels a request on navigation and drains the helper", async () => {
    const { host, event, child, contents, release } = setup();
    const pending = host.request(event, request);
    host.start(request.id);
    contents.emit("did-start-navigation", {}, "https://other.test", false, true);
    await expect(pending).resolves.toEqual({ ok: false, code: "AbortError" });
    expect(child.kill).toHaveBeenCalled();
    expect(host.snapshot()).toBeNull();
    release();
  });
  it("keeps admission blocked when a cancelled helper cannot be proven stopped", async () => {
    vi.useFakeTimers();
    const { host, event, child, release } = setup();
    child.kill.mockImplementation(() => true);
    const pending = host.request(event, request);
    host.start(request.id);
    const cancelling = host.cancel(request.id);
    await vi.advanceTimersByTimeAsync(2001);
    await cancelling;
    await expect(pending).resolves.toEqual({ ok: false, code: "NotAllowedError" });
    await expect(host.request(event, request)).resolves.toEqual({
      ok: false,
      code: "NotAllowedError",
    });
    child.emit("exit", null);
    child.emit("close", null);
    expect(host.snapshot()).toBeNull();
    release();
  });
});

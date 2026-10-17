import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installPhonePasskeys } from "./browserPasskeyPage";
import type { BrowserPasskeyResult } from "@synara/contracts";

const originalGet = vi.fn(async () => null);
const request = vi.fn();
const abort = vi.fn(async () => {});
class PublicKeyFixture extends EventTarget {
  static isConditionalMediationAvailable = async () => true;
  static isUserVerifyingPlatformAuthenticatorAvailable = async () => false;
}
class AssertionFixture extends EventTarget {}
beforeEach(() => {
  originalGet.mockClear();
  request.mockReset();
  abort.mockClear();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("top", globalThis);
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("navigator", { credentials: { get: originalGet } });
  vi.stubGlobal("PublicKeyCredential", PublicKeyFixture);
  vi.stubGlobal("AuthenticatorAssertionResponse", AssertionFixture);
  vi.stubGlobal("__synaraPhonePasskeys", { request, abort });
});
afterEach(() => vi.unstubAllGlobals());
const options = { publicKey: { challenge: new Uint8Array([1, 2, 3]) } };

it("returns binary WebAuthn fields and a serializable credential", async () => {
  const credential = {
    id: "AQID",
    rawId: "AQID",
    type: "public-key" as const,
    response: {
      clientDataJSON: "AQID",
      authenticatorData: "AQID",
      signature: "AQID",
      userHandle: "BAUG",
    },
  };
  request.mockResolvedValue({ ok: true, credential } satisfies BrowserPasskeyResult);
  installPhonePasskeys();
  const result = (await navigator.credentials.get(options)) as PublicKeyCredential;
  expect(result).toBeInstanceOf(PublicKeyFixture);
  expect(result.response).toBeInstanceOf(AssertionFixture);
  expect(
    Array.from(new Uint8Array((result.response as AuthenticatorAssertionResponse).userHandle!)),
  ).toEqual([4, 5, 6]);
  expect(result.getClientExtensionResults()).toEqual({});
  expect(result.toJSON()).toMatchObject(credential);
  const serialize = vi.fn(result.toJSON);
  result.toJSON = serialize;
  expect(result.toJSON()).toMatchObject(credential);
  expect(serialize).toHaveBeenCalledOnce();
  expect(request.mock.calls[0]![0].publicKey.challenge).toBe("AQID");
});

it("preserves native password requests and avoids automatically prompting conditional requests", async () => {
  installPhonePasskeys();
  await navigator.credentials.get();
  await navigator.credentials.get({ ...options, mediation: "conditional" });
  expect(originalGet).toHaveBeenCalledTimes(2);
  expect(request).not.toHaveBeenCalled();
});

it("advertises phone transport without claiming a local platform authenticator", async () => {
  installPhonePasskeys();
  expect(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()).toBe(false);
  expect(await PublicKeyCredential.isConditionalMediationAvailable()).toBe(false);
  expect(await PublicKeyCredential.getClientCapabilities()).toMatchObject({
    hybridTransport: true,
    passkeyPlatformAuthenticator: true,
  });
});

it("does not install a bridge in a subframe or insecure context", () => {
  vi.stubGlobal("top", {});
  installPhonePasskeys();
  expect(navigator.credentials.get).toBe(originalGet);
  vi.stubGlobal("top", globalThis);
  vi.stubGlobal("isSecureContext", false);
  installPhonePasskeys();
  expect(navigator.credentials.get).toBe(originalGet);
});

it("cancels the native request when abort races request submission", async () => {
  const controller = new AbortController();
  request.mockImplementation(async () => {
    controller.abort(new Error("stopped"));
    return { ok: false, code: "AbortError" } satisfies BrowserPasskeyResult;
  });
  installPhonePasskeys();
  await expect(
    navigator.credentials.get({ ...options, signal: controller.signal }),
  ).rejects.toThrow("stopped");
  expect(abort).toHaveBeenCalledWith(request.mock.calls[0]![0].id);
});

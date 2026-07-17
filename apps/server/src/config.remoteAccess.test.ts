import { describe, expect, it } from "vitest";

import { normalizeHttpsPublicOrigin, remoteAccessPolicyError } from "./config";

const remoteBase = {
  host: "0.0.0.0",
  authToken: "remote-secret",
  devUrl: undefined,
  publicUrl: undefined,
  allowInsecureRemote: false,
} as const;

describe("remote access policy", () => {
  it("fails closed for authenticated plaintext remote binds", () => {
    expect(remoteAccessPolicyError(remoteBase)).toContain("Refusing plaintext remote access");
  });

  it("allows an HTTPS reverse-proxy origin or explicit insecure LAN opt-in", () => {
    expect(
      remoteAccessPolicyError({
        ...remoteBase,
        publicUrl: new URL("https://synara.example.test/"),
      }),
    ).toBeNull();
    expect(remoteAccessPolicyError({ ...remoteBase, allowInsecureRemote: true })).toBeNull();
  });

  it("requires authentication when an HTTPS proxy publishes a loopback bind", () => {
    expect(
      remoteAccessPolicyError({
        ...remoteBase,
        host: "127.0.0.1",
        authToken: undefined,
        publicUrl: new URL("https://synara.example.test/"),
      }),
    ).toContain("without SYNARA_AUTH_TOKEN");
  });

  it("rejects invalid public URLs in the shared embedded-server policy", () => {
    for (const publicUrl of [
      new URL("http://synara.example.test/"),
      new URL("https://synara.example.test/app"),
    ]) {
      expect(
        remoteAccessPolicyError({
          ...remoteBase,
          host: "127.0.0.1",
          publicUrl,
        }),
      ).toContain("must be an HTTPS root origin");
    }
  });

  it("rejects a dev URL whenever a public proxy origin exposes the loopback bind", () => {
    expect(
      remoteAccessPolicyError({
        ...remoteBase,
        host: "127.0.0.1",
        devUrl: new URL("http://localhost:5173/"),
        publicUrl: new URL("https://synara.example.test/"),
      }),
    ).toContain("cannot be combined with VITE_DEV_SERVER_URL");
  });

  it("accepts only credential-free HTTPS root origins", () => {
    expect(normalizeHttpsPublicOrigin(new URL("https://synara.example.test/"))?.origin).toBe(
      "https://synara.example.test",
    );
    for (const value of [
      "http://synara.example.test/",
      "https://user:pass@synara.example.test/",
      "https://synara.example.test/app",
      "https://synara.example.test/?query=1",
      "https://synara.example.test/#fragment",
    ]) {
      expect(normalizeHttpsPublicOrigin(new URL(value))).toBeNull();
    }
  });
});

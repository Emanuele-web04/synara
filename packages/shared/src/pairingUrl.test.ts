import { describe, expect, it } from "vitest";

import { buildPairingUrl, normalizeRemotePairingOrigin } from "./pairingUrl";

describe("pairing URLs", () => {
  it("keeps only the one-time credential in the fragment", () => {
    const credential = "one-time /+?&#=token";
    const url = new URL(
      buildPairingUrl("https://synara.example.test/chat?token=legacy-secret#old", credential),
    );
    expect(url.origin).toBe("https://synara.example.test");
    expect(url.pathname).toBe("/pair");
    expect(url.search).toBe("");
    expect(new URLSearchParams(url.hash.slice(1)).get("token")).toBe(credential);
    expect(url.toString()).not.toContain("legacy-secret");
  });

  it.each([
    ["https://synara.example.test/", "https://synara.example.test"],
    [" http://192.168.1.10:3773 ", "http://192.168.1.10:3773"],
    ["http://[fd00::10]:3773", "http://[fd00::10]:3773"],
  ])("accepts an explicit remote origin: %s", (input, expected) => {
    expect(normalizeRemotePairingOrigin(input)).toBe(expected);
  });

  it.each([
    undefined,
    "not a URL",
    "file:///tmp/synara",
    "javascript:alert(1)",
    "https://user:secret@synara.example.test",
    "https://synara.example.test/chat",
    "https://synara.example.test?token=legacy",
    "https://synara.example.test#token=old",
    "http://synara.example.test:0",
    "http://localhost:3773",
    "http://localhost.:3773",
    "http://app.localhost:3773",
    "http://localhost.localdomain:3773",
    "http://127.20.30.40:3773",
    "http://2130706433:3773",
    "http://0.0.0.0:3773",
    "http://0:3773",
    "http://[::]:3773",
    "http://[::1]:3773",
    "http://[::ffff:127.0.0.1]:3773",
    "http://[::ffff:0.0.0.0]:3773",
  ])("rejects unusable or credential-bearing origins: %s", (input) => {
    expect(normalizeRemotePairingOrigin(input)).toBeUndefined();
  });
});

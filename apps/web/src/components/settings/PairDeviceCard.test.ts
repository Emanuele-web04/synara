import { describe, expect, it } from "vitest";

import { buildPairingUrl } from "./PairDeviceCard";

describe("buildPairingUrl", () => {
  it("puts the credential in the hash of the /pair route", () => {
    expect(buildPairingUrl("https://synara.example:3773", "abc123")).toBe(
      "https://synara.example:3773/pair#token=abc123",
    );
  });

  it("percent-encodes credentials so the hash round-trips through URLSearchParams", () => {
    const url = buildPairingUrl("http://127.0.0.1:3773", "a+b/c=");
    const hash = new URL(url).hash.slice(1);
    expect(new URLSearchParams(hash).get("token")).toBe("a+b/c=");
  });
});

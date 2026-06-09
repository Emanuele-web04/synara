import { describe, expect, it } from "vitest";

import { decodeJwtExpMs, decodeKeychainJson } from "./credentials.ts";

describe("decodeKeychainJson", () => {
  it("parses raw JSON payloads", () => {
    expect(decodeKeychainJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses hex-encoded JSON payloads (Claude on macOS)", () => {
    const hex = Buffer.from('{"claudeAiOauth":{"accessToken":"t"}}', "utf8").toString("hex");
    expect(decodeKeychainJson(hex)).toEqual({ claudeAiOauth: { accessToken: "t" } });
  });

  it("parses 0x-prefixed hex JSON payloads", () => {
    const hex = Buffer.from('{"claudeAiOauth":{"accessToken":"t"}}', "utf8").toString("hex");
    expect(decodeKeychainJson(`0x${hex}`)).toEqual({ claudeAiOauth: { accessToken: "t" } });
  });

  it("returns null for non-JSON, non-hex values", () => {
    expect(decodeKeychainJson("not-a-token")).toBeNull();
  });
});

describe("decodeJwtExpMs", () => {
  it("decodes the exp claim into epoch milliseconds", () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1_700_000_000 }), "utf8").toString(
      "base64url",
    );
    expect(decodeJwtExpMs(`header.${payload}.signature`)).toBe(1_700_000_000_000);
  });

  it("returns null for malformed tokens", () => {
    expect(decodeJwtExpMs("not-a-jwt")).toBeNull();
    expect(decodeJwtExpMs(undefined)).toBeNull();
  });
});

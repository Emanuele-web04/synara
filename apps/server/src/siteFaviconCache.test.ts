// FILE: siteFaviconCache.test.ts
// Purpose: Verifies hostname normalization + parsing for the favicon cache, which
//          underpins domain-level dedup (every URL on a site shares one cache key).
// Layer: Server utility tests

import { describe, expect, it } from "vitest";

import { normalizeFaviconHost, tryParseHost } from "./siteFaviconCache";

describe("normalizeFaviconHost", () => {
  it("lower-cases the host", () => {
    expect(normalizeFaviconHost("GitHub.COM")).toBe("github.com");
  });

  it("strips a leading www.", () => {
    expect(normalizeFaviconHost("www.example.com")).toBe("example.com");
  });

  it("keeps non-www subdomains intact", () => {
    expect(normalizeFaviconHost("docs.example.com")).toBe("docs.example.com");
  });
});

describe("tryParseHost", () => {
  it("extracts the host from a full URL", () => {
    expect(tryParseHost("https://x.com/thegenioo/status/2062795593567666188")).toBe("x.com");
  });

  it("accepts a bare domain without a scheme", () => {
    expect(tryParseHost("example.com")).toBe("example.com");
  });

  it("normalizes www and casing", () => {
    expect(tryParseHost("https://WWW.Linear.app/issue/SYN-72")).toBe("linear.app");
  });

  it("returns null for unparseable input", () => {
    expect(tryParseHost("not a url!!!")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(tryParseHost("   ")).toBeNull();
  });
});

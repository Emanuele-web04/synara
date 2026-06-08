// FILE: siteFavicon.test.ts
// Purpose: Verifies hostname extraction and that the favicon proxy URL is keyed by
//          host, so every link on a site dedupes onto one cacheable request.
// Layer: Web utility tests

import { afterEach, describe, expect, it, vi } from "vitest";

import { extractHostname, resolveSiteFaviconUrl } from "./siteFavicon";

describe("extractHostname", () => {
  it("extracts the hostname from a full https URL", () => {
    expect(extractHostname("https://github.com/foo/bar")).toBe("github.com");
  });

  it("returns null for a bare domain without a scheme", () => {
    expect(extractHostname("example.com")).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(extractHostname("not-a-url")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(extractHostname("")).toBeNull();
  });
});

describe("resolveSiteFaviconUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keys the request by hostname so links on one site share a cache entry", () => {
    const first = resolveSiteFaviconUrl("https://x.com/a/long/path");
    const second = resolveSiteFaviconUrl("https://x.com/another/path?q=1");
    expect(first).toBe(second);
    expect(first).toContain("/api/site-favicon");
    expect(first).toContain("domain=x.com");
  });

  it("carries the WebSocket startup token for desktop image requests", () => {
    vi.stubGlobal("window", {
      location: { origin: "http://localhost:3000" },
      desktopBridge: { getWsUrl: () => "ws://127.0.0.1:4567/ws?token=dev-secret" },
    });

    const url = resolveSiteFaviconUrl("https://openai.com/research");

    expect(url).toBe(
      "http://127.0.0.1:4567/api/site-favicon?domain=openai.com&token=dev-secret",
    );
  });
});

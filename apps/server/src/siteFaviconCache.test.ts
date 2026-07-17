// FILE: siteFaviconCache.test.ts
// Purpose: Verifies hostname normalization + parsing for the favicon cache, which
//          underpins domain-level dedup (every URL on a site shares one cache key).
// Layer: Server utility tests

import { outboundHttp, type OutboundHttpResponse } from "@synara/shared/outboundHttp";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearSiteFaviconCache,
  normalizeFaviconHost,
  resolveFavicon,
  tryParseHost,
} from "./siteFaviconCache";

const imageResponse: OutboundHttpResponse = {
  status: 200,
  headers: new Headers({ "content-type": "image/png" }),
  body: new Uint8Array([1, 2, 3]),
  url: "https://www.google.com/favicon.png",
};

afterEach(() => {
  clearSiteFaviconCache();
  vi.restoreAllMocks();
});

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

describe("resolveFavicon", () => {
  it("uses the shared bounded outbound policy", async () => {
    const request = vi.spyOn(outboundHttp, "request").mockResolvedValue(imageResponse);

    const favicon = await resolveFavicon("example.com");

    expect(favicon.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(request.mock.calls[0]?.[0].policy).toMatchObject({
      service: "site-favicon",
      allowedOrigins: ["https://www.google.com"],
      maxResponseBytes: 512 * 1024,
      requirePublicAddress: true,
    });
  });

  it("pins the direct fallback to the requested public origin", async () => {
    const request = vi
      .spyOn(outboundHttp, "request")
      .mockResolvedValueOnce({ ...imageResponse, status: 404, body: new Uint8Array() })
      .mockResolvedValueOnce({ ...imageResponse, status: 404, body: new Uint8Array() })
      .mockResolvedValueOnce({
        ...imageResponse,
        url: "https://example.org/favicon.ico",
      });

    await resolveFavicon("example.org");

    expect(request.mock.calls[2]?.[0]).toMatchObject({
      url: "https://example.org/favicon.ico",
      policy: { allowedOrigins: ["https://example.org"] },
    });
  });
});

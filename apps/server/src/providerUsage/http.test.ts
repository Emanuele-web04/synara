import { afterEach, describe, expect, it, vi } from "vitest";

import { outboundHttp } from "@synara/shared/outboundHttp";
import { fetchJson, isEdgeBlockedResponse } from "./http";

function response() {
  return {
    status: 200,
    headers: new Headers({ "Content-Type": "application/json" }),
    body: new TextEncoder().encode('{"ok":true}'),
    url: "https://api.example.com/status",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchJson outbound policy", () => {
  it("keeps HTTPS and public-address enforcement as the default", async () => {
    const request = vi.spyOn(outboundHttp, "request").mockResolvedValue(response());

    await fetchJson({
      service: "test-provider",
      url: "https://api.example.com/status",
      allowedOrigins: ["https://api.example.com"],
    });

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0].policy).toMatchObject({ requirePublicAddress: true });
    expect(request.mock.calls[0]?.[0].policy.allowLoopbackHttp).toBeUndefined();
  });

  it("opts in to the fake-ip benchmark range for pinned provider origins", async () => {
    const request = vi.spyOn(outboundHttp, "request").mockResolvedValue(response());

    await fetchJson({
      service: "test-provider",
      url: "https://api.example.com/status",
      allowedOrigins: ["https://api.example.com"],
    });

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0].policy).toMatchObject({
      requirePublicAddress: true,
      allowBenchmarkAddressRange: true,
    });
  });

  it("passes through only an explicit loopback HTTP opt-in", async () => {
    const request = vi.spyOn(outboundHttp, "request").mockResolvedValue({
      ...response(),
      url: "http://127.0.0.1:3000/status",
    });

    await fetchJson({
      service: "test-provider",
      url: "http://127.0.0.1:3000/status",
      allowedOrigins: ["http://127.0.0.1:3000"],
      allowLoopbackHttp: true,
    });

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0].policy).toMatchObject({
      allowLoopbackHttp: true,
      requirePublicAddress: true,
    });
  });
});

function result(status: number, headers: Record<string, string>, json: unknown = null) {
  return { status, json, headers: new Headers(headers) };
}

describe("isEdgeBlockedResponse", () => {
  it("recognizes Cloudflare block and challenge pages", () => {
    expect(isEdgeBlockedResponse(result(403, { "cf-mitigated": "challenge" }))).toBe(true);
    expect(isEdgeBlockedResponse(result(403, { "content-type": "text/html; charset=UTF-8" }))).toBe(
      true,
    );
    expect(isEdgeBlockedResponse(result(403, { server: "cloudflare" }))).toBe(true);
  });

  it("keeps provider JSON rejections and non-403 statuses as non-edge responses", () => {
    const jsonError = { error: { type: "permission_error" } };
    expect(
      isEdgeBlockedResponse(
        result(403, { server: "cloudflare", "content-type": "application/json" }, jsonError),
      ),
    ).toBe(false);
    expect(isEdgeBlockedResponse(result(401, { "cf-mitigated": "challenge" }))).toBe(false);
    expect(isEdgeBlockedResponse(result(403, {}))).toBe(false);
  });
});

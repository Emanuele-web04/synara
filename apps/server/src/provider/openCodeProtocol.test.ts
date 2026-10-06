import { describe, expect, it, vi } from "vitest";

import { detectOpenCodeProtocol, OpenCodeProtocolError } from "./openCodeProtocol.ts";

const baseUrl = "http://127.0.0.1:4096";
const missing = () => new Response("", { status: 404 });

describe("OpenCode protocol negotiation", () => {
  it.each(["/api/info", "/api/status", "/api/health"])(
    "recognizes version-bearing v2 JSON at %s",
    async (path) => {
      const request = vi.fn(async (url: unknown) =>
        String(url).endsWith(path) ? Response.json({ data: { version: " 2.0.4 " } }) : missing(),
      );
      await expect(
        detectOpenCodeProtocol({ baseUrl: `${baseUrl}/`, fetch: request }),
      ).resolves.toEqual({
        protocol: "v2",
        version: "2.0.4",
      });
      expect(request.mock.calls.at(-1)?.[0]).toBe(`${baseUrl}${path}`);
    },
  );

  it("authenticates every probe and scopes the directory through a header", async () => {
    const request = vi.fn(async (url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe(
        `Basic ${Buffer.from("opencode:private-password").toString("base64")}`,
      );
      expect(headers.get("x-opencode-directory")).toBe(encodeURIComponent("/repo/with spaces"));
      expect(new URL(String(url)).search).toBe("");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return String(url).endsWith("/api/health") ? Response.json({ version: "2.0.4" }) : missing();
    });
    await detectOpenCodeProtocol({
      baseUrl,
      directory: "/repo/with spaces",
      password: "private-password",
      fetch: request,
    });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("recognizes v1 health without confusing a HTML catchall with v2", async () => {
    const request = vi.fn(async (url: unknown) =>
      String(url).endsWith("/global/health")
        ? Response.json({ healthy: true, version: "1.18.31" })
        : new Response("<html>OpenCode</html>", { headers: { "content-type": "text/html" } }),
    );
    await expect(detectOpenCodeProtocol({ baseUrl, fetch: request })).resolves.toEqual({
      protocol: "v1",
      version: "1.18.31",
    });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("supports v1 servers exposing the validated provider inventory without health", async () => {
    const request = vi.fn(async (url: unknown) =>
      String(url).endsWith("/provider")
        ? Response.json({ all: [], default: {}, connected: [] })
        : missing(),
    );
    await expect(detectOpenCodeProtocol({ baseUrl, fetch: request })).resolves.toEqual({
      protocol: "v1",
    });
    expect(request).toHaveBeenCalledTimes(5);
  });

  it.each([
    [
      "HTML catchall",
      () => new Response("<html>OpenCode</html>", { headers: { "content-type": "text/html" } }),
    ],
    ["empty JSON object", () => Response.json({})],
    [
      "malformed JSON",
      () => new Response("{broken", { headers: { "content-type": "application/json" } }),
    ],
    ["empty version", () => Response.json({ version: " " })],
    ["partial provider inventory", () => Response.json({ all: [], connected: [] })],
  ])("rejects %s rather than selecting an incompatible client", async (_description, response) => {
    await expect(
      detectOpenCodeProtocol({ baseUrl, fetch: async () => response() }),
    ).rejects.toThrow("supported JSON API");
  });

  it.each([401, 403])("does not fall back to another protocol after HTTP %s", async (status) => {
    const request = vi.fn(async () => new Response("", { status }));
    const failure = await detectOpenCodeProtocol({
      baseUrl,
      password: "private-password",
      fetch: request,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OpenCodeProtocolError);
    expect(failure).toMatchObject({ status });
    expect(String(failure)).toContain("rejected its HTTP credentials");
    expect(String(failure)).not.toContain("private-password");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("continues past a network error to the v1 fallback", async () => {
    const request = vi.fn(async (url: unknown) => {
      if (String(url).endsWith("/api/info")) throw new Error("temporary connection failure");
      return String(url).endsWith("/global/health")
        ? Response.json({ version: "1.18.31" })
        : missing();
    });
    await expect(detectOpenCodeProtocol({ baseUrl, fetch: request })).resolves.toMatchObject({
      protocol: "v1",
    });
  });

  it("honors cancellation without continuing unauthenticated fallback probes", async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    await expect(
      detectOpenCodeProtocol({ baseUrl, signal: controller.signal, fetch: request }),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
});

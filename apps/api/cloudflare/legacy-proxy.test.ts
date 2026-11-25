import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({ Container: vi.fn() }));
import proxy from "./legacy-proxy";

afterEach(() => vi.unstubAllGlobals());

describe("legacy account API forwarding", () => {
  it("keeps the destination, upload body and authentication while replacing relay headers", async () => {
    const upstream = vi.fn(async (_request: Request) => new Response("upstream", { status: 201 }));
    vi.stubGlobal("fetch", upstream);
    const response = await proxy.fetch(
      new Request("https://old.example//attacker.example/api/v1/profile/avatar?x=1", {
        method: "PUT",
        body: "image bytes",
        headers: {
          authorization: "Bearer existing-session",
          "content-type": "image/webp",
          "cf-connecting-ip": "2001:db8::1",
          "x-synara-client-ip": "192.0.2.123",
          "x-synara-migration-secret": "forged",
        },
      }),
      { MIGRATION_TARGET: "https://new.example", MIGRATION_PROXY_SECRET: "relay-key" },
    );
    const sent = upstream.mock.calls[0]![0];
    expect(response.status).toBe(201);
    expect(new URL(sent.url).origin).toBe("https://new.example");
    expect(new URL(sent.url).search).toBe("?x=1");
    expect(sent.redirect).toBe("manual");
    expect(sent.headers.get("authorization")).toBe("Bearer existing-session");
    expect(sent.headers.get("content-type")).toBe("image/webp");
    expect(sent.headers.get("x-synara-client-ip")).toBe("2001:db8::1");
    expect(sent.headers.get("x-synara-migration-secret")).toBe("relay-key");
    expect(await sent.text()).toBe("image bytes");
  });

  it.each([
    undefined,
    "http://new.example",
    "https://user:secret@new.example",
    "https://new.example/path",
  ])("fails closed for missing or invalid target %s", async (target) => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const response = await proxy.fetch(new Request("https://old.example/"), {
      ...(target ? { MIGRATION_TARGET: target } : {}),
      MIGRATION_PROXY_SECRET: "relay-key",
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("requires the relay secret and hides upstream failures", async () => {
    const upstream = vi.fn(async () => {
      throw new Error("private connection details");
    });
    vi.stubGlobal("fetch", upstream);
    const request: Parameters<typeof proxy.fetch>[0] = new Request("https://old.example/");
    expect((await proxy.fetch(request, { MIGRATION_TARGET: "https://new.example" })).status).toBe(
      503,
    );
    expect(upstream).not.toHaveBeenCalled();
    const response = await proxy.fetch(request, {
      MIGRATION_TARGET: "https://new.example",
      MIGRATION_PROXY_SECRET: "relay-key",
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private");
  });
});

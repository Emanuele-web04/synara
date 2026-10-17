import { describe, expect, it, vi } from "vitest";
import { NotionClient, NotionFailure, readNotionJson } from "./client.ts";
const pageId = "11111111-1111-4111-8111-111111111111";
function client(fetcher: typeof fetch, refresh = async () => {}) {
  return new NotionClient({
    fetch: fetcher,
    accessToken: () => "test-access",
    refresh,
    sleep: async () => {},
  });
}
describe("Notion API transport", () => {
  it("uses the current version, fixed origin, and no redirects", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ object: "page" }));
    await client(fetcher).read({ connectionId: "c", kind: "page", id: pageId });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(`https://api.notion.com/v1/pages/${pageId}`);
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      "Notion-Version": "2026-03-11",
      Authorization: "Bearer test-access",
    });
  });
  it("rejects arbitrary origins before fetching", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(client(fetcher).request("https://evil.example/v1/pages")).rejects.toThrow(
      "Invalid Notion API path",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not replay a write after network uncertainty", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("connection reset"));
    await expect(
      client(fetcher).request("/v1/pages", { method: "POST", body: { properties: {} } }),
    ).rejects.toMatchObject({ code: "unknown-outcome" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("bounds read retries", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("down", { status: 503 }));
    await expect(client(fetcher).request("/v1/users")).rejects.toBeInstanceOf(NotionFailure);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("honors long Retry-After without holding the caller indefinitely", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("", { status: 429, headers: { "Retry-After": "60" } }));
    await expect(client(fetcher).request("/v1/users")).rejects.toMatchObject({
      code: "rate-limited",
      retryAfterMs: 60_000,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("refreshes once after an explicit unauthorized response", async () => {
    const refresh = vi.fn(async () => {});
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(Response.json({ results: [] }));
    await client(fetcher, refresh).request("/v1/users");
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it("fails incomplete pagination instead of treating it as a deletion snapshot", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ results: [], has_more: true, next_cursor: "same" }),
      );
    const run = async () => {
      for await (const _ of client(fetcher).pages({
        connectionId: "c",
        kind: "query",
        id: pageId,
      })) {
        /* Drain the bounded provider iterator. */
      }
    };
    await expect(run()).rejects.toThrow("pagination cursor");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("enforces response bounds before reading oversized content", async () => {
    await expect(
      readNotionJson(new Response("{}", { headers: { "Content-Length": "9999" } }), 100),
    ).rejects.toThrow("too much data");
  });
});

describe("Notion dispatch authorization", () => {
  it("does not treat a pre-dispatch denial as an unknown network outcome", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const denied = new NotionFailure("Revoked", "forbidden", 403);
    await expect(
      client(fetcher).request("/v1/pages", {
        method: "POST",
        beforeSend: async () => {
          throw denied;
        },
      }),
    ).rejects.toBe(denied);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([401, 429])(
    "rechecks authorization after a %s response before retrying",
    async (status) => {
      let allowed = true;
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
        allowed = false;
        return new Response("", { status });
      });
      const guard = vi.fn(async () => {
        if (!allowed) throw new NotionFailure("Revoked", "forbidden", 403);
      });
      await expect(
        client(fetcher).request("/v1/pages", { method: "POST", beforeSend: guard }),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(guard).toHaveBeenCalledTimes(2);
    },
  );
  it("checks after the rate-limit queue, not before it", async () => {
    let allowed = true;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ object: "page" }));
    const api = new NotionClient({
      fetch: fetcher,
      accessToken: () => "fixture",
      refresh: async () => {},
      now: () => 0,
      sleep: async () => {
        allowed = false;
      },
    });
    await api.request("/v1/users");
    await expect(
      api.request("/v1/pages", {
        method: "POST",
        beforeSend: async () => {
          if (!allowed) throw new NotionFailure("Revoked", "forbidden", 403);
        },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

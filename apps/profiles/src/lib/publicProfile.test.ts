import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
import { headers } from "next/headers";
import { fetchPublicProfile } from "./publicProfile";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(headers).mockResolvedValue(new Headers());
});

describe("public profile publication", () => {
  it("rechecks publication after a public profile becomes private", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ handle: "ada", displayName: "Ada" }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetch);

    expect(await fetchPublicProfile("ada")).toMatchObject({ handle: "ada" });
    expect(await fetchPublicProfile("ada")).toBeNull();
    for (const [, options] of fetch.mock.calls) {
      expect(options.cache).toBe("no-store");
      expect(options.next).toBeUndefined();
    }
  });

  it("does not turn an upstream outage into a missing profile", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    await expect(fetchPublicProfile("ada")).rejects.toThrow("503");
  });

  it("forwards the Cloudflare caller instead of a forged proxy chain", async () => {
    vi.mocked(headers).mockResolvedValue(
      new Headers({
        "cf-connecting-ip": "2001:db8::1",
        "x-forwarded-for": "192.0.2.9, 192.0.2.10",
        "x-real-ip": "192.0.2.11",
      }),
    );
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    await fetchPublicProfile("ada");
    expect(fetch.mock.calls[0]![1].headers["x-synara-viewer-ip"]).toBe("2001:db8::1");
  });

  it("does not forward an untrusted address when the Cloudflare header is absent", async () => {
    vi.mocked(headers).mockResolvedValue(new Headers({ "x-forwarded-for": "192.0.2.9" }));
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    await fetchPublicProfile("ada");
    expect(fetch.mock.calls[0]![1].headers?.["x-synara-viewer-ip"]).toBeUndefined();
  });
});

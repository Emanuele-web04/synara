// Verify legacy forwarding preserves request data and keeps the configured destination origin.
// All outbound fetches use fixtures; dashboard redirects must not fetch at all.
import { afterEach, describe, expect, it, vi } from "vitest";

import forwarder from "./worker";

const OLD = "https://synara-beta-diagnostics.kartik-9f9.workers.dev";
const NEW = "https://synara-beta-diagnostics.example.workers.dev";

afterEach(() => vi.unstubAllGlobals());

describe("forwarder", () => {
  it("answers 503 without a target so clients keep their queue", async () => {
    const res = await forwarder.fetch(
      new Request(`${OLD}/v1/events`, { method: "POST", body: "x" }),
      {},
    );
    expect(res.status).toBe(503);
  });

  it("proxies ingest to the target with method, headers, and body", async () => {
    const fetchMock = vi.fn(async (_req: Request) => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const res = await forwarder.fetch(
      new Request(`${OLD}/v1/events?x=1`, {
        method: "POST",
        headers: { "content-type": "application/x-ndjson" },
        body: '{"a":1}\n',
      }),
      { TARGET: NEW },
    );
    expect(res.status).toBe(200);
    const sent = fetchMock.mock.calls[0]![0];
    expect(sent.url).toBe(`${NEW}/v1/events?x=1`);
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("content-type")).toBe("application/x-ndjson");
    expect(await sent.text()).toBe('{"a":1}\n');
  });

  it.each(["/login", "//attacker.invalid/login?next=%2F"])(
    "redirects dashboard path %s within the configured target origin",
    async (path) => {
      const fetchMock = vi.fn(async () => new Response("unexpected fetch"));
      vi.stubGlobal("fetch", fetchMock);
      const res = await forwarder.fetch(new Request(`${OLD}${path}`), { TARGET: NEW });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe(`${NEW}${path}`);
    },
  );
});

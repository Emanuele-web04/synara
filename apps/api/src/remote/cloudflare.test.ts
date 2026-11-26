import { describe, expect, it } from "vitest";
import { loadCloudflareTunnelConfig } from "../config";
import { createCloudflareClient } from "./cloudflare";

const config = {
  accountId: "a".repeat(32),
  zoneId: "b".repeat(32),
  apiToken: "admin-secret",
  domain: "example.test",
};
const result = (value: unknown) => Response.json({ success: true, result: value });
describe("Cloudflare boundary", () => {
  it("fails explicitly on partial configuration and unsafe domains", () => {
    expect(loadCloudflareTunnelConfig({})).toBeUndefined();
    expect(() => loadCloudflareTunnelConfig({ CLOUDFLARE_API_TOKEN: "x" })).toThrow(
      "Missing required",
    );
    expect(() =>
      loadCloudflareTunnelConfig({
        CLOUDFLARE_ACCOUNT_ID: config.accountId,
        CLOUDFLARE_ZONE_ID: config.zoneId,
        CLOUDFLARE_API_TOKEN: "x",
        CLOUDFLARE_TUNNEL_DOMAIN: "https://example.test",
      }),
    ).toThrow("DNS zone");
  });
  it("publishes only the remote ingress and a health path on a validated loopback port", async () => {
    let body: unknown;
    const client = createCloudflareClient(config, async (_url, init) => {
      expect(init?.redirect).toBe("error");
      body = JSON.parse(init!.body as string);
      return result({});
    });
    await client.configure("tunnel-id", "host.example.test", 34567);
    expect(body).toEqual({
      config: {
        ingress: [
          {
            hostname: "host.example.test",
            path: "^/(ws/host/v2|health)$",
            service: "http://127.0.0.1:34567",
          },
          { service: "http_status:404" },
        ],
      },
    });
    await expect(client.configure("id", "host", 80)).rejects.toThrow("400");
  });
  it("refuses a colliding DNS record instead of overwriting it", async () => {
    const client = createCloudflareClient(config, async () =>
      result([
        {
          id: "other",
          name: "host.example.test",
          type: "CNAME",
          content: "other.example.test",
          proxied: true,
        },
      ]),
    );
    await expect(client.ensureDns("host.example.test", "id")).rejects.toThrow("409");
    await expect(client.deleteDns("host.example.test", "id")).rejects.toThrow("409");
  });
  it("does not retain secrets from quota errors or rejected fetches", async () => {
    const cases = [
      {
        status: 429,
        fetcher: async () => new Response("admin-secret connector-secret", { status: 429 }),
      },
      {
        status: 504,
        fetcher: async (): Promise<Response> => {
          throw new Error("admin-secret", { cause: new Error("connector-secret") });
        },
      },
    ];
    for (const { status, fetcher } of cases) {
      const client = createCloudflareClient(config, fetcher);
      const failure: unknown = await client.token("id").catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({
        status,
        message: `Cloudflare tunnel operation failed (${status})`,
      });
      // Error.message, stack and cause are non-enumerable: JSON alone cannot prove redaction.
      expect(failure).not.toHaveProperty("cause");
      for (const secret of ["admin-secret", "connector-secret"]) {
        expect(failure).toHaveProperty("stack", expect.not.stringContaining(secret));
        expect(JSON.stringify(failure)).not.toContain(secret);
      }
    }
  });
});

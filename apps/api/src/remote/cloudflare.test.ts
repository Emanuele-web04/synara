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
    const client = createCloudflareClient(
      config,
      async () => new Response("admin-secret connector-secret", { status: 429 }),
    );
    await expect(client.token("id")).rejects.toThrow("429");
    try {
      await client.token("id");
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain("secret");
    }
    const failed = createCloudflareClient(config, async () => {
      throw new Error("admin-secret");
    });
    await expect(failed.token("id")).rejects.toThrow("504");
  });
});

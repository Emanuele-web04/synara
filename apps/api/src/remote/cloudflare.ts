import type { CloudflareTunnelConfig } from "../config";

/** Never retain response bodies, headers or upstream exceptions in errors/logs. */
export class CloudflareError extends Error {
  constructor(readonly status: number) {
    super(`Cloudflare tunnel operation failed (${status})`);
  }
}

type Tunnel = { id: string; name: string };
type DnsRecord = { id: string; name: string; type: string; content: string; proxied: boolean };

export function createCloudflareClient(
  config: CloudflareTunnelConfig,
  fetcher: (input: string, init: RequestInit) => Promise<Response> = fetch,
) {
  const account = `/accounts/${config.accountId}/cfd_tunnel`;
  const dns = `/zones/${config.zoneId}/dns_records`;
  async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(`https://api.cloudflare.com/client/v4${path}`, {
        method,
        headers: { authorization: `Bearer ${config.apiToken}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new CloudflareError(504);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new CloudflareError(response.status);
    }
    let value: { success?: boolean; result?: T } | null = null;
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new CloudflareError(502);
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 1024 * 1024) throw new CloudflareError(502);
          chunks.push(chunk.value);
        }
        value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } finally {
        await reader.cancel();
      }
    } catch {
      throw new CloudflareError(502);
    }
    if (!value?.success || value.result === undefined) throw new CloudflareError(502);
    return value.result;
  }
  const validId = (id: string) => {
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(id)) throw new CloudflareError(502);
    return id;
  };
  return {
    async findTunnel(name: string): Promise<Tunnel | undefined> {
      const rows = await request<Tunnel[]>(
        `${account}?name=${encodeURIComponent(name)}&is_deleted=false&per_page=100`,
      );
      if (!Array.isArray(rows) || rows.length > 1 || rows.some((row) => row.name !== name))
        throw new CloudflareError(409);
      const row = rows[0];
      if (row) validId(row.id);
      return row;
    },
    async createTunnel(name: string): Promise<Tunnel> {
      const tunnel = await request<Tunnel>(account, "POST", { name, config_src: "cloudflare" });
      if (tunnel.name !== name) throw new CloudflareError(502);
      validId(tunnel.id);
      return { id: tunnel.id, name: tunnel.name };
    },
    async configure(tunnelId: string, hostname: string, port: number) {
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new CloudflareError(400);
      await request(`${account}/${validId(tunnelId)}/configurations`, "PUT", {
        config: {
          ingress: [
            { hostname, path: "^/(ws/host/v2|health)$", service: `http://127.0.0.1:${port}` },
            { service: "http_status:404" },
          ],
        },
      });
    },
    async ensureDns(hostname: string, tunnelId: string): Promise<string> {
      const content = `${validId(tunnelId)}.cfargotunnel.com`;
      const rows = await request<DnsRecord[]>(
        `${dns}?name=${encodeURIComponent(hostname)}&per_page=100`,
      );
      if (!Array.isArray(rows) || rows.length > 1) throw new CloudflareError(409);
      const row = rows[0];
      // Never overwrite an unrelated record, even if its hostname collides.
      if (row) {
        if (
          row.name !== hostname ||
          row.type !== "CNAME" ||
          row.content !== content ||
          !row.proxied
        )
          throw new CloudflareError(409);
        return validId(row.id);
      }
      const created = await request<DnsRecord>(dns, "POST", {
        name: hostname,
        type: "CNAME",
        content,
        proxied: true,
      });
      return validId(created.id);
    },
    async token(tunnelId: string): Promise<string> {
      const token = await request<string>(`${account}/${validId(tunnelId)}/token`);
      if (typeof token !== "string" || token.length < 16 || token.length > 8192)
        throw new CloudflareError(502);
      return token;
    },
    async deleteDns(hostname: string, tunnelId: string) {
      const rows = await request<DnsRecord[]>(
        `${dns}?name=${encodeURIComponent(hostname)}&per_page=100`,
      );
      if (!Array.isArray(rows)) throw new CloudflareError(502);
      for (const row of rows) {
        if (
          row.name !== hostname ||
          row.type !== "CNAME" ||
          row.content !== `${validId(tunnelId)}.cfargotunnel.com`
        )
          throw new CloudflareError(409);
        try {
          await request(`${dns}/${validId(row.id)}`, "DELETE");
        } catch (error) {
          if (!(error instanceof CloudflareError) || error.status !== 404) throw error;
        }
      }
    },
    async deleteTunnel(tunnelId: string) {
      try {
        await request(`${account}/${validId(tunnelId)}`, "DELETE");
      } catch (error) {
        if (!(error instanceof CloudflareError) || error.status !== 404) throw error;
      }
    },
  };
}
export type CloudflareClient = ReturnType<typeof createCloudflareClient>;

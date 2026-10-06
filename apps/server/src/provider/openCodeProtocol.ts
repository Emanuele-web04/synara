/*!
OpenCode v2 protocol adaptations are derived in part from Zeron.

MIT License

Copyright (c) 2026 Wing

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
// Protocol negotiation follows Zeron's authenticated, version-bearing probes.

export interface OpenCodeProtocolInfo {
  readonly protocol: "v1" | "v2";
  readonly version?: string;
}

export class OpenCodeProtocolError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OpenCodeProtocolError";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export async function detectOpenCodeProtocol(input: {
  readonly baseUrl: string;
  readonly directory?: string;
  readonly username?: string;
  readonly password?: string;
  readonly fetch?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly signal?: AbortSignal;
  readonly probeTimeoutMs?: number;
}): Promise<OpenCodeProtocolInfo> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (input.password) {
    headers.Authorization = `Basic ${Buffer.from(`${input.username ?? "opencode"}:${input.password}`, "utf8").toString("base64")}`;
  }
  if (input.directory) headers["x-opencode-directory"] = encodeURIComponent(input.directory);
  const request = input.fetch ?? fetch;
  let lastStatus: number | undefined;
  for (const path of ["/api/info", "/api/status", "/api/health", "/global/health", "/provider"]) {
    input.signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(input.probeTimeoutMs ?? 2_000);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await request(`${input.baseUrl.replace(/\/$/, "")}${path}`, {
        headers,
        signal,
        redirect: "error",
      });
    } catch {
      input.signal?.throwIfAborted();
      continue;
    }
    lastStatus = response.status;
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new OpenCodeProtocolError(
        `OpenCode server rejected its HTTP credentials (HTTP ${response.status}).`,
        response.status,
      );
    }
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
      await response.body?.cancel();
      continue;
    }
    let body: Record<string, unknown> | undefined;
    try {
      body = record(await response.json());
    } catch {
      continue;
    }
    const data = record(body?.data) ?? body;
    if (path === "/provider") {
      if (Array.isArray(data?.all) && record(data?.default) && Array.isArray(data?.connected)) {
        return { protocol: "v1" };
      }
    } else if (typeof data?.version === "string" && data.version.trim().length > 0) {
      return {
        protocol: path.startsWith("/api/") ? "v2" : "v1",
        version: data.version.trim(),
      };
    }
  }
  throw new OpenCodeProtocolError(
    `OpenCode server did not expose a supported JSON API (${lastStatus === undefined ? "unreachable" : `last HTTP ${lastStatus}`}).`,
    lastStatus,
  );
}

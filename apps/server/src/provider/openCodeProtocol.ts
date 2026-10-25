/** Detect the server contract before sending any mutating provider request. */
export async function detectOpenCodeProtocol(input: {
  readonly baseUrl: string;
  readonly headers?: RequestInit["headers"];
  readonly signal?: AbortSignal | undefined;
  readonly fetch?: ((url: string, init?: RequestInit) => Promise<Response>) | undefined;
}): Promise<"v1" | "v2"> {
  const request = input.fetch ?? globalThis.fetch;
  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(5_000)])
    : AbortSignal.timeout(5_000);
  const response = await request(`${input.baseUrl.replace(/\/$/, "")}/api/info`, {
    headers: input.headers,
    signal,
  });
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new Error(`OpenCode rejected the server password (HTTP ${response.status}).`);
  }
  if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
    const info: unknown = await response.json();
    if (
      info !== null &&
      typeof info === "object" &&
      "version" in info &&
      typeof info.version === "string" &&
      "pid" in info &&
      typeof info.pid === "number" &&
      "urls" in info &&
      Array.isArray(info.urls)
    )
      return "v2";
    throw new Error("OpenCode returned an invalid server info response.");
  }
  await response.body?.cancel();
  if (!response.ok && response.status !== 404 && response.status !== 405) {
    throw new Error(`OpenCode server info failed (HTTP ${response.status}).`);
  }
  // V1 serves its HTML app for unknown paths. The provider endpoint is checked
  // separately by startup; never retry a mutation against a different API.
  return "v1";
}

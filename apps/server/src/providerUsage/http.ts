// FILE: providerUsage/http.ts
// Purpose: Thin JSON-over-HTTP helper for usage fetchers, built on the global fetch (Bun/Node 24,
// no extra dependency). Adds a hard timeout and tolerates non-JSON bodies.

export interface FetchJsonResult {
  readonly status: number;
  readonly ok: boolean;
  readonly json: unknown;
  readonly headers: Headers;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function fetchJson(input: {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}): Promise<FetchJsonResult> {
  const response = await fetch(input.url, {
    method: input.method ?? "GET",
    headers: input.headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }

  return { status: response.status, ok: response.ok, json, headers: response.headers };
}

/** Provider backends reject the access token once it is stale; treat that as "needs re-auth". */
export function isAuthFailureStatus(status: number): boolean {
  return status === 401 || status === 403;
}

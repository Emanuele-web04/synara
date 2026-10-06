export type OpenCodeV2Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface OpenCodeV2ClientOptions {
  readonly baseUrl: string;
  readonly directory?: string;
  readonly username?: string;
  readonly password?: string;
  readonly version?: string;
  readonly fetch?: OpenCodeV2Fetch;
}

export interface OpenCodeV2HttpContext {
  readonly baseUrl: string;
  readonly headers: Headers;
  readonly fetch: OpenCodeV2Fetch;
}

export function createOpenCodeV2HttpContext(input: OpenCodeV2ClientOptions): OpenCodeV2HttpContext {
  const headers = new Headers({ accept: "application/json" });
  if (input.directory) headers.set("x-opencode-directory", encodeURIComponent(input.directory));
  if (input.password) {
    headers.set(
      "authorization",
      `Basic ${Buffer.from(`${input.username ?? "opencode"}:${input.password}`).toString("base64")}`,
    );
  }
  return {
    baseUrl: input.baseUrl.replace(/\/$/, ""),
    headers,
    fetch: input.fetch ?? globalThis.fetch,
  };
}

export function openCodeV2Object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function unwrapOpenCodeV2Data(value: unknown): unknown {
  const object = openCodeV2Object(value);
  return Object.hasOwn(object, "data") ? object.data : value;
}

export async function requestOpenCodeV2(
  http: OpenCodeV2HttpContext,
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal | null,
  directory?: string,
  preserveEnvelope = false,
  timeout = true,
): Promise<unknown> {
  const headers = new Headers(http.headers);
  if (directory) headers.set("x-opencode-directory", encodeURIComponent(directory));
  if (body !== undefined) headers.set("content-type", "application/json");
  const requestSignal = timeout
    ? AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)])
    : signal;
  const response = await http.fetch(`${http.baseUrl}${path}`, {
    method,
    headers,
    redirect: "error",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(requestSignal ? { signal: requestSignal } : {}),
  });
  if (!response.ok)
    throw new Error(
      `OpenCode v2 ${method} ${path.split("?")[0]} failed (HTTP ${response.status}).`,
    );
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return preserveEnvelope ? value : unwrapOpenCodeV2Data(value);
  } catch {
    throw new Error(`OpenCode v2 ${method} ${path.split("?")[0]} returned invalid JSON.`);
  }
}

/** 2.0.4 renamed permission reply and command name fields. Unknown versions use current schema. */
export function usesCurrentOpenCodeV2Fields(version?: string): boolean {
  if (!version) return true;
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return true;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major > 2 || (major === 2 && (minor > 0 || patch >= 4));
}

export function sessionPath(id: string, suffix = "") {
  return `/api/session/${encodeURIComponent(id)}${suffix}`;
}

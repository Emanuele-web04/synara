export const DEFAULT_SERVER_STATUS_URL = "http://127.0.0.1:3773";
const DEFAULT_SERVER_STATUS_TIMEOUT_MS = 3_000;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SynaraServerHealthSnapshot {
  readonly status: string;
  readonly startupReady: boolean;
  readonly pushBusReady?: boolean;
  readonly keybindingsReady?: boolean;
  readonly terminalSubscriptionsReady?: boolean;
  readonly orchestrationSubscriptionsReady?: boolean;
  readonly projection?: {
    readonly state?: string;
    readonly inFlight?: boolean;
    readonly retryAttempts?: number;
    readonly hasFailure?: boolean;
    readonly highWaterSequence?: number;
    readonly lagByProjector?: unknown;
    readonly missingProjectors?: unknown;
  };
}

export type SynaraServerStatusResult =
  | {
      readonly reachable: true;
      readonly ready: boolean;
      readonly url: string;
      readonly health: SynaraServerHealthSnapshot;
    }
  | {
      readonly reachable: false;
      readonly ready: false;
      readonly url: string;
      readonly error: string;
    };

export interface FetchSynaraServerStatusOptions {
  readonly url?: string;
  readonly timeoutMs?: number;
  readonly fetch?: FetchLike;
}

function healthUrlFromBaseUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Server URL must use http:// or https://.");
  }
  url.pathname = "/health";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function decodeHealthSnapshot(value: unknown): SynaraServerHealthSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const snapshot = value as Record<string, unknown>;
  if (typeof snapshot.status !== "string" || typeof snapshot.startupReady !== "boolean") {
    return null;
  }
  return snapshot as unknown as SynaraServerHealthSnapshot;
}

export async function fetchSynaraServerStatus(
  options: FetchSynaraServerStatusOptions = {},
): Promise<SynaraServerStatusResult> {
  const rawUrl = options.url ?? DEFAULT_SERVER_STATUS_URL;
  let healthUrl: string;
  try {
    healthUrl = healthUrlFromBaseUrl(rawUrl);
  } catch (cause) {
    return {
      reachable: false,
      ready: false,
      url: rawUrl,
      error: cause instanceof Error ? cause.message : "Invalid server URL.",
    };
  }

  const request: FetchLike = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SERVER_STATUS_TIMEOUT_MS;
  try {
    const response = await request(healthUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      return {
        reachable: false,
        ready: false,
        url: rawUrl,
        error: `Health request returned HTTP ${String(response.status)}.`,
      };
    }

    const health = decodeHealthSnapshot(await response.json());
    if (!health) {
      return {
        reachable: false,
        ready: false,
        url: rawUrl,
        error: "Health response did not match the Synara health shape.",
      };
    }

    return {
      reachable: true,
      ready:
        health.status === "ok" && health.startupReady && health.projection?.state === "healthy",
      url: rawUrl,
      health,
    };
  } catch (cause) {
    return {
      reachable: false,
      ready: false,
      url: rawUrl,
      error: cause instanceof Error ? cause.message : "Health request failed.",
    };
  }
}

export function formatSynaraServerStatus(result: SynaraServerStatusResult): string {
  if (!result.reachable) {
    return `Synara server: unreachable\nURL: ${result.url}\nError: ${result.error}`;
  }

  const projectionState = result.health.projection?.state;
  return [
    `Synara server: ${result.ready ? "ready" : "starting"}`,
    `URL: ${result.url}`,
    ...(projectionState ? [`Projection: ${projectionState}`] : []),
  ].join("\n");
}

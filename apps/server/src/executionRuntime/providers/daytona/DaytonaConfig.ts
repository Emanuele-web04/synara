/**
 * Daytona credential + endpoint configuration, resolved from the environment.
 *
 * The real Daytona REST client is gated behind credentials: when `DAYTONA_API_KEY`
 * is absent the adapter falls back to the in-repo fake sandbox client (local temp
 * dirs + locally forwarded processes), so the baseline contract suite runs in CI
 * without provider access. When the key is present, the same contract suite opts
 * in to the real provider.
 *
 * Env vars (all optional except the key, which gates the real path):
 *   - DAYTONA_API_KEY        — bearer token; presence selects the real client.
 *   - DAYTONA_API_URL        — REST base, default `https://app.daytona.io/api`.
 *   - DAYTONA_TARGET         — region/target hint passed at create (optional).
 *   - DAYTONA_ORGANIZATION_ID — org scope header (optional).
 *   - DAYTONA_SNAPSHOT       — base image/snapshot for new sandboxes (optional).
 *   - DAYTONA_PTY_TRANSPORT  — `1`/`true` to prefer the real-time PTY WebSocket
 *                              session transport; any WS failure falls back to
 *                              the polling transport (the working default).
 *
 * @module daytona/DaytonaConfig
 */

export interface DaytonaCredentials {
  readonly apiKey: string;
  readonly apiUrl: string;
  readonly target: string | undefined;
  readonly organizationId: string | undefined;
  readonly snapshot: string | undefined;
  /**
   * Prefer the duplex PTY WebSocket session transport over the logs-polling
   * default. Off unless explicitly enabled, so the working polling path stays
   * the default until the PTY transport is proven in production.
   */
  readonly ptyTransport: boolean;
}

const DEFAULT_API_URL = "https://app.daytona.io/api";

const trimmedEnv = (env: Record<string, string | undefined>, key: string): string | undefined => {
  const value = env[key];
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

const flagEnv = (env: Record<string, string | undefined>, key: string): boolean => {
  const value = trimmedEnv(env, key)?.toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
};

/**
 * Resolve Daytona credentials from an environment map. Returns `null` when no API
 * key is configured — the signal to use the fake client. Defaulting `process.env`
 * keeps callers terse while staying injectable for tests.
 */
export const resolveDaytonaCredentials = (
  env: Record<string, string | undefined> = process.env,
): DaytonaCredentials | null => {
  const apiKey = trimmedEnv(env, "DAYTONA_API_KEY");
  if (apiKey === undefined) {
    return null;
  }
  return {
    apiKey,
    apiUrl: trimmedEnv(env, "DAYTONA_API_URL") ?? DEFAULT_API_URL,
    target: trimmedEnv(env, "DAYTONA_TARGET"),
    organizationId: trimmedEnv(env, "DAYTONA_ORGANIZATION_ID"),
    snapshot: trimmedEnv(env, "DAYTONA_SNAPSHOT"),
    ptyTransport: flagEnv(env, "DAYTONA_PTY_TRANSPORT"),
  };
};

/** Whether real Daytona credentials are present in the environment. */
export const daytonaCredentialsConfigured = (
  env: Record<string, string | undefined> = process.env,
): boolean => resolveDaytonaCredentials(env) !== null;

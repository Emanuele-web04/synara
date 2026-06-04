/**
 * Vercel Sandbox credential + endpoint configuration, resolved from the
 * environment.
 *
 * The real `@vercel/sandbox` client is gated behind credentials: when any of
 * the required `VERCEL_*` vars is absent the adapter falls back to the in-repo
 * fake client (local temp dirs + local processes), so the baseline contract
 * suite runs in CI without provider access. When all are present, the same
 * contract suite opts in to the real provider.
 *
 * Env vars:
 *   - VERCEL_TOKEN          — auth token; required for the real client.
 *   - VERCEL_TEAM_ID        — team scope; required.
 *   - VERCEL_PROJECT_ID     — project scope; required.
 *   - VERCEL_SANDBOX_RUNTIME — runtime image (e.g. `node24`); optional.
 *
 * @module vercelSandbox/VercelSandboxConfig
 */

export interface VercelSandboxCredentials {
  readonly token: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly runtime: string | undefined;
}

const trimmedEnv = (env: Record<string, string | undefined>, key: string): string | undefined => {
  const value = env[key];
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

/**
 * Resolve Vercel Sandbox credentials from an environment map. Returns `null`
 * when any required var is missing — the signal to use the fake client.
 * Defaulting `process.env` keeps callers terse while staying injectable for
 * tests.
 */
export const resolveVercelSandboxCredentials = (
  env: Record<string, string | undefined> = process.env,
): VercelSandboxCredentials | null => {
  const token = trimmedEnv(env, "VERCEL_TOKEN");
  const teamId = trimmedEnv(env, "VERCEL_TEAM_ID");
  const projectId = trimmedEnv(env, "VERCEL_PROJECT_ID");
  if (token === undefined || teamId === undefined || projectId === undefined) {
    return null;
  }
  return {
    token,
    teamId,
    projectId,
    runtime: trimmedEnv(env, "VERCEL_SANDBOX_RUNTIME"),
  };
};

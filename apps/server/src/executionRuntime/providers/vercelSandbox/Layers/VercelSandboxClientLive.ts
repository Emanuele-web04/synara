/**
 * VercelSandboxClientLive - credential-gated selection of the Vercel Sandbox
 * client.
 *
 * Real Vercel Sandbox API calls require credentials. When the required env vars
 * are present `runtimeLayer` resolves the real `@vercel/sandbox`-backed client;
 * otherwise it falls back to the in-memory fake so the contract suite and any
 * local/CI run work without touching the provider. The real client loads
 * `@vercel/sandbox` lazily (it is an optional dependency, not installed in this
 * slice): a credentialed run without the package installed fails loudly at the
 * SDK load rather than silently using the fake.
 *
 * This module owns only the credential predicate and the default client layer;
 * the env-driven real-vs-fake selection lives in `runtimeLayer`.
 *
 * @module VercelSandboxClientLive
 */
import { resolveVercelSandboxCredentials } from "./VercelSandboxConfig.ts";
import { makeHttpVercelSandboxClientLive } from "./HttpVercelSandboxClient.ts";
import { FakeVercelSandboxClientLive } from "./FakeVercelSandboxClient.ts";

/** Env vars that, when all present, select the real (credentialed) client. */
export const VERCEL_SANDBOX_CREDENTIAL_ENV = [
  "VERCEL_TOKEN",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
] as const;

/** Whether real Vercel Sandbox credentials are present in the environment. */
export const hasVercelSandboxCredentials = (
  env: Record<string, string | undefined> = process.env,
): boolean => resolveVercelSandboxCredentials(env) !== null;

/**
 * The Vercel Sandbox client layer for the given environment: the real
 * `@vercel/sandbox`-backed client when the credentials are present, else the
 * fake. The real layer needs no Effect requirements, so the union with the fake
 * is the fake's requirements (`ChildProcessSpawner` + `FileSystem`).
 */
export const selectVercelSandboxClientLive = (
  env: Record<string, string | undefined> = process.env,
) => {
  const credentials = resolveVercelSandboxCredentials(env);
  return credentials === null
    ? FakeVercelSandboxClientLive
    : makeHttpVercelSandboxClientLive(credentials);
};

/** Default client layer resolved from `process.env`. */
export const VercelSandboxClientLive = selectVercelSandboxClientLive();

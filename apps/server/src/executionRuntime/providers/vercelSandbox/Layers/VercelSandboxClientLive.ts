/**
 * VercelSandboxClientLive - credential-gated selection of the Vercel Sandbox
 * client.
 *
 * Real Vercel Sandbox API calls require credentials. When the required env vars
 * are present this resolves the real client; otherwise it falls back to the
 * in-memory fake so the contract suite and any local/CI run work without
 * touching the provider. The real client is not wired to the `@vercel/sandbox`
 * SDK yet (the dependency is intentionally not added in this slice); until it is,
 * `realVercelSandboxClientUnavailable` documents exactly what is missing and a
 * real-credential run fails loudly rather than silently using the fake.
 *
 * The split keeps the adapter and the contract tests provider-call-free in CI
 * while leaving a single, obvious seam to drop the SDK into.
 *
 * @module VercelSandboxClientLive
 */
import { Effect, Layer } from "effect";

import { VercelSandboxClient } from "../Services/VercelSandboxClient.ts";
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
): boolean => VERCEL_SANDBOX_CREDENTIAL_ENV.every((key) => (env[key] ?? "").trim().length > 0);

/**
 * The real client is not implemented in this slice. A credentialed run reaches
 * this layer, which fails at acquisition so the gap is loud, not a silent
 * fallback to local temp dirs that would mask a missing remote integration.
 */
export const realVercelSandboxClientUnavailable = Layer.effect(
  VercelSandboxClient,
  Effect.die(
    new Error(
      "Real Vercel Sandbox client is not implemented yet: add the @vercel/sandbox " +
        "integration behind VercelSandboxClient. Unset the VERCEL_* credentials to " +
        "use the in-memory fake.",
    ),
  ),
);

/**
 * Select the client by credential presence. Credentialed environments get the
 * (currently unimplemented) real client; everything else gets the fake. The
 * real layer needs no requirements, so the union of the two is the fake's
 * requirements (`ChildProcessSpawner` + `FileSystem`).
 */
export const VercelSandboxClientLive = hasVercelSandboxCredentials()
  ? realVercelSandboxClientUnavailable
  : FakeVercelSandboxClientLive;

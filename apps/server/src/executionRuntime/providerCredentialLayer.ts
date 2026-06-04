/**
 * providerCredentialLayer - shared seam for building a provider's client/connection
 * layer from a resolved credential env.
 *
 * Each runtime provider selects its real-vs-fake backing from an env map. Two
 * sources feed that map:
 *
 *   - an explicit `{ env }` override (contract/e2e tests), which pins a fixed
 *     environment and bypasses the credential service entirely, so the test layer
 *     has no `RuntimeProviderCredentials` requirement; or
 *   - the merged env from {@link RuntimeProviderCredentials} (settings + stored
 *     secrets over `process.env`), read at layer build, so a key entered in
 *     Settings selects the real backend on the next read.
 *
 * `buildProviderLayerFromEnv` centralizes that branch and its precise `RIn`
 * typing via overloads, so each provider's `runtimeLayer` stays a one-liner that
 * maps an env to its layer.
 *
 * @module providerCredentialLayer
 */
import { Effect, Layer } from "effect";

import {
  RuntimeProviderCredentials,
  type CredentialedRuntimeProvider,
} from "./Services/RuntimeProviderCredentials.ts";

/** Test override: pin a fixed env and skip the credential service. */
export interface RuntimeProviderEnvOptions {
  readonly env?: Record<string, string | undefined>;
}

/**
 * Build a provider layer from a resolved env. With an explicit `env` the result
 * carries no `RuntimeProviderCredentials` requirement; without it, the env is
 * resolved from the service (falling back to `process.env` if resolution fails),
 * and `RuntimeProviderCredentials` joins the layer's `RIn`.
 */
export function buildProviderLayerFromEnv<A, RIn>(
  provider: CredentialedRuntimeProvider,
  options: { readonly env: Record<string, string | undefined> },
  layerForEnv: (env: Record<string, string | undefined>) => Layer.Layer<A, never, RIn>,
): Layer.Layer<A, never, RIn>;
export function buildProviderLayerFromEnv<A, RIn>(
  provider: CredentialedRuntimeProvider,
  options: RuntimeProviderEnvOptions | undefined,
  layerForEnv: (env: Record<string, string | undefined>) => Layer.Layer<A, never, RIn>,
): Layer.Layer<A, never, RIn | RuntimeProviderCredentials>;
export function buildProviderLayerFromEnv<A, RIn>(
  provider: CredentialedRuntimeProvider,
  options: RuntimeProviderEnvOptions | undefined,
  layerForEnv: (env: Record<string, string | undefined>) => Layer.Layer<A, never, RIn>,
): Layer.Layer<A, never, RIn | RuntimeProviderCredentials> {
  if (options?.env !== undefined) {
    return layerForEnv(options.env);
  }
  return Layer.unwrap(
    Effect.gen(function* () {
      const credentials = yield* RuntimeProviderCredentials;
      const env = yield* credentials.envFor(provider).pipe(Effect.orElseSucceed(() => process.env));
      return layerForEnv(env);
    }),
  );
}

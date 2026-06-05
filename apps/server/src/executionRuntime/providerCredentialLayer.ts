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
 *     secrets over `process.env`), so a key entered in Settings selects the real
 *     backend on the next provision.
 *
 * Two build strategies share this seam:
 *
 *   - {@link buildProviderLayerFromEnv} resolves the env once at layer build and
 *     picks the backing layer from it. Used where the choice is fixed for the
 *     layer's lifetime (e.g. a connection whose `Config` is read at build).
 *   - {@link buildPerProvisionClientLayer} provides both backings plus a per-call
 *     env resolver, so the real-vs-fake choice happens on each provision rather
 *     than once at boot — a key saved in Settings takes effect with no restart.
 *
 * Both centralize the credential branch and its precise `RIn` typing via
 * overloads, so each provider's `runtimeLayer` stays terse.
 *
 * @module providerCredentialLayer
 */
import { Effect, Layer } from "effect";
import type { ServiceMap } from "effect";

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

/**
 * Resolve the credential env for one provision: the fixed override when present,
 * else the merged env from {@link RuntimeProviderCredentials} with `process.env`
 * as the fallback. The resolver is rerun on every provision so a Settings change
 * is reflected without a restart.
 */
export type ResolveProvisionEnv = Effect.Effect<Record<string, string | undefined>>;

/**
 * Build a provider client layer whose real-vs-fake choice happens per provision.
 *
 * Unlike {@link buildProviderLayerFromEnv} (which resolves once at layer build),
 * this hands `build` a `resolveEnv` effect that re-resolves the credential env on
 * each call, so the dispatching client `build` produces can pick the backing
 * client fresh per provision. With an explicit `env` override the resolver is a
 * constant and the result carries no `RuntimeProviderCredentials` requirement;
 * without it, the resolver reads {@link RuntimeProviderCredentials} and that
 * service joins the layer's `RIn`.
 *
 * `build` runs with both backings' service dependencies (`RIn`) in context, so it
 * can construct the real and fake clients eagerly and switch between them per
 * call from `resolveEnv`.
 */
export function buildPerProvisionClientLayer<I, S, E, RIn>(
  service: ServiceMap.Key<I, S>,
  options: { readonly env: Record<string, string | undefined> },
  build: (resolveEnv: ResolveProvisionEnv) => Effect.Effect<S, E, RIn>,
): Layer.Layer<I, E, RIn>;
export function buildPerProvisionClientLayer<I, S, E, RIn>(
  service: ServiceMap.Key<I, S>,
  provider: CredentialedRuntimeProvider,
  options: RuntimeProviderEnvOptions | undefined,
  build: (resolveEnv: ResolveProvisionEnv) => Effect.Effect<S, E, RIn>,
): Layer.Layer<I, E, RIn | RuntimeProviderCredentials>;
export function buildPerProvisionClientLayer<I, S, E, RIn>(
  service: ServiceMap.Key<I, S>,
  providerOrOptions:
    | CredentialedRuntimeProvider
    | { readonly env: Record<string, string | undefined> },
  optionsOrBuild:
    | RuntimeProviderEnvOptions
    | undefined
    | ((resolveEnv: ResolveProvisionEnv) => Effect.Effect<S, E, RIn>),
  maybeBuild?: (resolveEnv: ResolveProvisionEnv) => Effect.Effect<S, E, RIn>,
): Layer.Layer<I, E, RIn | RuntimeProviderCredentials> {
  // Overload 1: (service, { env }, build) — fixed override, no credential service.
  if (typeof providerOrOptions === "object") {
    const env = providerOrOptions.env;
    const build = optionsOrBuild as (resolveEnv: ResolveProvisionEnv) => Effect.Effect<S, E, RIn>;
    return Layer.effect(service, build(Effect.succeed(env)));
  }
  // Overload 2: (service, provider, options, build).
  const provider = providerOrOptions;
  const options = optionsOrBuild as RuntimeProviderEnvOptions | undefined;
  const build = maybeBuild as (resolveEnv: ResolveProvisionEnv) => Effect.Effect<S, E, RIn>;
  if (options?.env !== undefined) {
    const env = options.env;
    return Layer.effect(service, build(Effect.succeed(env)));
  }
  return Layer.effect(
    service,
    Effect.gen(function* () {
      const credentials = yield* RuntimeProviderCredentials;
      const resolveEnv: ResolveProvisionEnv = credentials
        .envFor(provider)
        .pipe(Effect.orElseSucceed(() => process.env));
      return yield* build(resolveEnv);
    }),
  );
}

/**
 * Daytona runtime wiring.
 *
 * Selects the sandbox client by the resolved credential env, per provision: with
 * `DAYTONA_API_KEY` present the real REST client is used; otherwise the fake
 * (local temp dirs) client backs the adapter, so the server boots and the
 * baseline contract suite run without provider access. The adapter shape is
 * identical either way.
 *
 * The selection happens on each `create` (not once at layer build) via the
 * dispatching client, so a key entered in Settings selects the real client on the
 * next provision with no server restart. Subsequent calls for a sandbox stay on
 * the backend that created it. An explicit `env` override (contract tests)
 * bypasses the credential service and pins a fixed environment.
 *
 * @module daytona/runtimeLayer
 */
import { Layer } from "effect";

import {
  buildPerProvisionClientLayer,
  type RuntimeProviderEnvOptions,
} from "../../providerCredentialLayer.ts";
import type { RuntimeProviderCredentials } from "../../Services/RuntimeProviderCredentials.ts";
import { DaytonaRuntimeAdapter } from "./DaytonaRuntimeAdapter.ts";
import { makeDaytonaRuntimeAdapterServiceLive } from "./DaytonaRuntimeAdapter.ts";
import { DaytonaSandboxClient } from "./DaytonaSandboxClient.ts";
import {
  makeDispatchingDaytonaSandboxClient,
  type DispatchingDaytonaSandboxClientServices,
} from "./DispatchingDaytonaSandboxClient.ts";

/**
 * Dependencies the per-provision dispatching client requires: the real client's
 * `HttpClient` and the fake client's `FileSystem` + `ChildProcessSpawner`. The
 * layer's `RIn` is the union so both backings unify under one type and the caller
 * provides whichever services the resolved environment uses.
 */
type DaytonaClientServices = DispatchingDaytonaSandboxClientServices;

export interface DaytonaRuntimeLayerOptions {
  /**
   * Override the environment used to resolve credentials (tests). When set, the
   * layer pins this env and does not consult {@link RuntimeProviderCredentials}.
   */
  readonly env?: Record<string, string | undefined>;
}

/**
 * The Daytona sandbox client layer. With an explicit `env` override it resolves
 * synchronously from that env on each provision; otherwise each provision resolves
 * the merged env (settings + secrets over `process.env`) from
 * {@link RuntimeProviderCredentials} and selects the real or fake client from it.
 */
export function makeDaytonaSandboxClientLayer(options: {
  readonly env: Record<string, string | undefined>;
}): Layer.Layer<DaytonaSandboxClient, never, DaytonaClientServices>;
export function makeDaytonaSandboxClientLayer(
  options?: DaytonaRuntimeLayerOptions,
): Layer.Layer<DaytonaSandboxClient, never, DaytonaClientServices | RuntimeProviderCredentials>;
export function makeDaytonaSandboxClientLayer(
  options?: DaytonaRuntimeLayerOptions,
): Layer.Layer<DaytonaSandboxClient, never, DaytonaClientServices | RuntimeProviderCredentials> {
  // An explicit env override pins the env and carries no credential-service
  // requirement (contract tests run with just NodeServices + HttpClient). Routing
  // it through the override overload keeps `RuntimeProviderCredentials` out of the
  // resolved `RIn`.
  if (options?.env !== undefined) {
    return buildPerProvisionClientLayer(
      DaytonaSandboxClient,
      { env: options.env },
      makeDispatchingDaytonaSandboxClient,
    );
  }
  return buildPerProvisionClientLayer(
    DaytonaSandboxClient,
    "daytona",
    options as RuntimeProviderEnvOptions | undefined,
    makeDispatchingDaytonaSandboxClient,
  );
}

/** The Daytona adapter backed by the credential-selected sandbox client. */
export function makeDaytonaRuntimeAdapterLayer(options: {
  readonly env: Record<string, string | undefined>;
}): Layer.Layer<DaytonaRuntimeAdapter, never, DaytonaClientServices>;
export function makeDaytonaRuntimeAdapterLayer(
  options?: DaytonaRuntimeLayerOptions,
): Layer.Layer<DaytonaRuntimeAdapter, never, DaytonaClientServices | RuntimeProviderCredentials>;
export function makeDaytonaRuntimeAdapterLayer(
  options?: DaytonaRuntimeLayerOptions,
): Layer.Layer<DaytonaRuntimeAdapter, never, DaytonaClientServices | RuntimeProviderCredentials> {
  // Thread the override env (when present) into the adapter so the host Codex
  // auth used for sandbox injection is resolved from the same env that selects
  // the real-vs-fake client; production passes the merged settings/secrets env.
  const adapterLayer =
    options?.env === undefined
      ? makeDaytonaRuntimeAdapterServiceLive()
      : makeDaytonaRuntimeAdapterServiceLive({ env: options.env });
  return adapterLayer.pipe(Layer.provide(makeDaytonaSandboxClientLayer(options)));
}

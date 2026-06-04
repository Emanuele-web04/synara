/**
 * Daytona runtime wiring.
 *
 * Selects the sandbox client by the resolved credential env: with `DAYTONA_API_KEY`
 * present the real REST client is used; otherwise the fake (local temp dirs) client
 * backs the adapter, so the server boots and the baseline contract suite runs
 * without provider access. The adapter shape is identical either way.
 *
 * Credential resolution prefers Settings over `process.env`: when no explicit
 * `env` override is passed, the layer reads the merged env from
 * {@link RuntimeProviderCredentials} (settings + stored secrets over
 * `process.env`), so a key entered in Settings selects the real client without a
 * server restart. An explicit `env` override (contract tests) bypasses the service
 * and pins a fixed environment.
 *
 * @module daytona/runtimeLayer
 */
import { Layer } from "effect";
import type { FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type { HttpClient } from "effect/unstable/http";

import { buildProviderLayerFromEnv } from "../../providerCredentialLayer.ts";
import type { RuntimeProviderCredentials } from "../../Services/RuntimeProviderCredentials.ts";
import { resolveDaytonaCredentials } from "./DaytonaConfig.ts";
import { DaytonaRuntimeAdapter } from "./DaytonaRuntimeAdapter.ts";
import { DaytonaRuntimeAdapterLive } from "./DaytonaRuntimeAdapter.ts";
import { DaytonaSandboxClient } from "./DaytonaSandboxClient.ts";
import { FakeDaytonaSandboxClientLive } from "./FakeDaytonaSandboxClient.ts";
import { makeHttpDaytonaSandboxClientLive } from "./HttpDaytonaSandboxClient.ts";

/**
 * Dependencies either sandbox-client branch may require: the fake client needs
 * `FileSystem` + `ChildProcessSpawner`; the real client needs `HttpClient`. The
 * layer's `RIn` is widened to the union so both branches unify under one type and
 * the caller provides whichever services the resolved environment uses.
 */
type DaytonaClientServices =
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient;

export interface DaytonaRuntimeLayerOptions {
  /**
   * Override the environment used to resolve credentials (tests). When set, the
   * layer pins this env and does not consult {@link RuntimeProviderCredentials}.
   */
  readonly env?: Record<string, string | undefined>;
}

const clientLayerForEnv = (
  env: Record<string, string | undefined>,
): Layer.Layer<DaytonaSandboxClient, never, DaytonaClientServices> => {
  const credentials = resolveDaytonaCredentials(env);
  return credentials === null
    ? FakeDaytonaSandboxClientLive
    : makeHttpDaytonaSandboxClientLive(credentials);
};

/**
 * The Daytona sandbox client layer. With an explicit `env` override it resolves
 * synchronously from that env; otherwise it resolves the merged env (settings +
 * secrets over `process.env`) from {@link RuntimeProviderCredentials} and selects
 * the real or fake client from it.
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
  return buildProviderLayerFromEnv("daytona", options, clientLayerForEnv);
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
  return DaytonaRuntimeAdapterLive.pipe(Layer.provide(makeDaytonaSandboxClientLayer(options)));
}

/**
 * Modal runtime wiring.
 *
 * Selects the command backend by the resolved credential env: with `MODAL_TOKEN_ID`
 * / `MODAL_TOKEN_SECRET` present the real Modal CLI backend is used; otherwise the
 * fake (local temp dirs + local processes) backend backs the adapter, so the
 * server boots and the baseline contract suite runs without provider access. The
 * adapter shape is identical either way.
 *
 * Credential resolution prefers Settings over `process.env`: when no explicit
 * `env` override is passed, the layer reads the merged env from
 * {@link RuntimeProviderCredentials} (settings + stored secrets over
 * `process.env`), so a token entered in Settings selects the real backend without
 * a server restart. An explicit `env` override (contract tests) pins a fixed env.
 *
 * @module modal/runtimeLayer
 */
import { Layer } from "effect";
import type { FileSystem } from "effect";

import { buildProviderLayerFromEnv } from "../../providerCredentialLayer.ts";
import type { RuntimeProviderCredentials } from "../../Services/RuntimeProviderCredentials.ts";
import { makeModalCommandClientLive } from "./ModalCommandClient.ts";
import { resolveModalCredentials } from "./ModalCredentials.ts";
import {
  ModalRuntimeProviderAdapter,
  ModalRuntimeProviderAdapterLive,
} from "./ModalRuntimeProviderAdapter.ts";

export interface ModalRuntimeLayerOptions {
  /**
   * Override the environment used to resolve credentials (tests). When set, the
   * layer pins this env and does not consult {@link RuntimeProviderCredentials}.
   */
  readonly env?: Record<string, string | undefined>;
}

const adapterLayerForEnv = (
  env: Record<string, string | undefined>,
): Layer.Layer<ModalRuntimeProviderAdapter, never, FileSystem.FileSystem> => {
  const credentials = resolveModalCredentials(env);
  return ModalRuntimeProviderAdapterLive.pipe(
    Layer.provide(makeModalCommandClientLive({ credentials })),
  );
};

/**
 * The Modal adapter backed by the credential-selected command backend. Both the
 * real and fake backends provision their staging/working root through
 * `FileSystem`, so that is the layer's only client requirement; the
 * `ChildProcessSpawner` exec/transport ops need is supplied at call time by the
 * service's runtime.
 */
export function makeModalRuntimeAdapterLayer(options: {
  readonly env: Record<string, string | undefined>;
}): Layer.Layer<ModalRuntimeProviderAdapter, never, FileSystem.FileSystem>;
export function makeModalRuntimeAdapterLayer(
  options?: ModalRuntimeLayerOptions,
): Layer.Layer<
  ModalRuntimeProviderAdapter,
  never,
  FileSystem.FileSystem | RuntimeProviderCredentials
>;
export function makeModalRuntimeAdapterLayer(
  options?: ModalRuntimeLayerOptions,
): Layer.Layer<
  ModalRuntimeProviderAdapter,
  never,
  FileSystem.FileSystem | RuntimeProviderCredentials
> {
  return buildProviderLayerFromEnv("modal", options, adapterLayerForEnv);
}

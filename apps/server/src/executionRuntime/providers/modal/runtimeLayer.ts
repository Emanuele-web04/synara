/**
 * Modal runtime wiring.
 *
 * Selects the command backend by environment: with `MODAL_TOKEN_ID` /
 * `MODAL_TOKEN_SECRET` present the real Modal CLI backend is used; otherwise the
 * fake (local temp dirs + local processes) backend backs the adapter, so the
 * server boots and the baseline contract suite runs without provider access. The
 * adapter shape is identical either way.
 *
 * @module modal/runtimeLayer
 */
import { Layer } from "effect";
import type { FileSystem } from "effect";

import { makeModalCommandClientLive } from "./ModalCommandClient.ts";
import type { ModalCredentials } from "./ModalCredentials.ts";
import { resolveModalCredentials } from "./ModalCredentials.ts";
import {
  ModalRuntimeProviderAdapter,
  ModalRuntimeProviderAdapterLive,
} from "./ModalRuntimeProviderAdapter.ts";

export interface ModalRuntimeLayerOptions {
  /** Override the environment used to resolve credentials (tests). */
  readonly env?: Record<string, string | undefined>;
}

/**
 * The Modal adapter backed by the environment-selected command backend. Both the
 * real and fake backends provision their staging/working root through
 * `FileSystem`, so that is the layer's only build-time requirement; the
 * `ChildProcessSpawner` exec/transport ops need is supplied at call time by the
 * service's runtime. Credential presence picks the backend once at build time.
 */
export const makeModalRuntimeAdapterLayer = (
  options?: ModalRuntimeLayerOptions,
): Layer.Layer<ModalRuntimeProviderAdapter, never, FileSystem.FileSystem> => {
  const credentials: ModalCredentials | null = resolveModalCredentials(options?.env ?? process.env);
  const commandClientLayer = makeModalCommandClientLive({ credentials });
  return ModalRuntimeProviderAdapterLive.pipe(Layer.provide(commandClientLayer));
};

/**
 * Vercel Sandbox runtime wiring.
 *
 * Selects the sandbox client by environment, mirroring `daytona/runtimeLayer`:
 * with the `VERCEL_*` credentials present the real `@vercel/sandbox`-backed
 * client is resolved; otherwise the in-memory fake (local temp dirs + local
 * processes) backs the adapter, so the server boots and the baseline contract
 * suite runs without provider access. The real client loads `@vercel/sandbox`
 * lazily; a credentialed run without the package installed fails loudly rather
 * than silently using the fake. The adapter shape is identical either way.
 *
 * @module vercelSandbox/runtimeLayer
 */
import { Layer } from "effect";
import type { FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";

import { buildProviderLayerFromEnv } from "../../providerCredentialLayer.ts";
import type { RuntimeProviderCredentials } from "../../Services/RuntimeProviderCredentials.ts";
import { VercelSandboxAdapterLive } from "./Layers/VercelSandboxAdapter.ts";
import { selectVercelSandboxClientLive } from "./Layers/VercelSandboxClientLive.ts";
import { VercelSandboxAdapter } from "./Services/VercelSandboxAdapter.ts";
import { VercelSandboxClient } from "./Services/VercelSandboxClient.ts";

/**
 * Dependencies the fake sandbox client requires: `FileSystem` for the temp-dir
 * filesystem and `ChildProcessSpawner` for local command exec. The real client
 * (once wired) needs no extra services, so the union is the fake's requirements.
 */
type VercelSandboxClientServices = FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner;

export interface VercelSandboxRuntimeLayerOptions {
  /**
   * Override the environment used to resolve credentials (tests). When set, the
   * layer pins this env and does not consult {@link RuntimeProviderCredentials}.
   */
  readonly env?: Record<string, string | undefined>;
}

/**
 * The Vercel Sandbox client layer. With an explicit `env` override it resolves
 * synchronously from that env; otherwise it resolves the merged env (settings +
 * secrets over `process.env`) from {@link RuntimeProviderCredentials}, so a key
 * entered in Settings selects the real client without a server restart.
 */
export function makeVercelSandboxClientLayer(options: {
  readonly env: Record<string, string | undefined>;
}): Layer.Layer<VercelSandboxClient, never, VercelSandboxClientServices>;
export function makeVercelSandboxClientLayer(
  options?: VercelSandboxRuntimeLayerOptions,
): Layer.Layer<
  VercelSandboxClient,
  never,
  VercelSandboxClientServices | RuntimeProviderCredentials
>;
export function makeVercelSandboxClientLayer(
  options?: VercelSandboxRuntimeLayerOptions,
): Layer.Layer<
  VercelSandboxClient,
  never,
  VercelSandboxClientServices | RuntimeProviderCredentials
> {
  return buildProviderLayerFromEnv("vercel-sandbox", options, selectVercelSandboxClientLive);
}

/** The Vercel Sandbox adapter backed by the credential-selected client. */
export function makeVercelSandboxRuntimeAdapterLayer(options: {
  readonly env: Record<string, string | undefined>;
}): Layer.Layer<VercelSandboxAdapter, never, VercelSandboxClientServices>;
export function makeVercelSandboxRuntimeAdapterLayer(
  options?: VercelSandboxRuntimeLayerOptions,
): Layer.Layer<
  VercelSandboxAdapter,
  never,
  VercelSandboxClientServices | RuntimeProviderCredentials
>;
export function makeVercelSandboxRuntimeAdapterLayer(
  options?: VercelSandboxRuntimeLayerOptions,
): Layer.Layer<
  VercelSandboxAdapter,
  never,
  VercelSandboxClientServices | RuntimeProviderCredentials
> {
  return VercelSandboxAdapterLive.pipe(Layer.provide(makeVercelSandboxClientLayer(options)));
}

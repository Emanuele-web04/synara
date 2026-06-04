/**
 * Vercel Sandbox runtime wiring.
 *
 * Selects the sandbox client by environment, mirroring `daytona/runtimeLayer`:
 * with the `VERCEL_*` credentials present the real (credentialed) client is
 * resolved; otherwise the in-memory fake (local temp dirs + local processes)
 * backs the adapter, so the server boots and the baseline contract suite runs
 * without provider access. The real client is not wired to the `@vercel/sandbox`
 * SDK yet (see `VercelSandboxClientLive`); a credentialed run fails loudly rather
 * than silently using the fake. The adapter shape is identical either way.
 *
 * @module vercelSandbox/runtimeLayer
 */
import { Layer } from "effect";
import type { FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";

import { VercelSandboxAdapterLive } from "./Layers/VercelSandboxAdapter.ts";
import { FakeVercelSandboxClientLive } from "./Layers/FakeVercelSandboxClient.ts";
import {
  hasVercelSandboxCredentials,
  realVercelSandboxClientUnavailable,
} from "./Layers/VercelSandboxClientLive.ts";
import { VercelSandboxAdapter } from "./Services/VercelSandboxAdapter.ts";
import { VercelSandboxClient } from "./Services/VercelSandboxClient.ts";

/**
 * Dependencies the fake sandbox client requires: `FileSystem` for the temp-dir
 * filesystem and `ChildProcessSpawner` for local command exec. The real client
 * (once wired) needs no extra services, so the union is the fake's requirements.
 */
type VercelSandboxClientServices = FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner;

export interface VercelSandboxRuntimeLayerOptions {
  /** Override the environment used to resolve credentials (tests). */
  readonly env?: Record<string, string | undefined>;
}

/**
 * The Vercel Sandbox client layer for the resolved environment. Returns the real
 * (credentialed) client when the `VERCEL_*` credentials are present, else the
 * fake client. The fake's requirements are exposed as the layer's `RIn`.
 */
export const makeVercelSandboxClientLayer = (
  options?: VercelSandboxRuntimeLayerOptions,
): Layer.Layer<VercelSandboxClient, never, VercelSandboxClientServices> =>
  hasVercelSandboxCredentials(options?.env ?? process.env)
    ? realVercelSandboxClientUnavailable
    : FakeVercelSandboxClientLive;

/** The Vercel Sandbox adapter backed by the environment-selected client. */
export const makeVercelSandboxRuntimeAdapterLayer = (
  options?: VercelSandboxRuntimeLayerOptions,
): Layer.Layer<VercelSandboxAdapter, never, VercelSandboxClientServices> =>
  VercelSandboxAdapterLive.pipe(Layer.provide(makeVercelSandboxClientLayer(options)));

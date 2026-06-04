/**
 * Daytona runtime wiring.
 *
 * Selects the sandbox client by environment: with `DAYTONA_API_KEY` present the
 * real REST client is used; otherwise the fake (local temp dirs) client backs the
 * adapter, so the server boots and the baseline contract suite runs without
 * provider access. The adapter shape is identical either way.
 *
 * @module daytona/runtimeLayer
 */
import { Layer } from "effect";
import type { FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type { HttpClient } from "effect/unstable/http";

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
  /** Override the environment used to resolve credentials (tests). */
  readonly env?: Record<string, string | undefined>;
}

/**
 * The Daytona sandbox client layer for the resolved environment. Returns the real
 * REST client (requires `HttpClient.HttpClient` in context) when credentials are
 * configured, else the fake client (requires `FileSystem` + `ChildProcessSpawner`).
 */
export const makeDaytonaSandboxClientLayer = (
  options?: DaytonaRuntimeLayerOptions,
): Layer.Layer<DaytonaSandboxClient, never, DaytonaClientServices> => {
  const credentials = resolveDaytonaCredentials(options?.env ?? process.env);
  return credentials === null
    ? FakeDaytonaSandboxClientLive
    : makeHttpDaytonaSandboxClientLive(credentials);
};

/** The Daytona adapter backed by the environment-selected sandbox client. */
export const makeDaytonaRuntimeAdapterLayer = (
  options?: DaytonaRuntimeLayerOptions,
): Layer.Layer<DaytonaRuntimeAdapter, never, DaytonaClientServices> =>
  DaytonaRuntimeAdapterLive.pipe(Layer.provide(makeDaytonaSandboxClientLayer(options)));

/**
 * Cloudflare runtime wiring.
 *
 * Selects the bridge connection by environment, mirroring `daytona/runtimeLayer`:
 * with `SYNARA_CLOUDFLARE_BRIDGE_URL` + `SYNARA_CLOUDFLARE_BRIDGE_TOKEN` present
 * the real HTTP/WS connection is used; otherwise the in-process fake bridge
 * (in-memory instance store, no network) backs the adapter, so the server boots
 * and the baseline contract suite runs without provider access. The bridge client
 * and adapter logic are identical either way — only the connection differs.
 *
 * @module CloudflareRuntimeProviderFacadeLayer
 */
import { Layer } from "effect";
import type { HttpClient } from "effect/unstable/http";

import { CloudflareBridgeClientLive } from "./CloudflareBridgeClient.ts";
import { CloudflareBridgeConnectionLive } from "./CloudflareBridgeConnection.ts";
import { CloudflareRuntimeProviderAdapterLive } from "./CloudflareRuntimeProviderAdapter.ts";
import { makeFakeCloudflareBridge } from "./cloudflareBridgeTestSupport.ts";
import { CloudflareRuntimeProviderAdapter } from "../Services/CloudflareRuntimeProviderAdapter.ts";
import { CloudflareBridgeConnection } from "../Services/CloudflareBridgeConnection.ts";

export interface CloudflareRuntimeLayerOptions {
  /** Override the environment used to resolve credentials (tests). */
  readonly env?: Record<string, string | undefined>;
}

const hasBridgeCredentials = (env: Record<string, string | undefined>): boolean =>
  typeof env.SYNARA_CLOUDFLARE_BRIDGE_URL === "string" &&
  env.SYNARA_CLOUDFLARE_BRIDGE_URL.length > 0 &&
  typeof env.SYNARA_CLOUDFLARE_BRIDGE_TOKEN === "string" &&
  env.SYNARA_CLOUDFLARE_BRIDGE_TOKEN.length > 0;

/**
 * The Cloudflare bridge connection layer for the resolved environment. Returns
 * the real HTTP/WS connection (requires `HttpClient.HttpClient` in context) when
 * the bridge credentials are configured, else the in-process fake (no deps). The
 * real connection reads its base URL + token from `Config`; the env-gate above
 * already guarantees both are present, so a missing-config defect is unreachable
 * and is promoted with `Layer.orDie` to keep the error channel `never`.
 */
export const makeCloudflareBridgeConnectionLayer = (
  options?: CloudflareRuntimeLayerOptions,
): Layer.Layer<CloudflareBridgeConnection, never, HttpClient.HttpClient> =>
  hasBridgeCredentials(options?.env ?? process.env)
    ? Layer.orDie(CloudflareBridgeConnectionLive)
    : makeFakeCloudflareBridge().layer;

/** The Cloudflare adapter backed by the environment-selected bridge connection. */
export const makeCloudflareRuntimeAdapterLayer = (
  options?: CloudflareRuntimeLayerOptions,
): Layer.Layer<CloudflareRuntimeProviderAdapter, never, HttpClient.HttpClient> =>
  CloudflareRuntimeProviderAdapterLive.pipe(
    Layer.provide(CloudflareBridgeClientLive),
    Layer.provide(makeCloudflareBridgeConnectionLayer(options)),
  );

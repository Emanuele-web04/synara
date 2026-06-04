/**
 * Cloudflare runtime wiring.
 *
 * Selects the bridge connection by the resolved credential env, mirroring
 * `daytona/runtimeLayer`: with `SYNARA_CLOUDFLARE_BRIDGE_URL` +
 * `SYNARA_CLOUDFLARE_BRIDGE_TOKEN` present the real HTTP/WS connection is used;
 * otherwise the in-process fake bridge (in-memory instance store, no network)
 * backs the adapter, so the server boots and the baseline contract suite runs
 * without provider access. The bridge client and adapter logic are identical
 * either way — only the connection differs.
 *
 * Credential resolution prefers Settings over `process.env`: when no explicit
 * `env` override is passed, the layer reads the merged env from
 * {@link RuntimeProviderCredentials} (settings + stored secrets over
 * `process.env`), so a bridge URL/token entered in Settings selects the real
 * connection without a server restart. The real connection reads its base URL +
 * token through effect `Config`; this layer feeds it a `ConfigProvider` over the
 * merged env so the configured values reach it.
 *
 * @module CloudflareRuntimeProviderFacadeLayer
 */
import { ConfigProvider, Layer } from "effect";
import type { FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type { HttpClient } from "effect/unstable/http";

import { buildProviderLayerFromEnv } from "../providerCredentialLayer.ts";
import type { RuntimeProviderCredentials } from "../Services/RuntimeProviderCredentials.ts";
import { CloudflareBridgeClientLive } from "./CloudflareBridgeClient.ts";
import { CloudflareBridgeConnectionLive } from "./CloudflareBridgeConnection.ts";
import { CloudflareRuntimeProviderAdapterLive } from "./CloudflareRuntimeProviderAdapter.ts";
import { makeFakeCloudflareBridge } from "./cloudflareBridgeTestSupport.ts";
import { CloudflareRuntimeProviderAdapter } from "../Services/CloudflareRuntimeProviderAdapter.ts";
import { CloudflareBridgeConnection } from "../Services/CloudflareBridgeConnection.ts";

export interface CloudflareRuntimeLayerOptions {
  /**
   * Override the environment used to resolve credentials (tests). When set, the
   * layer pins this env and does not consult {@link RuntimeProviderCredentials}.
   */
  readonly env?: Record<string, string | undefined>;
}

/**
 * Dependencies either bridge-connection branch may require: the real HTTP/WS
 * connection needs `HttpClient`; the in-process fake (real temp dirs + real local
 * processes) needs `FileSystem` + `ChildProcessSpawner`. The layer's `RIn` is
 * widened to the union so both branches unify under one type and the caller
 * provides whichever services the resolved environment uses — all satisfied by
 * `NodeServices.layer` + `FetchHttpClient.layer` at the server root.
 */
type CloudflareConnectionServices =
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner;

const hasBridgeCredentials = (env: Record<string, string | undefined>): boolean =>
  typeof env.SYNARA_CLOUDFLARE_BRIDGE_URL === "string" &&
  env.SYNARA_CLOUDFLARE_BRIDGE_URL.length > 0 &&
  typeof env.SYNARA_CLOUDFLARE_BRIDGE_TOKEN === "string" &&
  env.SYNARA_CLOUDFLARE_BRIDGE_TOKEN.length > 0;

/**
 * The real connection branch for a resolved env: feed the live connection a
 * `ConfigProvider` over `env` so its `Config`-read base URL + token come from the
 * merged settings/secret env rather than the ambient `process.env`. The env-gate
 * already guarantees both are present, so a missing-config defect is unreachable
 * and is promoted with `Layer.orDie` to keep the error channel `never`.
 */
const definedEntries = (env: Record<string, string | undefined>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
};

const realBridgeConnectionLayer = (
  env: Record<string, string | undefined>,
): Layer.Layer<CloudflareBridgeConnection, never, CloudflareConnectionServices> =>
  Layer.orDie(
    CloudflareBridgeConnectionLive.pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: definedEntries(env) }))),
    ),
  );

const connectionLayerForEnv = (
  env: Record<string, string | undefined>,
): Layer.Layer<CloudflareBridgeConnection, never, CloudflareConnectionServices> =>
  hasBridgeCredentials(env) ? realBridgeConnectionLayer(env) : makeFakeCloudflareBridge().layer;

/**
 * The Cloudflare bridge connection layer. With an explicit `env` override it
 * resolves synchronously from that env; otherwise it resolves the merged env
 * (settings + secrets over `process.env`) from {@link RuntimeProviderCredentials}
 * and selects the real or fake connection from it.
 */
export function makeCloudflareBridgeConnectionLayer(options: {
  readonly env: Record<string, string | undefined>;
}): Layer.Layer<CloudflareBridgeConnection, never, CloudflareConnectionServices>;
export function makeCloudflareBridgeConnectionLayer(
  options?: CloudflareRuntimeLayerOptions,
): Layer.Layer<
  CloudflareBridgeConnection,
  never,
  CloudflareConnectionServices | RuntimeProviderCredentials
>;
export function makeCloudflareBridgeConnectionLayer(
  options?: CloudflareRuntimeLayerOptions,
): Layer.Layer<
  CloudflareBridgeConnection,
  never,
  CloudflareConnectionServices | RuntimeProviderCredentials
> {
  return buildProviderLayerFromEnv("cloudflare", options, connectionLayerForEnv);
}

/** The Cloudflare adapter backed by the credential-selected bridge connection. */
export function makeCloudflareRuntimeAdapterLayer(options: {
  readonly env: Record<string, string | undefined>;
}): Layer.Layer<CloudflareRuntimeProviderAdapter, never, CloudflareConnectionServices>;
export function makeCloudflareRuntimeAdapterLayer(
  options?: CloudflareRuntimeLayerOptions,
): Layer.Layer<
  CloudflareRuntimeProviderAdapter,
  never,
  CloudflareConnectionServices | RuntimeProviderCredentials
>;
export function makeCloudflareRuntimeAdapterLayer(
  options?: CloudflareRuntimeLayerOptions,
): Layer.Layer<
  CloudflareRuntimeProviderAdapter,
  never,
  CloudflareConnectionServices | RuntimeProviderCredentials
> {
  return CloudflareRuntimeProviderAdapterLive.pipe(
    Layer.provide(CloudflareBridgeClientLive),
    Layer.provide(makeCloudflareBridgeConnectionLayer(options)),
  );
}

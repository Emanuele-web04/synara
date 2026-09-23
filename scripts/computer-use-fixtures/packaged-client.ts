/** Owner connection to one explicitly selected isolated desktop. Credentials
 * are obtained from its preload bridge and are never written to evidence. */
import {
  WS_CLIENT_REQUIRED_CAPABILITIES,
  WS_COMPATIBILITY_QUERY,
  WS_FEATURE_PATH,
  WS_NEGOTIATE_HTTP_PATH,
  WS_NEGOTIATE_QUERY,
  WS_PROTOCOL_EPOCH,
  WS_PROTOCOL_MAX_REVISION,
  WS_PROTOCOL_MIN_REVISION,
  WsBootstrapNegotiateResult,
  WsComputerRpcGroup,
  WsFeatureRpcGroup,
  type ProviderKind,
  type ServerProviderStatus,
} from "@synara/contracts";
import { SYNARA_CUA_DESKTOP_ORIGIN } from "@synara/shared/desktopIdentity";
import { Effect, Exit, Layer, ManagedRuntime, Schema, Scope } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

export function assertLoopbackUrl(value: string, protocol: "http:" | "ws:"): URL {
  const url = new URL(value);
  if (
    url.protocol !== protocol ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("Fixture connections must use local loopback endpoints.");
  }
  return url;
}

/** Fresh isolated homes have no discovery cache. Wait only for the requested
 * entry, never for an unavailable provider to become healthy or a fallback. */
export async function waitForSelectedProvider(input: {
  provider: ProviderKind;
  initial: readonly ServerProviderStatus[];
  read: () => Promise<readonly ServerProviderStatus[]>;
  timeoutMs?: number;
}): Promise<ServerProviderStatus> {
  const deadline = performance.now() + (input.timeoutMs ?? 45_000);
  let statuses = input.initial;
  for (;;) {
    const selected = statuses.find((status) => status.provider === input.provider);
    if (selected) return selected;
    const remaining = deadline - performance.now();
    if (remaining <= 0)
      throw new Error("Requested provider discovery did not finish before the setup deadline.");
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
    statuses = await input.read();
  }
}

async function desktopSocketUrl(cdpPort: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("Isolated desktop debugging endpoint is unavailable.");
  const targets: unknown = await response.json();
  if (!Array.isArray(targets)) throw new Error("Invalid desktop debugging targets.");
  const pages = targets.filter(
    (target) =>
      target?.type === "page" &&
      typeof target.url === "string" &&
      target.url.startsWith(`${SYNARA_CUA_DESKTOP_ORIGIN}/`),
  );
  if (pages.length !== 1) throw new Error("Expected exactly one isolated Synara Cua renderer.");
  const endpoint = assertLoopbackUrl(pages[0].webSocketDebuggerUrl, "ws:");
  if (Number(endpoint.port) !== cdpPort) throw new Error("Unexpected desktop debugging port.");
  // CDP is only used for this preload read. All task operations use the same
  // authenticated, schema-checked owner RPC contract as the application UI.
  return new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    const timer = setTimeout(() => fail(), 5_000);
    const finish = () => {
      clearTimeout(timer);
      socket.close();
    };
    const fail = () => {
      finish();
      reject(new Error("Could not read the isolated desktop owner connection."));
    };
    socket.addEventListener("error", fail, { once: true });
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            expression: "globalThis.desktopBridge?.getWsUrl()",
            returnByValue: true,
          },
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      try {
        const value = JSON.parse(String(event.data));
        if (value.id !== 1) return;
        const raw = value.result?.result?.value;
        if (value.error || typeof raw !== "string") return fail();
        const url = assertLoopbackUrl(raw, "ws:");
        if (!url.searchParams.get("token")) return fail();
        finish();
        resolve(url.toString());
      } catch {
        fail();
      }
    });
  });
}

const makeClient = RpcClient.make(WsFeatureRpcGroup.merge(WsComputerRpcGroup));

export async function connectPackagedOwner(cdpPort: number) {
  return connectOwnerUrl(await desktopSocketUrl(cdpPort));
}

/** Reusable by non-Electron isolated fixtures whose owner connection is
 * explicitly supplied in memory, never discovered from another instance. */
export async function connectOwnerUrl(rawUrl: string) {
  const url = assertLoopbackUrl(rawUrl, "ws:");
  if (!url.searchParams.get("token")) throw new Error("An authenticated owner URL is required.");
  const negotiate = new URL(url);
  negotiate.protocol = "http:";
  negotiate.pathname = WS_NEGOTIATE_HTTP_PATH;
  negotiate.searchParams.set(WS_NEGOTIATE_QUERY.clientBuild, "computer-fixture");
  negotiate.searchParams.set(WS_NEGOTIATE_QUERY.protocolEpoch, String(WS_PROTOCOL_EPOCH));
  negotiate.searchParams.set(WS_NEGOTIATE_QUERY.minRevision, String(WS_PROTOCOL_MIN_REVISION));
  negotiate.searchParams.set(WS_NEGOTIATE_QUERY.maxRevision, String(WS_PROTOCOL_MAX_REVISION));
  for (const capability of WS_CLIENT_REQUIRED_CAPABILITIES) {
    negotiate.searchParams.append(WS_NEGOTIATE_QUERY.requiredCapability, capability);
  }
  const response = await fetch(negotiate, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("Desktop owner RPC compatibility negotiation failed.");
  const compatibility = Schema.decodeUnknownSync(WsBootstrapNegotiateResult)(await response.json());
  url.pathname = WS_FEATURE_PATH;
  url.searchParams.set(WS_COMPATIBILITY_QUERY.clientBuild, "computer-fixture");
  url.searchParams.set(WS_COMPATIBILITY_QUERY.protocolEpoch, String(compatibility.protocolEpoch));
  url.searchParams.set(
    WS_COMPATIBILITY_QUERY.protocolRevision,
    String(compatibility.negotiatedRevision),
  );
  url.searchParams.set(WS_COMPATIBILITY_QUERY.serverInstanceId, compatibility.serverInstanceId);
  const socket = Socket.layerWebSocket(url.toString()).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
  const runtime = ManagedRuntime.make(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide(Layer.mergeAll(socket, RpcSerialization.layerJson)),
    ),
  );
  const scope = runtime.runSync(Scope.make());
  const api = await runtime.runPromise(Scope.provide(scope)(makeClient)).catch(async () => {
    await runtime.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
    throw new Error("Could not create the isolated owner RPC connection.");
  });
  return {
    api,
    serverPort: Number(url.port),
    run: <A, E>(effect: Effect.Effect<A, E>) =>
      runtime.runPromise(effect.pipe(Effect.timeout(15_000))),
    close: async () => {
      try {
        await runtime.runPromise(Scope.close(scope, Exit.void));
      } finally {
        await runtime.dispose();
      }
    },
  };
}

export type PackagedOwnerClient = Awaited<ReturnType<typeof connectPackagedOwner>>;

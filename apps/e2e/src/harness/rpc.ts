import WebSocket from "ws";
import { Schema } from "effect";
import {
  WsBootstrapNegotiateResult,
  WS_NEGOTIATE_QUERY,
  WS_COMPATIBILITY_QUERY,
} from "@synara/contracts";
import { controllerProtocol } from "../../../server/src/hostConnections/dialer";

/** Ordinary wire RPC, including real peer negotiation. No app state is injected. */
export async function workspaceRpc(origin: string, prefix = "", token?: string) {
  const url = new URL(`${prefix}/ws/negotiate`, origin);
  url.search = new URLSearchParams({
    [WS_NEGOTIATE_QUERY.clientBuild]: controllerProtocol.clientBuild,
    [WS_NEGOTIATE_QUERY.protocolEpoch]: String(controllerProtocol.protocolEpoch),
    [WS_NEGOTIATE_QUERY.minRevision]: String(controllerProtocol.minRevision),
    [WS_NEGOTIATE_QUERY.maxRevision]: String(controllerProtocol.maxRevision),
  }).toString();
  for (const capability of controllerProtocol.requiredCapabilities)
    url.searchParams.append(WS_NEGOTIATE_QUERY.requiredCapability, capability);
  const response = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Negotiation refused: ${response.status}`);
  const peer = Schema.decodeUnknownSync(WsBootstrapNegotiateResult)(await response.json());
  url.protocol = "ws:";
  url.pathname = `${prefix}/ws`;
  url.search = new URLSearchParams({
    [WS_COMPATIBILITY_QUERY.clientBuild]: controllerProtocol.clientBuild,
    [WS_COMPATIBILITY_QUERY.protocolEpoch]: String(peer.protocolEpoch),
    [WS_COMPATIBILITY_QUERY.protocolRevision]: String(peer.negotiatedRevision),
    [WS_COMPATIBILITY_QUERY.serverInstanceId]: peer.serverInstanceId,
    ...(peer.remoteAttachmentId ? { remoteAttachment: peer.remoteAttachmentId } : {}),
  }).toString();
  const socket = new WebSocket(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    handshakeTimeout: 15_000,
    perMessageDeflate: false,
  });
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString());
    if (frame._tag !== "Exit") return;
    const request = pending.get(String(frame.requestId));
    pending.delete(String(frame.requestId));
    if (frame.exit._tag === "Success") request?.resolve(frame.exit.value);
    else request?.reject(new Error(`RPC failed: ${JSON.stringify(frame.exit)}`));
  });
  const fail = () => {
    for (const request of pending.values()) request.reject(new Error("Workspace RPC closed"));
    pending.clear();
  };
  socket.on("error", fail);
  socket.on("close", fail);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let id = 0;
  return {
    async request<T = unknown>(tag: string, payload: unknown = {}): Promise<T> {
      if (socket.readyState !== WebSocket.OPEN) throw new Error("Workspace RPC closed");
      const requestId = String(++id);
      let timeout: ReturnType<typeof setTimeout>;
      try {
        return await new Promise<T>((resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(`RPC ${tag} timed out`)), 20_000);
          pending.set(requestId, { resolve: (value) => resolve(value as T), reject });
          socket.send(
            JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] }),
            (error) => {
              if (error) reject(error);
            },
          );
        });
      } finally {
        clearTimeout(timeout!);
        pending.delete(requestId);
      }
    },
    async [Symbol.asyncDispose]() {
      socket.terminate();
      fail();
    },
  };
}

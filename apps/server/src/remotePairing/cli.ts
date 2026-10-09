import fs from "node:fs/promises";
import WebSocket from "ws";
import {
  RemoteAccessResult,
  WsBootstrapNegotiateResult,
  WS_METHODS,
  WS_NEGOTIATE_HTTP_PATH,
  WS_NEGOTIATE_QUERY,
  WS_COMPATIBILITY_QUERY,
  type RemoteAccessRequest,
} from "@synara/contracts";
import { controllerProtocol } from "../hostConnections/dialer";
import { Schema } from "effect";
import { discoverServerRuntime, verifyServerRuntime } from "../externalMcp/bridge";
import { isLoopbackHost } from "../startupAccess";

/** Same owner RPC as Settings, reached only through a verified local runtime.
 * No database side door, mutation replay, or cloud-mediated approval. */
export async function requestLocalRemoteAccess(
  baseDir: string,
  request: RemoteAccessRequest,
): Promise<RemoteAccessResult> {
  const runtime = discoverServerRuntime(baseDir);
  const url = new URL(runtime.state.origin);
  if (!isLoopbackHost(url.hostname))
    throw new Error("Run remote management on the host's loopback server.");
  await verifyServerRuntime(runtime, globalThis.fetch);
  // This CLI is a separate process. A locally generated compatibility stamp
  // belongs to the CLI, not to the running server: negotiate with the verified peer.
  url.pathname = WS_NEGOTIATE_HTTP_PATH;
  const query = new URLSearchParams({
    [WS_NEGOTIATE_QUERY.clientBuild]: controllerProtocol.clientBuild,
    [WS_NEGOTIATE_QUERY.protocolEpoch]: String(controllerProtocol.protocolEpoch),
    [WS_NEGOTIATE_QUERY.minRevision]: String(controllerProtocol.minRevision),
    [WS_NEGOTIATE_QUERY.maxRevision]: String(controllerProtocol.maxRevision),
  });
  for (const capability of controllerProtocol.requiredCapabilities)
    query.append(WS_NEGOTIATE_QUERY.requiredCapability, capability);
  url.search = query.toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
  if (!response.ok) throw new Error("The running server is incompatible with this CLI.");
  const compatibility = Schema.decodeUnknownSync(WsBootstrapNegotiateResult)(await response.json());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  const search = new URLSearchParams({
    [WS_COMPATIBILITY_QUERY.clientBuild]: controllerProtocol.clientBuild,
    [WS_COMPATIBILITY_QUERY.protocolEpoch]: String(compatibility.protocolEpoch),
    [WS_COMPATIBILITY_QUERY.protocolRevision]: String(compatibility.negotiatedRevision),
    [WS_COMPATIBILITY_QUERY.serverInstanceId]: compatibility.serverInstanceId,
  });
  const token = process.env.SYNARA_AUTH_TOKEN;
  if (token) search.set("token", token);
  url.search = search.toString();
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      perMessageDeflate: false,
      maxPayload: 256 * 1024,
      handshakeTimeout: 10_000,
    });
    let settled = false;
    const finish = (error?: Error, value?: RemoteAccessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(
      () => finish(new Error("Remote management timed out. Check the host state before retrying.")),
      30_000,
    );
    socket.on("error", () => finish(new Error("Could not connect to the local owner interface.")));
    socket.on("close", () =>
      finish(new Error("The local owner connection closed before confirming the operation.")),
    );
    socket.once("open", () =>
      socket.send(
        JSON.stringify({
          _tag: "Request",
          id: "1",
          tag: WS_METHODS.hostsRemoteAccess,
          payload: { request },
          headers: [],
        }),
      ),
    );
    socket.on("message", (data) => {
      try {
        const frame = JSON.parse(data.toString());
        if (frame._tag !== "Exit" || String(frame.requestId) !== "1") return;
        if (frame.exit?._tag !== "Success") {
          // Do not print a raw RPC cause: it may contain invitation material.
          finish(
            new Error(
              "Remote management was refused. Check owner access, the runtime capability and the pending invitation in Settings.",
            ),
          );
          return;
        }
        finish(undefined, Schema.decodeUnknownSync(RemoteAccessResult)(frame.exit.value));
      } catch {
        finish(new Error("The local server returned an invalid remote management response."));
      }
    });
  });
}

export async function saveRemoteInvitation(
  file: string,
  result: RemoteAccessResult,
): Promise<void> {
  if (result.kind !== "invitation") throw new Error("The server did not issue an invitation.");
  // Exclusive creation prevents overwriting existing secrets or following symlinks.
  const handle = await fs.open(file, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(result.bundle, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

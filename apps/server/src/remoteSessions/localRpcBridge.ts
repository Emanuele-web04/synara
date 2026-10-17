import { bindRemoteAttachmentSession } from "../managedAttachmentPrincipal";
import {
  type AuthSessionId,
  WS_FEATURE_PATH,
  WS_COMPATIBILITY_QUERY,
  type WsBootstrapNegotiateInput,
  type WsBootstrapNegotiateResult,
} from "@synara/contracts";
import { Duration, Effect } from "effect";
import WebSocket, { type RawData } from "ws";

import type { SessionCredentialServiceShape } from "../auth/Services/SessionCredentialService";
import { sendBoundedRelayFrame, type RelaySocket } from "../relaySocket";
import { makeCurrentWsFeatureCompatibilitySearchParams } from "../wsCompatibility";
import serverPackageJson from "../../package.json" with { type: "json" };

export interface LocalRpcBridgeOptions {
  readonly listeningPort: number;
  readonly sessions: SessionCredentialServiceShape;
  readonly attachmentScope?: Parameters<typeof bindRemoteAttachmentSession>[1];
}

/** Reconstructs the original WebSocket frame kind without changing its bytes. */
export function normalizeRelayFrame(data: RawData, binary: boolean): string | Buffer {
  if (!binary) return data.toString();
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/**
 * A close code safe to hand to `ws.close()`. The reserved codes a peer never
 * sends on the wire but the library REPORTS locally — 1005 (no status), 1006
 * (abnormal, i.e. any TCP reset or relay restart), 1015 (TLS failure) — make
 * `close()` throw synchronously from inside a `close` listener. With no
 * uncaughtException handler in this process, forwarding one verbatim would
 * take the whole host down whenever a bridged session dropped abnormally.
 */
function forwardableCloseCode(code: number): number {
  if (code === 1005 || code === 1006 || code === 1015) return 1001;
  return code >= 1000 && code <= 4999 ? code : 1001;
}

/** Proxies an authenticated remote socket through the ordinary local `/ws` admission path. */
export async function bridgeRemoteSocketToLocalRpc(
  external: RelaySocket,
  peer: {
    readonly userId: string;
    readonly expiresAtSeconds: number;
    readonly client?: WsBootstrapNegotiateInput;
    readonly compatibility?: WsBootstrapNegotiateResult;
  },
  options: LocalRpcBridgeOptions,
): Promise<void> {
  const ttlMs = Math.max(1_000, peer.expiresAtSeconds * 1_000 - Date.now());
  let issuedSessionId: AuthSessionId | undefined;
  let internal: WebSocket | undefined;
  let externalClosed: Error | undefined;
  let rejectSetup: ((error: Error) => void) | undefined;
  let revoked = false;
  let unbindAttachments: (() => void) | undefined;
  const revokeIssuedSession = async () => {
    if (!issuedSessionId || revoked) return;
    revoked = true;
    unbindAttachments?.();
    await Effect.runPromise(options.sessions.revoke(issuedSessionId));
  };
  const remoteClosed = (code: number, reason: Buffer) => {
    externalClosed ??= new Error("remote peer closed during local RPC setup");
    if (internal?.readyState === WebSocket.OPEN) {
      internal.close(forwardableCloseCode(code), reason.toString());
    } else if (internal?.readyState === WebSocket.CONNECTING) {
      internal.terminate();
    }
    rejectSetup?.(externalClosed);
    void revokeIssuedSession().catch(() => {});
  };
  // A close is terminal and is not replayed to listeners attached later. This
  // must precede session/token issuance so a peer leaving during either await
  // cannot strand the full-privilege local session those operations create.
  external.on("close", remoteClosed);
  if (external.readyState === WebSocket.CLOSING || external.readyState === WebSocket.CLOSED) {
    externalClosed = new Error("remote peer closed during local RPC setup");
  }

  let opened = false;
  let pendingBytes = 0;
  const pending: Array<{ data: RawData; binary: boolean }> = [];
  const forwardExternal = (data: RawData, binary: boolean) => {
    if (!opened) {
      pendingBytes += normalizeRelayFrame(data, binary).length;
      if (pendingBytes > 8 * 1024 * 1024) {
        external.close(1009, "setup queue exceeded");
        return;
      }
      pending.push({ data, binary });
    } else if (internal?.readyState === WebSocket.OPEN) {
      sendBoundedRelayFrame(internal, normalizeRelayFrame(data, binary));
    }
  };

  external.on("message", forwardExternal);
  const cleanupForwarder = () => {
    external.off("message", forwardExternal);
    pending.length = 0;
    pendingBytes = 0;
  };
  external.on("close", cleanupForwarder);
  try {
    const issued = await Effect.runPromise(
      options.sessions.issue({
        ttl: Duration.millis(ttlMs),
        subject: peer.userId,
        method: "bearer-session-token",
        role: "client",
        client: { label: "Synara remote device", deviceType: "unknown" },
      }),
    );
    issuedSessionId = issued.sessionId;
    if (options.attachmentScope)
      unbindAttachments = bindRemoteAttachmentSession(issued.sessionId, options.attachmentScope);
    if (externalClosed) throw externalClosed;
    const websocketToken = await Effect.runPromise(
      options.sessions.issueWebSocketToken(issued.sessionId, { ttl: Duration.millis(ttlMs) }),
    );
    if (externalClosed) throw externalClosed;
    const search = makeCurrentWsFeatureCompatibilitySearchParams(serverPackageJson.version);
    if (peer.client && peer.compatibility) {
      search.set(WS_COMPATIBILITY_QUERY.clientBuild, peer.client.clientBuild);
      search.set(WS_COMPATIBILITY_QUERY.protocolEpoch, String(peer.compatibility.protocolEpoch));
      search.set(
        WS_COMPATIBILITY_QUERY.protocolRevision,
        String(peer.compatibility.negotiatedRevision),
      );
      search.set(WS_COMPATIBILITY_QUERY.serverInstanceId, peer.compatibility.serverInstanceId);
    }
    search.set("wsToken", websocketToken.token);
    internal = new WebSocket(
      `ws://127.0.0.1:${options.listeningPort}${WS_FEATURE_PATH}?${search.toString()}`,
      { perMessageDeflate: true, handshakeTimeout: 15_000 },
    );
    internal.on("close", (code, reason) => {
      cleanupForwarder();
      external.close(forwardableCloseCode(code), reason.toString());
      rejectSetup?.(new Error("local RPC socket closed during setup"));
      void revokeIssuedSession().catch(() => {});
    });

    await new Promise<void>((resolve, reject) => {
      rejectSetup = reject;
      internal?.once("open", () => {
        opened = true;
        for (const frame of pending.splice(0)) {
          if (internal)
            sendBoundedRelayFrame(internal, normalizeRelayFrame(frame.data, frame.binary));
        }
        resolve();
      });
      // Keep an error listener after setup. Terminating a CONNECTING socket on
      // an external close emits `error`; without a listener EventEmitter would
      // turn routine cancellation into an uncaught process exception.
      internal?.on("error", reject);
      if (externalClosed) reject(externalClosed);
    });
    rejectSetup = undefined;
    if (externalClosed) throw externalClosed;
    internal.on("message", (data, binary) => {
      if (external.readyState === WebSocket.OPEN)
        sendBoundedRelayFrame(external, normalizeRelayFrame(data, binary));
    });
  } catch (error) {
    cleanupForwarder();
    rejectSetup = undefined;
    if (internal?.readyState === WebSocket.OPEN || internal?.readyState === WebSocket.CONNECTING) {
      internal.terminate();
    }
    await revokeIssuedSession().catch(() => {});
    throw error;
  }
}

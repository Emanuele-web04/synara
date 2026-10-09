import { WsBootstrapNegotiateInput, type WsBootstrapNegotiateResult } from "@synara/contracts";
import { Effect, Schema } from "effect";
import { negotiateWsCompatibility } from "../wsCompatibility";
import { randomUUID } from "node:crypto";

import {
  HOST_SESSION_CLOSE_AUTH_FAILED,
  HOST_SESSION_CLOSE_PROTOCOL_ERROR,
} from "@synara/contracts";
import WebSocket, { type RawData } from "ws";

import type { HostMintService } from "../hostAuth";
import { JwtReplayCache, verifySessionCredential } from "../hostAuth";
import type { HostIdentity } from "../hostIdentity";
import type { RelaySocket } from "../relaySocket";
import { RemoteSessionRegistry } from "./sessionRegistry";

const REMOTE_PROTOCOL_ERROR = HOST_SESSION_CLOSE_PROTOCOL_ERROR;
const REMOTE_AUTH_ERROR = HOST_SESSION_CLOSE_AUTH_FAILED;

export interface RemoteConnectionGatewayOptions {
  readonly mintService: HostMintService;
  readonly identity: HostIdentity;
  readonly environmentId: string;
  readonly keyGeneration: number;
  readonly authorizeDevice: (
    userId: string,
    deviceJkt: string,
    generation: number,
  ) => Promise<void>;
  readonly sessions: RemoteSessionRegistry;
  readonly bridgeToLocal: (
    socket: RelaySocket,
    peer: {
      readonly userId: string;
      readonly deviceJkt: string;
      readonly trustGeneration: number;
      readonly expiresAtSeconds: number;
      readonly client: WsBootstrapNegotiateInput;
      readonly compatibility: WsBootstrapNegotiateResult;
    },
  ) => Promise<void>;
  readonly presentationHtu?: string;
}

function parseFrame(raw: RawData): Record<string, unknown> {
  const value: unknown = JSON.parse(raw.toString());
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("remote handshake frame must be an object");
  }
  return value as Record<string, unknown>;
}

export class RemoteConnectionGateway {
  readonly #dpopReplays = new JwtReplayCache();

  constructor(readonly options: RemoteConnectionGatewayOptions) {}

  async accept(
    socket: RelaySocket,
    via: "direct" | "relay" | "cloudflare" | "ssh-forward" = "direct",
  ): Promise<void> {
    let state: "mint" | "authorize" | "bridged" = "mint";
    let removeSession: (() => void) | undefined;
    let socketClosed = socket.readyState !== WebSocket.OPEN;
    let queuedBytes = 0;
    let queuedFrames = 0;
    const handshakeTimer = setTimeout(
      () => socket.close(1008, "Remote authorization timed out"),
      15_000,
    );
    handshakeTimer.unref();
    // A terminal close is not replayed to listeners attached after credential
    // verification. Observe it before the first handshake await, and make the
    // same listener own any registry entry created later.
    socket.on("close", () => {
      socketClosed = true;
      clearTimeout(handshakeTimer);
      removeSession?.();
      removeSession = undefined;
    });
    // Handshake frames are processed STRICTLY SERIALLY. `ws` delivers every
    // frame in a TCP segment synchronously, so an async-per-frame handler
    // would let two `session_authorize` frames both observe state ===
    // "authorize" before either reassigns it — each verifying (distinct DPoP
    // jtis defeat the replay cache) and each bridging the same socket, which
    // registers the forwarder twice and duplicates every subsequent RPC.
    let handshake: Promise<void> = Promise.resolve();
    socket.on("message", (raw, binary) => {
      if (state === "bridged" || socketClosed) return;
      const bytes = Array.isArray(raw)
        ? raw.reduce((size, chunk) => size + chunk.length, 0)
        : raw.byteLength;
      queuedBytes += bytes;
      queuedFrames += 1;
      if (binary || queuedBytes > 64 * 1024 || queuedFrames > 8) {
        socket.close(1009, "Remote authorization frame limit exceeded");
        return;
      }
      handshake = handshake.then(async () => {
        queuedBytes -= bytes;
        queuedFrames -= 1;
        if (state === "bridged" || socketClosed) return;
        try {
          const frame = parseFrame(raw);
          if (
            state === "mint" &&
            frame.v === 1 &&
            frame.type === "mint_request" &&
            typeof frame.request === "string"
          ) {
            const minted = await this.options.mintService.mint(frame.request);
            socket.send(
              JSON.stringify({
                v: 1,
                type: "session_credential",
                credential: minted.credential,
                expiresAtSeconds: minted.expiresAtSeconds,
              }),
            );
            state = "authorize";
            return;
          }
          if (
            frame.v !== 1 ||
            frame.type !== "session_authorize" ||
            typeof frame.credential !== "string" ||
            typeof frame.dpop !== "string"
          ) {
            throw new Error(
              state === "mint"
                ? "expected mint_request or session_authorize frame"
                : "expected session_authorize frame",
            );
          }
          const peer = await verifySessionCredential({
            credential: frame.credential,
            dpop: frame.dpop,
            identity: this.options.identity,
            environmentId: this.options.environmentId,
            keyGeneration: this.options.keyGeneration,
            expectedHtu: this.options.presentationHtu ?? "synara://remote/session",
            expectedHtm: "CONNECT",
            replayCache: this.#dpopReplays,
          });
          await this.options.authorizeDevice(peer.userId, peer.deviceJkt, peer.trustGeneration);
          if (socketClosed || socket.readyState !== WebSocket.OPEN) return;
          state = "bridged";
          const id = randomUUID();
          removeSession = this.options.sessions.add({
            id,
            ...peer,
            startedAt: new Date().toISOString(),
            via,
            close: (code, reason) => socket.close(code, reason),
          });
          // Registration precedes the second trust read: a revoke racing the
          // first read either closes this entry or is observed before bridging.
          await this.options.authorizeDevice(peer.userId, peer.deviceJkt, peer.trustGeneration);
          if (socketClosed || socket.readyState !== WebSocket.OPEN) return;
          const client = Schema.decodeUnknownSync(WsBootstrapNegotiateInput)(frame.client);
          const negotiated = await Effect.runPromise(
            negotiateWsCompatibility(client).pipe(
              Effect.match({
                onFailure: (error) => ({ error }),
                onSuccess: (compatibility) => ({ compatibility }),
              }),
            ),
          );
          if ("error" in negotiated) {
            socket.send(
              JSON.stringify({ v: 2, type: "session_incompatible", error: negotiated.error }),
            );
            socket.close(1008, "Incompatible renderer protocol");
            return;
          }
          await this.options.bridgeToLocal(socket, {
            ...peer,
            client,
            compatibility: negotiated.compatibility,
          });
          if (socketClosed || socket.readyState !== WebSocket.OPEN) {
            removeSession?.();
            removeSession = undefined;
            return;
          }
          // Do not invite application traffic until the ordinary local WS path is
          // ready to receive it. Otherwise a fast peer can race the async token
          // issuance/local connection setup and lose its first RPC frame.
          clearTimeout(handshakeTimer);
          socket.send(
            JSON.stringify({
              v: 2,
              type: "session_ready",
              compatibility: negotiated.compatibility,
              environmentId: this.options.environmentId,
            }),
          );
        } catch (error) {
          removeSession?.();
          removeSession = undefined;
          socket.close(
            state === "mint" || state === "authorize" ? REMOTE_AUTH_ERROR : REMOTE_PROTOCOL_ERROR,
            error instanceof Error ? error.message.slice(0, 120) : "remote authentication failed",
          );
        }
      });
    });
  }
}

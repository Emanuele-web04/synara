/**
 * Cloudflare terminal WebSocket transport.
 *
 * Forwards the bridge's interactive terminal WebSocket into an in-memory
 * `JsonRpcLineTransport` — the same value the Codex session consumes — so the
 * remote terminal is transport-agnostic to its consumer. Terminal output frames
 * (`{_tag:"data"}`) become inbound lines, `{_tag:"exit"}` resolves the
 * transport's exit, and outbound frames the consumer writes are wrapped as
 * `{_tag:"stdin"}` frames and sent over the socket. Closing the transport closes
 * the socket; the socket closing closes the transport.
 *
 * This mirrors `FakeRuntimeProviderAdapter`'s local-process forwarding: the
 * difference is only the channel (a WebSocket vs. a child process), not the
 * in-memory transport seam. The WebSocket itself comes from an injected factory
 * so production uses a real `ws` socket and tests use an in-process fake.
 *
 * @module cloudflareTerminalTransport
 */
import {
  BridgeTerminalFrame,
  type BridgeTerminalFrame as BridgeTerminalFrameType,
} from "@t3tools/contracts";
import { Deferred, Effect, Exit, Schema, Scope, Stream } from "effect";

import {
  makeInMemoryJsonRpcTransport,
  type JsonRpcLineTransport,
  type ProcessExit,
} from "../../provider/process/JsonRpcLineTransport.ts";

/**
 * The minimal duplex WebSocket surface the transport drives. A real `ws` socket
 * and an in-process test fake both satisfy this, so the forwarding logic never
 * depends on a concrete socket implementation.
 */
export interface BridgeWebSocket {
  /** Send one text frame to the bridge. */
  readonly send: (data: string) => void;
  /** Close the socket. */
  readonly close: () => void;
  /** Register a handler for an inbound text frame. */
  readonly onMessage: (handler: (data: string) => void) => void;
  /** Register a handler for socket close. */
  readonly onClose: (handler: () => void) => void;
}

const decodeFrame = Schema.decodeUnknownExit(BridgeTerminalFrame);

/**
 * Wrap a connected bridge terminal WebSocket as a {@link JsonRpcLineTransport}.
 * The socket must already be open; the caller's bridge client owns connecting it.
 */
export const makeCloudflareTerminalTransport = (
  socket: BridgeWebSocket,
): Effect.Effect<JsonRpcLineTransport> =>
  Effect.gen(function* () {
    const built = yield* makeInMemoryJsonRpcTransport();
    const { transport, controller } = built;
    const forwardScope = yield* Scope.make();

    // Bridge -> consumer: terminal output becomes inbound lines; exit resolves
    // the transport. A malformed frame is dropped rather than killing the stream.
    //
    // `pushInbound` expects one already-line-framed message per call, but a
    // terminal `data` frame is an opaque byte chunk that can carry zero, partial,
    // or multiple newlines — and a single JSON-RPC message can split across two
    // frames. Buffer the residual after the last `\n` and only push complete
    // lines, mirroring `Stream.splitLines` on the local/Modal/Vercel paths. The
    // residual is flushed as a final line on exit/close.
    let residual = "";

    const pushCompleteLines = (chunk: string) => {
      const combined = residual + chunk;
      const lastNewline = combined.lastIndexOf("\n");
      if (lastNewline < 0) {
        residual = combined;
        return;
      }
      residual = combined.slice(lastNewline + 1);
      for (const line of combined.slice(0, lastNewline).split("\n")) {
        if (line.length > 0) {
          Effect.runFork(controller.pushInbound(line));
        }
      }
    };

    const flushResidualAndExit = (status: ProcessExit) => {
      if (residual.length > 0) {
        const line = residual;
        residual = "";
        Effect.runFork(controller.pushInbound(line));
      }
      Effect.runFork(controller.signalExit(status));
    };

    socket.onMessage((raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      const decoded = decodeFrame(parsed);
      if (decoded._tag !== "Success") {
        return;
      }
      const frame: BridgeTerminalFrameType = decoded.value;
      if (frame._tag === "data") {
        pushCompleteLines(frame.data);
      } else if (frame._tag === "exit") {
        flushResidualAndExit({ code: frame.exitCode, signal: null });
      }
    });

    socket.onClose(() => {
      flushResidualAndExit({ code: null, signal: null });
    });

    // Consumer -> bridge: each outbound frame the consumer wrote is relayed as a
    // stdin terminal frame. The per-frame take is wrapped in a forever-repeating
    // single-element stream; when the consumer's outbound queue ends (transport
    // close) the take fails with `Cause.Done`, ending the relay.
    yield* Stream.fromEffect(controller.takeOutbound).pipe(
      Stream.forever,
      Stream.runForEach((line) =>
        Effect.sync(() => socket.send(JSON.stringify({ _tag: "stdin", data: `${line}\n` }))),
      ),
      Effect.ignore,
      Effect.forkIn(forwardScope),
    );

    // When the transport closes, close the socket and tear the relay down.
    yield* Deferred.await(transport.exit).pipe(
      Effect.flatMap(() =>
        Effect.sync(() => socket.close()).pipe(
          Effect.flatMap(() => Scope.close(forwardScope, Exit.void)),
        ),
      ),
      Effect.forkDetach,
    );

    return transport;
  });

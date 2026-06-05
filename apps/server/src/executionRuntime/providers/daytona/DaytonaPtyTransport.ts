/**
 * Daytona PTY WebSocket transport - the real-time duplex codex stdio channel.
 *
 * The default Daytona session transport reads codex stdout by polling the
 * command-logs endpoint (a 100ms loop that re-GETs the full cumulative body each
 * tick) and writes stdin with one HTTP POST per frame. Daytona's toolbox also
 * exposes a real duplex PTY over a WebSocket on the same proxy host: stdout
 * arrives as push (binary frames) instead of a poll, and stdin is a socket write
 * instead of an HTTP round-trip. This module builds a {@link DaytonaSessionProcess}
 * over that socket so the runtime adapter's existing stdout/stdin/exit forwarding
 * is reused unchanged - only the channel differs.
 *
 * Protocol (Daytona daemon `toolbox/process/pty`):
 *   - CREATE  POST `{proxy}/toolbox/{id}/process/pty` `{id,cols,rows,cwd?,envs?}`
 *             -> `{sessionId}`.
 *   - CONNECT WS `wss://{proxy}/toolbox/{id}/process/pty/{sessionId}/connect`,
 *             bearer header auth (Node sets WS upgrade headers directly).
 *   - INBOUND The server sends one control TEXT frame
 *             `{"type":"control","status":"connected"|"error"}` on connect, then
 *             PTY output as BINARY frames (stdout+stderr merged, raw bytes). A
 *             transport feeds only binary frames into the line framer; a control
 *             text frame is non-payload and must never reach the JSON-RPC stream.
 *   - OUTBOUND stdin is raw bytes: write the JSON-RPC frame + `\n` as bytes, no
 *             envelope (mirrors the polling client's `/input` body minus the HTTP
 *             hop).
 *   - EXIT    a WS CLOSE frame; `reason` is JSON `{"exitCode":N,...}` (code 1000
 *             with empty reason also means exit 0). Mapped to `ProcessExit`.
 *
 * The socket is injected as a {@link DaytonaPtyConnection} so production uses a
 * real `ws` socket (see `DaytonaPtyConnectionLive`) and tests use an in-process
 * fake. Closing the transport closes the socket, which kills the remote PTY
 * (the shell dies with the session) - satisfying the teardown requirement that
 * `transport.close -> session.close` ends the remote process.
 *
 * Echo suppression and line framing are shared with the polling path via
 * {@link makeDaytonaSessionLineFramer}: the PTY still echoes stdin until
 * `stty -echo` applies, the identical hazard the poll path handles.
 *
 * @module daytona/DaytonaPtyTransport
 */
import { Cause, Deferred, type Duration, Effect, Exit, Queue, Ref, Scope, Stream } from "effect";

import type { ProcessExit } from "../../../provider/process/JsonRpcLineTransport.ts";
import { makeDaytonaSessionLineFramer } from "./daytonaSessionLineFramer.ts";
import { DaytonaApiError } from "./DaytonaErrors.ts";
import type { DaytonaSessionProcess } from "./DaytonaSandboxClient.ts";

/**
 * One inbound PTY frame. A control frame carries the daemon's connect/error
 * status (text, non-payload); a data frame carries raw PTY bytes (stdout+stderr
 * merged). The connection adapter classifies the wire frame: `ws` binary frames
 * become `data`, text frames are parsed as the control envelope.
 */
export type DaytonaPtyFrame =
  | { readonly _tag: "data"; readonly bytes: Uint8Array }
  | { readonly _tag: "control"; readonly status: string };

/**
 * The minimal duplex PTY socket the transport drives. A real `ws` socket and an
 * in-process test fake both satisfy it, so the forwarding logic never depends on
 * a concrete socket. `onClose` carries the close `reason` (the daemon's exit
 * JSON) so the transport can map it to a `ProcessExit`.
 */
export interface DaytonaPtyConnection {
  /** Send raw stdin bytes to the PTY. */
  readonly send: (bytes: Uint8Array) => void;
  /** Close the socket (kills the remote PTY). */
  readonly close: () => void;
  /** Register a handler for one inbound frame (control or data). */
  readonly onFrame: (handler: (frame: DaytonaPtyFrame) => void) => void;
  /** Register a handler for socket close, carrying the close reason text. */
  readonly onClose: (handler: (reason: string) => void) => void;
}

/**
 * Parse a WS close `reason` into an exit code. The daemon sends JSON
 * `{"exitCode":N,...}`; an empty reason (close code 1000) is a clean exit 0. A
 * non-JSON or code-less reason defaults to 0 - the socket closed without an
 * explicit failure code.
 */
export const parsePtyExit = (reason: string): ProcessExit => {
  if (reason.trim().length === 0) {
    return { code: 0, signal: null };
  }
  try {
    const parsed = JSON.parse(reason) as { exitCode?: unknown };
    const code = typeof parsed.exitCode === "number" ? parsed.exitCode : 0;
    return { code, signal: null };
  } catch {
    return { code: 0, signal: null };
  }
};

const encoder = new TextEncoder();

/**
 * How codex is started on the attached PTY, plus the fail-closed readiness gate.
 *
 * The Daytona daemon (v0.184.0) ignores the PTY create-body `command`/`cmd`
 * field and attaches a bare interactive shell instead (live-verified), so the
 * launch must be written into the PTY as stdin after connect, not declared at
 * create. `command` is the fully-quoted `bash -lc '<script>'` line; it is sent
 * as `exec <command>\n` so the shell is replaced by codex and the WS close
 * code maps straight to codex's exit. The write is tracked for echo suppression
 * (the PTY echoes it back before `stty -echo` applies).
 *
 * `readyTimeout` is the fail-closed gate: connect succeeding is not proof the
 * PTY is live (the create-command bug returned a connected-but-empty attach).
 * If no inbound byte arrives within the deadline after the launch write, the
 * session aborts with a `DaytonaApiError` so the caller's `catchTag` fallback
 * runs the turn over the working polling transport instead of hanging.
 */
export interface DaytonaPtyLaunch {
  /** The fully-quoted `bash -lc '<script>'` codex launch line (no trailing newline). */
  readonly command: string;
  /** Max wait for the PTY's first inbound byte after the launch write. */
  readonly readyTimeout: Duration.Input;
}

/**
 * Wrap a connected Daytona PTY socket as a {@link DaytonaSessionProcess}. The
 * socket must already be open (the caller's connection adapter owns the REST
 * create + WS upgrade); this only forwards frames, stdin, and exit.
 *
 * When `launch` is provided, the codex launch line is written into the PTY as
 * stdin after the frame handlers are wired, and the session is returned only
 * once the PTY proves live (its first inbound byte arrives) within
 * `launch.readyTimeout`. A silent socket past the deadline aborts with a
 * `DaytonaApiError` so the caller falls back to polling. Omitting `launch` (the
 * test/fake path) skips both the launch write and the gate.
 */
export const makeDaytonaPtySession = (
  socket: DaytonaPtyConnection,
  launch?: DaytonaPtyLaunch,
): Effect.Effect<DaytonaSessionProcess, DaytonaApiError> =>
  Effect.gen(function* () {
    const sessionScope = yield* Scope.make();
    // Resolves on the first inbound data frame: the proof the attached PTY is
    // live (shell prompt, launch echo, or codex output). The launch gate awaits
    // this against `readyTimeout`.
    const firstData = yield* Deferred.make<void>();
    // `Cause.Done` lets the transport `end` the queue on teardown so the consumer
    // drains the last offered lines rather than being torn down mid-drain.
    const stdoutQueue = yield* Queue.unbounded<string, Cause.Done>();
    const exitDeferred = yield* Deferred.make<ProcessExit>();
    const framer = yield* makeDaytonaSessionLineFramer(stdoutQueue);

    const decoder = new TextDecoder();
    // The cumulative decoded output. The framer's `consumed` offset gates
    // emission, so re-passing the growing buffer (not just the new chunk) emits
    // each line exactly once - identical to the poll path's cumulative-body pass.
    const bufferRef = yield* Ref.make("");

    // Socket events (inbound data, close) arrive on the `ws` callback thread out
    // of the effect runtime. Funnel them through one ordered mailbox drained by a
    // single fiber so the framer (single-consumer: its `consumed` Ref and echo
    // multiset are not concurrency-safe) never runs two frames at once, and the
    // exit is processed strictly after every preceding data frame.
    const events = yield* Queue.unbounded<
      | { readonly _tag: "data"; readonly bytes: Uint8Array }
      | { readonly _tag: "exit"; readonly status: ProcessExit },
      Cause.Done
    >();

    const drainEvents = Stream.fromQueue(events).pipe(
      Stream.runForEach((event) =>
        event._tag === "data"
          ? Deferred.done(firstData, Exit.void).pipe(
              Effect.ignore,
              Effect.flatMap(() =>
                Ref.updateAndGet(
                  bufferRef,
                  (current) => current + decoder.decode(event.bytes, { stream: true }),
                ),
              ),
              Effect.flatMap((next) => framer.offerCompleteLines(next)),
            )
          : Ref.get(bufferRef).pipe(
              Effect.flatMap((output) => framer.flushResidual(output)),
              Effect.flatMap(() => Deferred.done(exitDeferred, Exit.succeed(event.status))),
              Effect.flatMap(() => Queue.end(stdoutQueue)),
            ),
      ),
    );
    yield* drainEvents.pipe(Effect.ignore, Effect.forkIn(sessionScope));

    // Bridge the callback-driven socket onto the mailbox. The close event ends
    // the mailbox after it is offered so the drainer processes the exit and then
    // completes (no further events can arrive once the socket closed).
    socket.onFrame((frame) => {
      if (frame._tag === "data") {
        Effect.runFork(Queue.offer(events, { _tag: "data", bytes: frame.bytes }));
      }
    });
    socket.onClose((reason) => {
      Effect.runFork(
        Queue.offer(events, {
          _tag: "exit",
          status: parsePtyExit(reason),
        }).pipe(Effect.flatMap(() => Queue.end(events))),
      );
    });

    const writeStdin: DaytonaSessionProcess["writeStdin"] = (line) =>
      Effect.sync(() => {
        framer.trackOutboundFrame(line);
        socket.send(encoder.encode(`${line}\n`));
      });

    // Closing the scope closes the socket (killing the remote PTY) and resolves
    // the exit if the close handler has not already - so a caller-initiated
    // teardown still completes `exit` and ends the queue exactly once. The socket
    // close drives a `close` reason through the mailbox, draining buffered lines
    // before the queue ends; this finalizer is the backstop if the socket never
    // fires its close (the `Deferred.done`/`Queue.end` are no-ops if already done).
    yield* Scope.addFinalizer(
      sessionScope,
      Effect.gen(function* () {
        yield* Effect.sync(() => socket.close());
        yield* Deferred.done(
          exitDeferred,
          Exit.succeed({ code: null, signal: null } satisfies ProcessExit),
        ).pipe(Effect.ignore);
        yield* Queue.end(stdoutQueue).pipe(Effect.ignore);
        yield* Queue.end(events).pipe(Effect.ignore);
      }),
    );

    // Launch codex over the PTY's stdin, then gate on the PTY proving live. The
    // daemon ignores the create-body command, so the launch must be written here
    // (after the frame handlers are wired, so no inbound byte is missed). `exec`
    // replaces the shell with codex so the WS close code is codex's exit; the
    // line is echo-tracked because the PTY echoes it back before `stty -echo`
    // applies. The gate then waits for the first inbound byte: a silent socket
    // past the deadline means connect succeeded but nothing is running (the
    // create-command regression), so abort with a `DaytonaApiError` to fall back.
    if (launch !== undefined) {
      const launchLine = `exec ${launch.command}`;
      yield* Effect.sync(() => {
        framer.trackOutboundFrame(launchLine);
        socket.send(encoder.encode(`${launchLine}\n`));
      });
      yield* Deferred.await(firstData).pipe(
        Effect.timeoutOrElse({
          duration: launch.readyTimeout,
          onTimeout: () =>
            Scope.close(sessionScope, Exit.void).pipe(
              Effect.ignore,
              Effect.flatMap(() =>
                Effect.fail(
                  new DaytonaApiError({
                    operation: "startPtySession",
                    status: null,
                    detail:
                      "PTY produced no output within the readiness deadline; falling back to polling",
                  }),
                ),
              ),
            ),
        }),
      );
    }

    // Graceful close: close the socket (kills the remote PTY and fires its
    // `onClose`, which drives an exit through the mailbox and flushes the buffered
    // lines), wait for the drainer to resolve the exit, then close the scope. This
    // drains the agent's last output even when `close` is called before the socket
    // ended on its own. The finalizer's `Deferred.done` is a no-op once resolved.
    const close = Effect.sync(() => socket.close()).pipe(
      Effect.flatMap(() => Deferred.await(exitDeferred)),
      Effect.flatMap(() => Scope.close(sessionScope, Exit.void)),
      Effect.ignore,
    );

    const session: DaytonaSessionProcess = {
      stdoutLines: Stream.fromQueue(stdoutQueue),
      stderrLines: Stream.empty,
      writeStdin,
      exit: Deferred.await(exitDeferred),
      close,
    };
    return session;
  });

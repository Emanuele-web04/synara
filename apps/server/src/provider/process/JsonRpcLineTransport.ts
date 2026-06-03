import { Cause, Data, Deferred, Effect, Exit, Queue, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

/**
 * Effect-native JSON-RPC line transport, mirroring `effect-acp`'s stdio
 * transport (`makeChildStdio` / `makeInMemoryStdio`). It owns the process
 * boundary only: framing JSON-RPC messages over a newline-delimited byte
 * stream and surfacing process lifecycle. JSON-RPC correlation, request ids,
 * and protocol semantics stay in the consumer (the imperative bridge).
 *
 * `inbound` yields one already-line-framed message string per element so the
 * consumer can reuse its existing per-line parser. Both stdout and stderr are
 * cross-chunk line-buffered, fixing the per-chunk stderr framing that split a
 * single log line across two `data` chunks.
 */
export interface ProcessExit {
  readonly code: number | null;
  readonly signal: string | null;
}

export class TransportClosedError extends Data.TaggedError("TransportClosedError")<{
  readonly detail: string;
}> {}

export interface JsonRpcLineTransport {
  /** Writes the JSON-serialized message plus a trailing newline. */
  readonly send: (message: unknown) => Effect.Effect<void, TransportClosedError>;
  /** Line-framed inbound JSON-RPC messages (request | notification | response). */
  readonly inbound: Stream.Stream<string>;
  /** Line-framed stderr side channel (empty for transports without stderr). */
  readonly stderr: Stream.Stream<string>;
  /** Resolves once with the process exit status. */
  readonly exit: Deferred.Deferred<ProcessExit>;
  /** Replaces `child.killed` liveness reads. */
  readonly isAlive: Effect.Effect<boolean>;
  /** Reject pending work and tear the process down. */
  readonly close: Effect.Effect<void>;
}

export interface CodexProcessTransportInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  /**
   * On Windows with `shell: true`, the spawned process is a `cmd.exe` wrapper,
   * so a direct kill leaves the real command running. The local transport kills
   * the whole tree via `kill`'s force escalation instead.
   */
  readonly shell: boolean;
}

const encoder = new TextEncoder();

/**
 * Local transport over `ChildProcessSpawner`. The returned handle is backed by
 * a self-contained scope: `close` closes that scope, which kills the process
 * (force-escalating to SIGKILL so a `shell: true` wrapper does not orphan the
 * child) and interrupts the pump fibers.
 */
export const makeCodexProcessTransport = (
  input: CodexProcessTransportInput,
): Effect.Effect<JsonRpcLineTransport, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const transportScope = yield* Scope.make();

    const inboundQueue = yield* Queue.unbounded<string, Cause.Done<void>>();
    const stderrQueue = yield* Queue.unbounded<string, Cause.Done<void>>();
    const outboundQueue = yield* Queue.unbounded<Uint8Array>();
    const exit = yield* Deferred.make<ProcessExit>();

    const closeScope = Scope.close(transportScope, Exit.succeed(undefined));

    // A spawn failure rejects the create effect; the consumer's session-start
    // try/catch surfaces it as `session/startFailed`, matching the prior
    // synchronous `spawn` throw.
    const child = yield* spawner
      .spawn(
        ChildProcess.make(input.command, [...input.args], {
          cwd: input.cwd,
          env: input.env,
          shell: input.shell,
          killSignal: "SIGTERM",
          forceKillAfter: "1500 millis",
        }),
      )
      .pipe(Effect.provideService(Scope.Scope, transportScope), Effect.orDie);

    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => Queue.offer(inboundQueue, line)),
      Effect.ensuring(Queue.end(inboundQueue)),
      Effect.ignore,
      Effect.forkIn(transportScope),
    );

    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => Queue.offer(stderrQueue, line)),
      Effect.ensuring(Queue.end(stderrQueue)),
      Effect.ignore,
      Effect.forkIn(transportScope),
    );

    yield* Stream.fromQueue(outboundQueue).pipe(
      Stream.run(child.stdin),
      Effect.ignore,
      Effect.forkIn(transportScope),
    );

    yield* child.exitCode.pipe(
      Effect.matchCause({
        onSuccess: (code) => ({ code: Number(code), signal: null }) satisfies ProcessExit,
        onFailure: () => ({ code: null, signal: null }) satisfies ProcessExit,
      }),
      Effect.flatMap((status) => Deferred.done(exit, Exit.succeed(status))),
      Effect.forkIn(transportScope),
    );

    const send: JsonRpcLineTransport["send"] = (message) =>
      Deferred.isDone(exit).pipe(
        Effect.flatMap((done) =>
          done
            ? Effect.fail(
                new TransportClosedError({ detail: "Cannot write to a closed transport." }),
              )
            : Queue.offer(outboundQueue, encoder.encode(`${JSON.stringify(message)}\n`)).pipe(
                Effect.asVoid,
              ),
        ),
      );

    return {
      send,
      inbound: Stream.fromQueue(inboundQueue),
      stderr: Stream.fromQueue(stderrQueue),
      exit,
      isAlive: child.isRunning.pipe(Effect.orElseSucceed(() => false)),
      close: closeScope,
    } satisfies JsonRpcLineTransport;
  });

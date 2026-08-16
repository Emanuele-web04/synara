// FILE: CliStructuredRuntime.ts
// Purpose: Owns one generic-CLI subprocess for the KAR-527 CLI connector.
// Spawns the process, reads newline-delimited output from stdout, and exposes
// either the strict structured wire protocol (`@synara/contracts` CliStructuredEvent
// framing — every non-blank line must decode; anything else is a CliProtocolError
// the connector attributes to the agent) or the basic line tier. Commands flow
// over stdin in structured mode; cancellation is a stdin command (structured) or
// a process-tree teardown (basic). Process supervision uses the shared
// supervisedProcessTeardown.
// Layer: Server CLI connector runtime
// Exports: CliStructuredRuntime, validateStructuredLine, teardownCliChildProcess,
//          CliRuntimeEvent, CliStructuredTier

import type { CliStructuredCommand, CliStructuredEvent } from "@synara/contracts";
import {
  CLI_STRUCTURED_PROTOCOL_VERSION,
  CliStructuredEvent as CliStructuredEventSchema,
} from "@synara/contracts";
import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";
import { Deferred, Effect, Layer, Option, Queue, Schema, Scope, ServiceMap, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import {
  teardownEffectProcessTree,
  teardownProviderProcessTree,
} from "../supervisedProcessTeardown.ts";
import * as CliErrors from "./CliErrors.ts";

export type CliStructuredTier = "structured" | "basic";

export interface CliStructuredSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface CliStructuredRuntimeOptions {
  readonly spawn: CliStructuredSpawnInput;
  /** Test seam for the shared supervised process-tree teardown owner. */
  readonly teardownProcessTree?: typeof teardownProviderProcessTree;
  /** Structured tier speaks the NDJSON wire protocol; basic tier is plain lines. */
  readonly structured: boolean;
  /** Grace window for a structured CLI to answer a cancel before the tree is torn down. */
  readonly cancelAckGraceMs?: number;
  /** Startup readiness budget before start() fails. */
  readonly startupTimeoutMs?: number;
}

/**
 * One runtime event for the connector. Protocol framing violations surface as
 * `protocol-error` events so the caller can attribute them to the agent
 * (KAR-523) without ever soft-skipping a line.
 */
export type CliRuntimeEvent =
  | { readonly _tag: "structured"; readonly event: CliStructuredEvent }
  | { readonly _tag: "line"; readonly line: string }
  | { readonly _tag: "protocol-error"; readonly error: CliErrors.CliProtocolError };

export interface CliSessionStartResult {
  readonly tier: CliStructuredTier;
  /** Agent identity from `session.hello` when the binary advertised one. */
  readonly agentName: string | undefined;
  /** Capabilities the structured CLI advertised on `session.hello`. */
  readonly capabilityIds: ReadonlyArray<string>;
}

export interface CliStructuredRuntimeShape {
  /** Startup: spawns the process and resolves once the hello (structured) or readiness line (basic) is seen. */
  readonly start: () => Effect.Effect<CliSessionStartResult, CliErrors.CliError>;
  /** Completes when the owned CLI process exits, regardless of its exit status. */
  readonly awaitExit: Effect.Effect<void>;
  /** Stream of runtime events. Framing violations surface as `protocol-error` events. */
  readonly getEvents: () => Stream.Stream<CliRuntimeEvent, never>;
  /** Sends one structured command over stdin (structured tier only). */
  readonly sendCommand: (command: CliStructuredCommand) => Effect.Effect<void, CliErrors.CliError>;
  /** Writes one raw line to stdin (basic tier only; structured tier errors). */
  readonly sendInput: (line: string) => Effect.Effect<void, CliErrors.CliError>;
  /**
   * Cancels the in-flight turn. Structured: sends `cli.command.cancel`, waits a
   * bounded grace window, then tears down the process tree. Basic: tears down
   * the tree directly (no protocol).
   */
  readonly cancel: Effect.Effect<void, CliErrors.CliError>;
}

interface CliOwnedChildProcess {
  readonly pid: number;
  readonly exitCode: Effect.Effect<unknown, unknown>;
}

const awaitCliChildExit = (child: CliOwnedChildProcess): Effect.Effect<void> =>
  child.exitCode.pipe(Effect.exit, Effect.asVoid);

export const teardownCliChildProcess = (
  child: CliOwnedChildProcess,
  teardownProcessTree: typeof teardownProviderProcessTree = teardownProviderProcessTree,
): Effect.Effect<void> =>
  Effect.suspend(() => {
    return Effect.tryPromise({
      try: () => teardownEffectProcessTree(child, teardownProcessTree),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(Effect.orDie);
  });

function decodeStructuredEvent(value: unknown): CliStructuredEvent {
  // Strict: an unknown `type` or a malformed member is a framing violation,
  // never soft-skipped.
  return Schema.decodeUnknownSync(CliStructuredEventSchema)(value);
}

/**
 * Strictly validates one stdout line against the structured wire contract.
 * Returns `undefined` for blank lines (allowed and ignored); otherwise a
 * `CliProtocolError` describing the violation. The connector uses this to
 * attribute framing failures to the agent (KAR-523) before the line is decoded.
 */
export function validateStructuredLine(
  line: string,
  maxLineChars = 500,
): CliErrors.CliProtocolError | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return new CliErrors.CliProtocolError({
      detail: "non-JSON stdout line",
      line: trimmed.slice(0, maxLineChars),
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return new CliErrors.CliProtocolError({
      detail: "JSON value is not an object event",
      line: trimmed.slice(0, maxLineChars),
    });
  }
  try {
    decodeStructuredEvent(parsed);
  } catch (cause) {
    return new CliErrors.CliProtocolError({
      detail: "not a known structured CLI event",
      line: trimmed.slice(0, maxLineChars),
      cause,
    });
  }
  return undefined;
}

export class CliStructuredRuntime extends ServiceMap.Service<
  CliStructuredRuntime,
  CliStructuredRuntimeShape
>()("synara/provider/cli/CliStructuredRuntime") {
  static layer(
    options: CliStructuredRuntimeOptions,
  ): Layer.Layer<
    CliStructuredRuntime,
    CliErrors.CliError,
    ChildProcessSpawner.ChildProcessSpawner
  > {
    return Layer.effect(CliStructuredRuntime, makeCliStructuredRuntime(options));
  }
}

const makeCliStructuredRuntime = (
  options: CliStructuredRuntimeOptions,
): Effect.Effect<
  CliStructuredRuntimeShape,
  CliErrors.CliError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.Scope;
    const eventQueue = yield* Queue.bounded<CliRuntimeEvent>(2_048);
    const startDeferred = yield* Deferred.make<CliSessionStartResult, CliErrors.CliError>();
    const structured = options.structured;
    const cancelAckGraceMs = options.cancelAckGraceMs ?? 250;
    const startupTimeoutMs = options.startupTimeoutMs ?? 15_000;

    const env = buildProviderChildEnvironment({
      provider: "acp",
      baseEnv: options.spawn.env ? { ...options.spawn.env } : process.env,
    });
    const prepared = prepareWindowsSafeProcess(options.spawn.command, options.spawn.args, {
      cwd: options.spawn.cwd,
      env,
    });
    const child = yield* spawner
      .spawn(
        ChildProcess.make(prepared.command, prepared.args, {
          ...(options.spawn.cwd ? { cwd: options.spawn.cwd } : {}),
          env,
          shell: prepared.shell,
          ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.mapError(
          (cause) =>
            new CliErrors.CliSpawnError({
              command: options.spawn.command,
              cause,
            }),
        ),
      );

    yield* Effect.addFinalizer(() => teardownCliChildProcess(child, options.teardownProcessTree));

    const decoder = new TextDecoder();
    let pendingLines = "";
    let started = false;

    const offerEvent = (event: CliRuntimeEvent): Effect.Effect<void> =>
      Queue.offer(eventQueue, event).pipe(Effect.asVoid);

    const failStart = (error: CliErrors.CliError): Effect.Effect<void> =>
      Deferred.fail(startDeferred, error).pipe(
        Effect.asVoid,
        Effect.catchCause(() => Effect.void),
      );

    const shutdownOnError = (): Effect.Effect<void> =>
      Queue.shutdown(eventQueue).pipe(Effect.catchCause(() => Effect.void));

    // Resolves to an effect that never fails: parse problems become
    // protocol-error events / start failures, never thrown errors.
    const handleLine = (rawLine: string): Effect.Effect<void, never> =>
      Effect.suspend(() => {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (!structured) {
          if (!started && line.trim().length > 0) {
            return Effect.sync(() => {
              started = true;
            }).pipe(
              Effect.andThen(
                Deferred.succeed(startDeferred, {
                  tier: "basic",
                  agentName: undefined,
                  capabilityIds: [],
                }).pipe(
                  Effect.asVoid,
                  Effect.catchCause(() => Effect.void),
                ),
              ),
              Effect.andThen(offerEvent({ _tag: "line", line })),
            );
          }
          return offerEvent({ _tag: "line", line });
        }

        const violation = validateStructuredLine(line);
        if (violation !== undefined) {
          return offerEvent({ _tag: "protocol-error", error: violation }).pipe(
            Effect.andThen(failStart(violation)),
            Effect.andThen(shutdownOnError()),
          );
        }

        const trimmed = line.trim();
        if (trimmed.length === 0) {
          return Effect.void;
        }
        // The hello must announce the exact protocol version the connector
        // speaks. A different version is parsed raw here (the wire schema would
        // reject it as unknown) so we can attribute it explicitly.
        const parsed: unknown = JSON.parse(trimmed);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          (parsed as { type?: unknown }).type === "session.hello"
        ) {
          const hello = parsed as { protocolVersion?: unknown; agentName?: unknown };
          if (hello.protocolVersion !== CLI_STRUCTURED_PROTOCOL_VERSION) {
            const mismatch = new CliErrors.CliProtocolError({
              detail: `unsupported structured CLI protocol version ${String(hello.protocolVersion)}`,
              line: trimmed.slice(0, 500),
            });
            return failStart(mismatch).pipe(Effect.andThen(shutdownOnError()));
          }
        }
        const event = decodeStructuredEvent(parsed);
        if (event.type === "session.hello" && !started) {
          return Effect.sync(() => {
            started = true;
          }).pipe(
            Effect.andThen(
              Deferred.succeed(startDeferred, {
                tier: "structured",
                agentName: event.agentName === undefined ? undefined : String(event.agentName),
                capabilityIds: event.capabilityIds ?? [],
              }).pipe(
                Effect.asVoid,
                Effect.catchCause(() => Effect.void),
              ),
            ),
            Effect.andThen(offerEvent({ _tag: "structured", event })),
          );
        }
        return offerEvent({ _tag: "structured", event });
      });

    const stdoutReader = yield* child.stdout.pipe(
      Stream.runForEach((chunk) =>
        Effect.suspend(() => {
          const text = decoder.decode(chunk, { stream: true });
          pendingLines += text;
          const lines: string[] = [];
          let index: number;
          while ((index = pendingLines.indexOf("\n")) !== -1) {
            lines.push(pendingLines.slice(0, index));
            pendingLines = pendingLines.slice(index + 1);
          }
          return Effect.forEach(lines, handleLine, { discard: true });
        }),
      ),
      Effect.matchEffect({
        onFailure: () => shutdownOnError(),
        onSuccess: () =>
          Effect.suspend(() => {
            // A final unterminated line: honest line tier emits it; the
            // structured tier cannot frame it so it is dropped silently (the
            // process exiting mid-line is not an attributable framing fault).
            if (pendingLines.length > 0) {
              const tail = pendingLines;
              pendingLines = "";
              if (!structured) {
                return handleLine(tail);
              }
            }
            return Effect.void;
          }).pipe(Effect.andThen(shutdownOnError())),
      }),
      Effect.forkIn(runtimeScope),
    );
    void stdoutReader;

    const start = Deferred.await(startDeferred).pipe(
      Effect.timeoutOption(startupTimeoutMs),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new CliErrors.CliTransportError({
                detail: `CLI process did not announce readiness within ${String(startupTimeoutMs)}ms`,
                cause: new Error("startup timeout"),
              }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    const outgoing = yield* Queue.bounded<Uint8Array>(256);
    yield* Stream.fromQueue(outgoing).pipe(Stream.run(child.stdin), Effect.forkIn(runtimeScope));

    const writeLine = (line: string): Effect.Effect<void, CliErrors.CliError> =>
      Queue.offer(outgoing, new TextEncoder().encode(`${line}\n`)).pipe(
        Effect.mapError(
          (cause) =>
            new CliErrors.CliTransportError({
              detail: "Failed to enqueue a line for the CLI stdin",
              cause,
            }),
        ),
      );

    const sendCommand = (command: CliStructuredCommand): Effect.Effect<void, CliErrors.CliError> =>
      Effect.gen(function* () {
        if (!structured) {
          return yield* new CliErrors.CliTransportError({
            detail: "Cannot send a structured command to a basic-tier CLI",
            cause: new Error("basic tier has no command protocol"),
          });
        }
        return yield* writeLine(JSON.stringify(command));
      });

    const sendInput = (line: string): Effect.Effect<void, CliErrors.CliError> =>
      Effect.gen(function* () {
        if (structured) {
          return yield* new CliErrors.CliTransportError({
            detail: "Cannot send a raw input line to a structured-tier CLI",
            cause: new Error("structured tier uses the command protocol"),
          });
        }
        return yield* writeLine(line);
      });

    const cancel: Effect.Effect<void, CliErrors.CliError> = Effect.gen(function* () {
      if (structured) {
        yield* sendCommand({ type: "cli.command.cancel", turnId: "all" }).pipe(
          Effect.catchCause(() => Effect.void),
        );
        yield* Effect.sleep(`${cancelAckGraceMs} millis`);
      }
      yield* teardownCliChildProcess(child, options.teardownProcessTree).pipe(
        Effect.mapError(
          (cause) =>
            new CliErrors.CliTransportError({
              detail: "Failed to tear down the CLI process tree",
              cause,
            }),
        ),
      );
    });

    const runtime: CliStructuredRuntimeShape = {
      start: () => start,
      awaitExit: awaitCliChildExit(child),
      getEvents: () => Stream.fromQueue(eventQueue),
      sendCommand,
      sendInput,
      cancel,
    };
    return runtime;
  });

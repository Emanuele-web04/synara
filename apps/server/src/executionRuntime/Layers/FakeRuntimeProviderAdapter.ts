/**
 * FakeRuntimeProviderAdapter - the fake-remote runtime adapter.
 *
 * Runs commands locally in per-instance temp dirs but through the *remote* path:
 * provisioning mints a real `RuntimeInstance` record rooted at a temp dir, and
 * `createTransport` returns an in-memory `JsonRpcLineTransport` (the same value
 * Codex consumes) — never a direct child-process handle. When a real command is
 * supplied, a locally spawned process is forwarded into the in-memory transport
 * queues, matching how a real remote adapter forwards a remote exec channel's
 * stdout/stderr lines to/from in-memory queues. Process-scripted tests omit the
 * command and drive the transport's controller directly.
 *
 * The adapter never touches orchestration commands or persistence: lifecycle
 * recording is the `ExecutionRuntimeService`'s job. This keeps the adapter a
 * pure provider boundary (provision / transport / destroy).
 *
 * @module FakeRuntimeProviderAdapter
 */
import nodePath from "node:path";
import { tmpdir } from "node:os";

import { ExecutionInstanceId, type RuntimeInstanceSummary } from "@t3tools/contracts";
import { Deferred, Effect, Exit, FileSystem, Layer, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import {
  makeInMemoryJsonRpcTransport,
  type JsonRpcLineTransport,
  type InMemoryTransportController,
} from "../../provider/process/JsonRpcLineTransport.ts";
import { RuntimeInstanceUnknownError } from "../Errors.ts";
import type { RuntimeProcessSpawnInput } from "../Services/RuntimeProcessTransport.ts";
import type { FakeRuntimeFlavor } from "../Services/FakeRuntimeFlavor.ts";
import { FakeRuntimeProviderAdapter } from "../Services/FakeRuntimeProviderAdapter.ts";
import { fakeRuntimeDescriptorByFlavor } from "./fakeDescriptors.ts";

const encoder = new TextEncoder();

export interface FakeRuntimeProvisionInput {
  readonly threadId: string;
  readonly flavor: FakeRuntimeFlavor;
}

export interface FakeRuntimeInstanceContext {
  readonly instance: RuntimeInstanceSummary;
  readonly rootPath: string;
  readonly flavor: FakeRuntimeFlavor;
}

/** Collected result of a fire-and-collect command run inside an instance. */
export interface FakeRuntimeExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

export interface FakeRuntimeExecInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Resolved relative to the instance root; defaults to the root. */
  readonly cwd?: string | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
}

export interface FakeRuntimeProviderAdapterShape {
  /** Provision a fake instance rooted at a fresh temp dir. */
  readonly provision: (
    input: FakeRuntimeProvisionInput,
  ) => Effect.Effect<FakeRuntimeInstanceContext>;
  /**
   * Create the in-memory transport for a process inside the instance. When the
   * spawn input names a runnable command, the local process is forwarded into
   * the transport queues; otherwise a bare scriptable transport is returned and
   * the caller (a test) drives its controller.
   */
  readonly createTransport: (
    instanceId: ExecutionInstanceId,
    spawn: RuntimeProcessSpawnInput,
  ) => Effect.Effect<
    { readonly transport: JsonRpcLineTransport; readonly controller: InMemoryTransportController },
    never,
    ChildProcessSpawner.ChildProcessSpawner
  >;
  /**
   * Fire-and-collect command exec inside an instance, the runtime-neutral
   * primitive `RuntimeGitWorkspace` rides on. A real remote adapter forwards
   * this to its provider's exec channel; the fake runs it locally rooted at the
   * instance's temp dir. Unlike `createTransport` this collects full output
   * rather than line-framing it for a JSON-RPC consumer.
   */
  readonly execCollect: (
    instanceId: ExecutionInstanceId,
    input: FakeRuntimeExecInput,
  ) => Effect.Effect<
    FakeRuntimeExecResult,
    RuntimeInstanceUnknownError,
    ChildProcessSpawner.ChildProcessSpawner
  >;
  /** Remove the instance's temp dir and forget it. Idempotent. */
  readonly destroy: (instanceId: ExecutionInstanceId) => Effect.Effect<void>;
}

/**
 * Forward a locally spawned child process into an in-memory transport's queues
 * under a self-contained scope. The consumer sees only the in-memory transport
 * (remote shape, no pid); closing it kills the local child and interrupts the
 * pumps. Commands that fail to spawn signal an immediate non-zero exit so the
 * consumer's start path surfaces a failure instead of hanging.
 */
const forwardLocalCommand = (
  controller: InMemoryTransportController,
  transport: JsonRpcLineTransport,
  spawn: RuntimeProcessSpawnInput,
): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const forwardScope = yield* Scope.make();

    const spawned = yield* spawner
      .spawn(
        ChildProcess.make(spawn.command, [...spawn.args], {
          cwd: spawn.cwd,
          env: spawn.env,
        }),
      )
      .pipe(Effect.provideService(Scope.Scope, forwardScope), Effect.exit);

    if (Exit.isFailure(spawned)) {
      yield* controller.signalExit({ code: 127, signal: null });
      yield* Scope.close(forwardScope, Exit.void);
      return;
    }
    const child = spawned.value;

    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => controller.pushInbound(line)),
      Effect.ignore,
      Effect.forkIn(forwardScope),
    );

    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => controller.pushStderr(line)),
      Effect.ignore,
      Effect.forkIn(forwardScope),
    );

    // The consumer writes outbound frames; relay them to the child's stdin. The
    // per-frame take is wrapped in a forever-repeating single-element stream;
    // when the consumer's outbound queue ends (transport close) the take fails
    // with `Cause.Done`, ending the relay.
    const outboundToStdin = Stream.fromEffect(controller.takeOutbound).pipe(
      Stream.forever,
      Stream.map((line) => encoder.encode(`${line}\n`)),
      Stream.run(child.stdin),
    );
    yield* outboundToStdin.pipe(Effect.ignore, Effect.forkIn(forwardScope));

    yield* child.exitCode.pipe(
      Effect.matchCause({
        onSuccess: (code) => ({ code: Number(code), signal: null }),
        onFailure: () => ({ code: null, signal: null }),
      }),
      Effect.flatMap((status) => controller.signalExit(status)),
      Effect.forkIn(forwardScope),
    );

    // When the transport closes, tear the child scope down.
    yield* Deferred.await(transport.exit).pipe(
      Effect.flatMap(() => Scope.close(forwardScope, Exit.void)),
      Effect.forkDetach,
    );
  });

const makeFakeRuntimeProviderAdapter = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const roots = new Map<ExecutionInstanceId, string>();

  const provision: FakeRuntimeProviderAdapterShape["provision"] = (input) =>
    Effect.gen(function* () {
      // Resolve the descriptor up front so an unknown flavor fails before any dir
      // is created — keeps provisioning honest against declared capabilities.
      const descriptor = fakeRuntimeDescriptorByFlavor(input.flavor);
      const instanceId = ExecutionInstanceId.makeUnsafe(`fake-${crypto.randomUUID()}`);
      const root = nodePath.join(tmpdir(), "synara-fake-runtime", String(instanceId));
      yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.orDie);
      roots.set(instanceId, root);
      const now = new Date().toISOString();
      const instance: RuntimeInstanceSummary = {
        id: instanceId,
        provider: descriptor.provider,
        status: "running",
        rootPath: root,
        failureReason: null,
        createdAt: now,
        updatedAt: now,
      };
      return { instance, rootPath: root, flavor: input.flavor };
    });

  const createTransport: FakeRuntimeProviderAdapterShape["createTransport"] = (
    _instanceId,
    spawn,
  ) =>
    Effect.gen(function* () {
      const built = yield* makeInMemoryJsonRpcTransport();
      if (spawn.command.trim().length > 0) {
        yield* forwardLocalCommand(built.controller, built.transport, spawn);
      }
      return { transport: built.transport, controller: built.controller };
    });

  const execCollect: FakeRuntimeProviderAdapterShape["execCollect"] = (instanceId, input) =>
    Effect.gen(function* () {
      const root = roots.get(instanceId);
      if (root === undefined) {
        return yield* Effect.fail(
          new RuntimeInstanceUnknownError({ instanceId: String(instanceId) }),
        );
      }
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const cwd =
        input.cwd === undefined || input.cwd.length === 0
          ? root
          : nodePath.resolve(root, input.cwd);

      // A spawn failure (e.g. missing binary) is a command-level result, not a
      // provider fault: surface it as a 127 exit with the error on stderr so the
      // git boundary classifies it like any other non-zero exit.
      const spawned = yield* spawner
        .spawn(
          ChildProcess.make(input.command, [...input.args], {
            cwd,
            ...(input.env === undefined ? {} : { env: input.env }),
          }),
        )
        .pipe(Effect.exit);

      if (Exit.isFailure(spawned)) {
        return {
          stdout: "",
          stderr: `failed to spawn ${input.command}`,
          code: 127,
        } satisfies FakeRuntimeExecResult;
      }
      const child = spawned.value;

      const [stdout, stderr, code] = yield* Effect.all(
        [
          collectUint8StreamText({ stream: child.stdout }).pipe(
            Effect.orElseSucceed(() => ({ text: "", truncated: false })),
          ),
          collectUint8StreamText({ stream: child.stderr }).pipe(
            Effect.orElseSucceed(() => ({ text: "", truncated: false })),
          ),
          child.exitCode.pipe(
            Effect.map((value): number | null => Number(value)),
            Effect.orElseSucceed((): number | null => null),
          ),
        ],
        { concurrency: "unbounded" },
      );

      return {
        stdout: stdout.text,
        stderr: stderr.text,
        code,
      } satisfies FakeRuntimeExecResult;
    }).pipe(Effect.scoped);

  const destroy: FakeRuntimeProviderAdapterShape["destroy"] = (instanceId) =>
    Effect.gen(function* () {
      const root = roots.get(instanceId);
      if (root === undefined) {
        return;
      }
      roots.delete(instanceId);
      yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
    });

  return {
    provision,
    createTransport,
    execCollect,
    destroy,
  } satisfies FakeRuntimeProviderAdapterShape;
});

export const makeFakeRuntimeProviderAdapterEffect = makeFakeRuntimeProviderAdapter;

export const FakeRuntimeProviderAdapterLive = Layer.effect(
  FakeRuntimeProviderAdapter,
  makeFakeRuntimeProviderAdapter,
);

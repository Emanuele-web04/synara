/**
 * ModalFakeCommandBackend - The credential-free Modal command transport.
 *
 * Runs commands locally in per-instance temp dirs but through Modal's *remote*
 * shape: provisioning mints an instance rooted at a temp dir, `execCollect`
 * fire-and-collects a local process (the verification-job primitive), and
 * `createTransport` returns an in-memory `JsonRpcLineTransport` whose queues a
 * locally spawned process is forwarded into — the same value Codex consumes,
 * never a direct child handle. A real Modal backend forwards its sandbox exec
 * channel into these queues identically; this fake proves the mechanism without
 * a network call so the Phase-17 baseline runs with no credentials.
 *
 * Modal exposes no PTY and no addressable per-exec process id, so the transport
 * never claims one. `exposePort` returns a deterministic synthetic tunnel URL
 * derived from the instance id and port (so the same instance/port always maps
 * to the same route, like a real tunnel); the real backend resolves the live
 * sandbox's public `*.modal.run` URL via the SDK.
 *
 * @module ModalFakeCommandBackend
 */
import nodePath from "node:path";
import { tmpdir } from "node:os";

import { ExecutionInstanceId } from "@t3tools/contracts";
import { Deferred, Effect, Exit, FileSystem, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../../../stream/collectUint8StreamText.ts";
import {
  makeInMemoryJsonRpcTransport,
  type InMemoryTransportController,
  type JsonRpcLineTransport,
} from "../../../provider/process/JsonRpcLineTransport.ts";
import type {
  ModalCommandTransportShape,
  ModalExecResult,
  ModalProcessSpawnInput,
} from "./ModalCommandTransport.ts";

const encoder = new TextEncoder();

/**
 * Forward a locally spawned child process into an in-memory transport's queues
 * under a self-contained scope. The consumer sees only the in-memory transport
 * (remote shape, no pid); closing it kills the local child and interrupts the
 * pumps. A spawn failure signals an immediate non-zero exit so the consumer's
 * start path surfaces a failure rather than hanging.
 */
const forwardLocalCommand = (
  controller: InMemoryTransportController,
  transport: JsonRpcLineTransport,
  spawn: ModalProcessSpawnInput,
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

    yield* Deferred.await(transport.exit).pipe(
      Effect.flatMap(() => Scope.close(forwardScope, Exit.void)),
      Effect.forkDetach,
    );
  });

export interface ModalFakeCommandBackend extends ModalCommandTransportShape {
  readonly backendKind: "fake";
}

/**
 * Build the fake Modal command backend. Holds an in-process `roots` map keyed by
 * instance id; like a real provider it forgets instances on `destroy` and after
 * a server restart, which the reconciler reads via `isAlive`.
 */
export const makeModalFakeCommandBackend: Effect.Effect<
  ModalFakeCommandBackend,
  never,
  FileSystem.FileSystem
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const roots = new Map<ExecutionInstanceId, string>();

  const provision: ModalCommandTransportShape["provision"] = (input) =>
    Effect.gen(function* () {
      const instanceId = ExecutionInstanceId.makeUnsafe(`modal-${crypto.randomUUID()}`);
      const root = nodePath.join(tmpdir(), "synara-modal-runtime", String(instanceId));
      yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.orDie);
      roots.set(instanceId, root);
      return { instanceId, rootPath: root, role: input.role };
    });

  const resolveCwd = (root: string, cwd: string | undefined): string =>
    cwd === undefined || cwd.length === 0 ? root : nodePath.resolve(root, cwd);

  const execCollect: ModalCommandTransportShape["execCollect"] = (instanceId, input) =>
    Effect.gen(function* () {
      const root = roots.get(instanceId);
      if (root === undefined) {
        // An unknown instance is a finished/destroyed job: report a terminal
        // non-zero exit rather than failing the provider boundary.
        return {
          stdout: "",
          stderr: `modal: no such instance ${String(instanceId)}`,
          code: 127,
        } satisfies ModalExecResult;
      }
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawned = yield* spawner
        .spawn(
          ChildProcess.make(input.command, [...input.args], {
            cwd: resolveCwd(root, input.cwd),
            ...(input.env === undefined ? {} : { env: input.env }),
          }),
        )
        .pipe(Effect.exit);

      if (Exit.isFailure(spawned)) {
        return {
          stdout: "",
          stderr: `failed to spawn ${input.command}`,
          code: 127,
        } satisfies ModalExecResult;
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

      return { stdout: stdout.text, stderr: stderr.text, code } satisfies ModalExecResult;
    }).pipe(Effect.scoped);

  const createTransport: ModalCommandTransportShape["createTransport"] = (_instanceId, spawn) =>
    Effect.gen(function* () {
      const built = yield* makeInMemoryJsonRpcTransport();
      if (spawn.command.trim().length > 0) {
        yield* forwardLocalCommand(built.controller, built.transport, spawn);
      }
      return { transport: built.transport, controller: built.controller };
    });

  const exposePort: ModalCommandTransportShape["exposePort"] = (instanceId, port) =>
    Effect.sync(() => {
      if (!roots.has(instanceId)) {
        return { port, url: null };
      }
      // Deterministic synthetic tunnel URL: the same instance/port always maps to
      // the same route, standing in for a Modal tunnel. A real backend resolves
      // the live sandbox's public `*.modal.run` URL via the SDK.
      return { port, url: `https://${String(instanceId)}-${port}.fake.modal.local` };
    });

  const isAlive: ModalCommandTransportShape["isAlive"] = (instanceId) =>
    Effect.sync(() => roots.has(instanceId));

  const destroy: ModalCommandTransportShape["destroy"] = (instanceId) =>
    Effect.gen(function* () {
      const root = roots.get(instanceId);
      if (root === undefined) {
        return;
      }
      roots.delete(instanceId);
      yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
    });

  return {
    backendKind: "fake",
    provision,
    execCollect,
    createTransport,
    exposePort,
    isAlive,
    destroy,
  } satisfies ModalFakeCommandBackend;
});

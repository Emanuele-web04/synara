/**
 * ModalRealCommandBackend - The credentialed Modal command transport.
 *
 * Selected only when {@link resolveModalCredentials} finds `MODAL_TOKEN_ID` /
 * `MODAL_TOKEN_SECRET`. It routes commands through the Modal CLI rather than a
 * local shell: a verification job is a `modal` invocation whose stdout/stderr is
 * the job's log stream and whose exit code is the terminal `Finished` result.
 *
 * The wiring reuses the in-memory transport forwarding the fake backend uses —
 * the only difference is which process is spawned (the `modal` CLI vs. the user
 * command directly) and which working dir / env carries the Modal credentials.
 * Modal exposes no PTY and no addressable per-exec process id, so this never
 * claims one.
 *
 * This backend has no automated coverage against a live Modal account (no creds
 * in CI); the contract suite exercises the fake backend. It exists so a
 * credentialed environment routes through the real path, and it shares the exact
 * provision/exec/transport shape the fake proves.
 *
 * @module ModalRealCommandBackend
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
import type { ModalCredentials } from "./ModalCredentials.ts";
import type {
  ModalCommandTransportShape,
  ModalExecResult,
  ModalProcessSpawnInput,
} from "./ModalCommandTransport.ts";

const encoder = new TextEncoder();

const MODAL_CLI = "modal";

/** Build the env a Modal CLI invocation runs with, carrying the credentials. */
const modalEnv = (
  credentials: ModalCredentials,
  base: Record<string, string | undefined> | undefined,
): Record<string, string | undefined> => ({
  ...base,
  MODAL_TOKEN_ID: credentials.tokenId,
  MODAL_TOKEN_SECRET: credentials.tokenSecret,
  ...(credentials.environment === undefined ? {} : { MODAL_ENVIRONMENT: credentials.environment }),
});

const forwardModalProcess = (
  credentials: ModalCredentials,
  controller: InMemoryTransportController,
  transport: JsonRpcLineTransport,
  spawn: ModalProcessSpawnInput,
): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const forwardScope = yield* Scope.make();

    const spawned = yield* spawner
      .spawn(
        ChildProcess.make(MODAL_CLI, ["shell", "--cmd", [spawn.command, ...spawn.args].join(" ")], {
          cwd: spawn.cwd,
          env: modalEnv(credentials, spawn.env),
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

export interface ModalRealCommandBackend extends ModalCommandTransportShape {
  readonly backendKind: "real";
}

export const makeModalRealCommandBackend = (
  credentials: ModalCredentials,
): Effect.Effect<ModalRealCommandBackend, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const roots = new Map<ExecutionInstanceId, string>();

    const provision: ModalCommandTransportShape["provision"] = (input) =>
      Effect.gen(function* () {
        const instanceId = ExecutionInstanceId.makeUnsafe(`modal-${crypto.randomUUID()}`);
        // A local staging dir holds the checkout the job runs against before it
        // is synced into the Modal sandbox.
        const root = nodePath.join(tmpdir(), "synara-modal-stage", String(instanceId));
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
          return {
            stdout: "",
            stderr: `modal: no such instance ${String(instanceId)}`,
            code: 127,
          } satisfies ModalExecResult;
        }
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawned = yield* spawner
          .spawn(
            ChildProcess.make(
              MODAL_CLI,
              ["shell", "--cmd", [input.command, ...input.args].join(" ")],
              {
                cwd: resolveCwd(root, input.cwd),
                env: modalEnv(credentials, input.env),
              },
            ),
          )
          .pipe(Effect.exit);
        if (Exit.isFailure(spawned)) {
          return {
            stdout: "",
            stderr: `failed to invoke ${MODAL_CLI}`,
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
          yield* forwardModalProcess(credentials, built.controller, built.transport, spawn);
        }
        return { transport: built.transport, controller: built.controller };
      });

    const exposePort: ModalCommandTransportShape["exposePort"] = (instanceId, port) =>
      Effect.sync(() => {
        // A real tunnel URL is resolved out-of-band from the Modal CLI's web
        // endpoint output; without a live run we cannot synthesize it, so the
        // route reports its port with a pending (null) url.
        if (!roots.has(instanceId)) {
          return { port, url: null };
        }
        return { port, url: null };
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
      backendKind: "real",
      provision,
      execCollect,
      createTransport,
      exposePort,
      isAlive,
      destroy,
    } satisfies ModalRealCommandBackend;
  });

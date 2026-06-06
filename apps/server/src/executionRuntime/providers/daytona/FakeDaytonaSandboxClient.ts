/**
 * FakeDaytonaSandboxClient - a local stand-in for the Daytona REST API.
 *
 * It satisfies {@link DaytonaSandboxClientShape} entirely on this host: each
 * sandbox is a temp dir, `exec` and `startSession` spawn real local child
 * processes rooted there, ports get a synthetic preview URL, and snapshots are
 * recorded by id. It is the default client (no `DAYTONA_API_KEY`) and the one the
 * baseline contract suite runs against in CI — it exercises every code path the
 * adapter and the runtime-neutral git workspace take, without provider access.
 *
 * It is deliberately *not* a no-op: spawning real processes and running real git
 * is what makes the baseline contract meaningful. Only the network boundary is
 * faked.
 *
 * @module daytona/FakeDaytonaSandboxClient
 */
import nodePath from "node:path";
import { tmpdir } from "node:os";

import { Deferred, Effect, Exit, FileSystem, Layer, Queue, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../../../stream/collectUint8StreamText.ts";
import type { ProcessExit } from "../../../provider/process/JsonRpcLineTransport.ts";
import { DaytonaApiError, DaytonaSandboxUnknownError } from "./DaytonaErrors.ts";
import {
  DaytonaSandboxClient,
  type DaytonaSandbox,
  type DaytonaSandboxClientShape,
  type DaytonaSandboxStatus,
  type DaytonaSessionProcess,
} from "./DaytonaSandboxClient.ts";

const encoder = new TextEncoder();

interface FakeSandboxRecord {
  root: string;
  status: DaytonaSandboxStatus;
  snapshots: string[];
}

const resolveCwd = (root: string, cwd: string | undefined): string =>
  cwd === undefined || cwd.length === 0 ? root : nodePath.resolve(root, cwd);

const makeFakeDaytonaSandboxClient = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const sandboxes = new Map<string, FakeSandboxRecord>();

  const requireSandbox = (sandboxId: string) =>
    Effect.suspend(() => {
      const record = sandboxes.get(sandboxId);
      return record === undefined
        ? Effect.fail(new DaytonaSandboxUnknownError({ sandboxId }))
        : Effect.succeed(record);
    });

  const create: DaytonaSandboxClientShape["create"] = (input) =>
    Effect.gen(function* () {
      const sandboxId = `daytona-fake-${crypto.randomUUID()}`;
      const root = nodePath.join(tmpdir(), "synara-daytona-fake", sandboxId);
      yield* fs
        .makeDirectory(root, { recursive: true })
        .pipe(
          Effect.mapError(
            (cause) =>
              new DaytonaApiError({ operation: "create", status: null, detail: String(cause) }),
          ),
        );
      sandboxes.set(sandboxId, {
        root,
        status: "running",
        snapshots: input.snapshotId === null ? [] : [input.snapshotId],
      });
      return { id: sandboxId, status: "running", rootPath: root } satisfies DaytonaSandbox;
    });

  const exec: DaytonaSandboxClientShape["exec"] = (sandboxId, input) =>
    Effect.gen(function* () {
      const record = yield* requireSandbox(sandboxId);
      const cwd = resolveCwd(record.root, input.cwd);

      // A spawn failure (missing binary) is a command result, not a provider
      // fault: surface a 127 exit so the caller classifies it like a non-zero
      // exit, matching how the real toolbox reports a failed command.
      const spawned = yield* spawner
        .spawn(
          ChildProcess.make(input.command, [...input.args], {
            cwd,
            ...(input.env === undefined ? {} : { env: input.env }),
          }),
        )
        .pipe(Effect.exit);
      if (Exit.isFailure(spawned)) {
        return { stdout: "", stderr: `failed to spawn ${input.command}`, exitCode: 127 };
      }
      const child = spawned.value;

      const [stdout, stderr, exitCode] = yield* Effect.all(
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
      return { stdout: stdout.text, stderr: stderr.text, exitCode };
    }).pipe(Effect.scoped);

  const startSession: DaytonaSandboxClientShape["startSession"] = (sandboxId, input) =>
    Effect.gen(function* () {
      const record = yield* requireSandbox(sandboxId);
      const cwd = resolveCwd(record.root, input.cwd);
      const sessionScope = yield* Scope.make();
      const exitDeferred = yield* Deferred.make<ProcessExit>();

      const spawned = yield* spawner
        .spawn(
          ChildProcess.make(input.command, [...input.args], {
            cwd,
            ...(input.env === undefined ? {} : { env: input.env }),
          }),
        )
        .pipe(Effect.provideService(Scope.Scope, sessionScope), Effect.exit);

      if (Exit.isFailure(spawned)) {
        yield* Scope.close(sessionScope, Exit.void);
        return yield* Effect.fail(
          new DaytonaApiError({
            operation: "startSession",
            status: null,
            detail: `failed to spawn ${input.command}`,
          }),
        );
      }
      const child = spawned.value;

      yield* child.exitCode.pipe(
        Effect.matchCause({
          onSuccess: (code) => ({ code: Number(code), signal: null }) satisfies ProcessExit,
          onFailure: () => ({ code: null, signal: null }) satisfies ProcessExit,
        }),
        Effect.flatMap((status) => Deferred.done(exitDeferred, Exit.succeed(status))),
        Effect.forkIn(sessionScope),
      );

      // A single persistent relay drains a stdin queue into the child's stdin
      // sink. `writeStdin` enqueues; the sink is consumed exactly once, so a
      // long-lived session can receive many frames without closing stdin between
      // writes (running a Sink per write would close it after the first).
      const stdinQueue = yield* Queue.unbounded<Uint8Array>();
      yield* Stream.fromQueue(stdinQueue).pipe(
        Stream.run(child.stdin),
        Effect.ignore,
        Effect.forkIn(sessionScope),
      );

      const session: DaytonaSessionProcess = {
        stdoutLines: child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.orDie),
        stderrLines: child.stderr.pipe(Stream.decodeText(), Stream.splitLines, Stream.orDie),
        writeStdin: (line) =>
          Queue.offer(stdinQueue, encoder.encode(`${line}\n`)).pipe(Effect.asVoid),
        exit: Deferred.await(exitDeferred),
        close: Scope.close(sessionScope, Exit.void),
      };
      return session;
    });

  const exposePort: DaytonaSandboxClientShape["exposePort"] = (sandboxId, port) =>
    requireSandbox(sandboxId).pipe(
      Effect.as({ url: `https://${sandboxId}-${port}.fake.daytona.local` }),
    );

  const snapshot: DaytonaSandboxClientShape["snapshot"] = (sandboxId, label) =>
    requireSandbox(sandboxId).pipe(
      Effect.map((record) => {
        const snapshotId = `snap-${sandboxId}-${record.snapshots.length}${
          label === null ? "" : `-${label}`
        }`;
        record.snapshots.push(snapshotId);
        return { snapshotId };
      }),
    );

  const refreshActivity: DaytonaSandboxClientShape["refreshActivity"] = (sandboxId) =>
    requireSandbox(sandboxId).pipe(Effect.asVoid);

  const stop: DaytonaSandboxClientShape["stop"] = (sandboxId) =>
    requireSandbox(sandboxId).pipe(
      Effect.map((record) => {
        record.status = "stopped";
      }),
    );

  const getStatus: DaytonaSandboxClientShape["getStatus"] = (sandboxId) =>
    Effect.sync(() => {
      const record = sandboxes.get(sandboxId);
      if (record === undefined) {
        return null;
      }
      return {
        id: sandboxId,
        status: record.status,
        rootPath: record.root,
      } satisfies DaytonaSandbox;
    });

  const destroy: DaytonaSandboxClientShape["destroy"] = (sandboxId) =>
    Effect.gen(function* () {
      const record = sandboxes.get(sandboxId);
      if (record === undefined) {
        return;
      }
      sandboxes.delete(sandboxId);
      yield* fs.remove(record.root, { recursive: true }).pipe(Effect.ignore);
    });

  return {
    create,
    exec,
    startSession,
    exposePort,
    snapshot,
    refreshActivity,
    stop,
    getStatus,
    destroy,
  } satisfies DaytonaSandboxClientShape;
});

export const makeFakeDaytonaSandboxClientEffect = makeFakeDaytonaSandboxClient;

export const FakeDaytonaSandboxClientLive = Layer.effect(
  DaytonaSandboxClient,
  makeFakeDaytonaSandboxClient,
);

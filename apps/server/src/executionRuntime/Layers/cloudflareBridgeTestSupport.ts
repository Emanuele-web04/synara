/**
 * In-process fake of the Cloudflare bridge for contract tests.
 *
 * Implements `CloudflareBridgeConnection` against a real per-instance temp dir
 * and real local process execution, so the bridge client + Cloudflare adapter
 * run their full route/transport logic with no network and no credentials. This
 * is what lets the shared Phase-17 baseline contract suite
 * ({@link describeRuntimeProviderContract}) pass when real bridge credentials are
 * absent; the same suite runs against the real bridge when they are present.
 *
 * The fake is deliberately *not* a scripted mock: provisioning mints an instance
 * rooted at a temp dir, `/exec` fire-and-collects a real local process there (so
 * the baseline's `git clone` + diff + non-zero-exit assertions run against real
 * behavior), the terminal WebSocket forwards a real spawned child (stdout ->
 * `data` frames, stdin frames -> child stdin, child exit -> `exit` frame), and
 * `/files` reads/writes the real filesystem. Only the network boundary is faked,
 * mirroring Modal's `ModalFakeCommandBackend` and Daytona's
 * `FakeDaytonaSandboxClient`.
 *
 * @module cloudflareBridgeTestSupport
 */
import nodePath from "node:path";
import { tmpdir } from "node:os";

import { Effect, Exit, FileSystem, Layer, Queue, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import { CloudflareBridgeError } from "../Errors.ts";
import {
  CloudflareBridgeConnection,
  type CloudflareBridgeConnectionShape,
  type CloudflareBridgeHttpResponse,
} from "../Services/CloudflareBridgeConnection.ts";
import type { BridgeWebSocket } from "./cloudflareTerminalTransport.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64 = (text: string): string => {
  let binary = "";
  for (const byte of encoder.encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const fromBase64ToText = (value: string): string => {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return decoder.decode(out);
};

interface FakeInstance {
  readonly id: string;
  readonly flavor: string;
  status: string;
  /** A real temp dir the instance's exec/terminal/files run against. */
  readonly rootPath: string;
  routes: Array<{ id: string; port: number; url: string | null; label: string | null }>;
  networkPolicy: { defaultEgress: string; rules: ReadonlyArray<unknown> };
  expiresAt: string | null;
  readonly createdAt: string;
}

/** A live terminal child the test can observe. */
export interface FakeBridgeTerminal {
  /** Whether the forwarding socket has been closed. */
  readonly closed: () => boolean;
}

export interface FakeBridgeController {
  /** The terminal opened by the most recent `connectWebSocket`, if any. */
  readonly lastTerminal: () => FakeBridgeTerminal | undefined;
}

const now = (): string => new Date().toISOString();

const ok = (json: unknown, status = 200): CloudflareBridgeHttpResponse => ({ status, json });

const notFound = (): CloudflareBridgeHttpResponse => ({
  status: 404,
  json: { error: "instance_not_found", detail: null },
});

const instanceIdFromPath = (path: string): string | null => {
  const match = /^\/instances\/([^/]+)/.exec(path);
  return match?.[1] !== undefined ? decodeURIComponent(match[1]) : null;
};

const resolveCwd = (root: string, cwd: string | null | undefined): string =>
  cwd === undefined || cwd === null || cwd.length === 0 ? root : nodePath.resolve(root, cwd);

const filterEnv = (env: Record<string, string> | undefined): Record<string, string> | undefined =>
  env === undefined || Object.keys(env).length === 0 ? undefined : env;

/**
 * Build a fake bridge connection layer plus a controller the test inspects. Each
 * fake instance is rooted at a real temp dir; like a real provider it forgets
 * instances on `DELETE`, removing the temp dir.
 */
export const makeFakeCloudflareBridge = (): {
  readonly layer: Layer.Layer<
    CloudflareBridgeConnection,
    never,
    FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
  >;
  readonly controller: FakeBridgeController;
} => {
  const instances = new Map<string, FakeInstance>();
  let counter = 0;
  let lastTerminal: FakeBridgeTerminal | undefined;

  const controller: FakeBridgeController = {
    lastTerminal: () => lastTerminal,
  };

  const serialize = (instance: FakeInstance): unknown => ({
    id: instance.id,
    flavor: instance.flavor,
    status: instance.status,
    rootPath: instance.rootPath,
    routes: instance.routes,
    failureReason: null,
    createdAt: instance.createdAt,
    updatedAt: now(),
  });

  const layer = Layer.effect(
    CloudflareBridgeConnection,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const execReal = (
        instance: FakeInstance,
        body: {
          readonly command: string;
          readonly args?: ReadonlyArray<string>;
          readonly cwd?: string | null;
          readonly env?: Record<string, string>;
        },
      ): Effect.Effect<CloudflareBridgeHttpResponse> =>
        Effect.gen(function* () {
          const env = filterEnv(body.env);
          const spawned = yield* spawner
            .spawn(
              ChildProcess.make(body.command, [...(body.args ?? [])], {
                cwd: resolveCwd(instance.rootPath, body.cwd),
                ...(env === undefined ? {} : { env }),
              }),
            )
            .pipe(Effect.exit);
          if (Exit.isFailure(spawned)) {
            // A spawn failure (missing binary) is a command result, not a bridge
            // fault: a 127 exit lets the caller classify it like a non-zero exit.
            return ok({
              processId: `proc-${(counter += 1)}`,
              stdout: "",
              stderr: `failed to spawn ${body.command}`,
              exitCode: 127,
            });
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
          return ok({
            processId: `proc-${(counter += 1)}`,
            stdout: stdout.text,
            stderr: stderr.text,
            exitCode,
          });
        }).pipe(Effect.scoped);

      const handle = (
        input: Parameters<CloudflareBridgeConnectionShape["request"]>[0],
      ): Effect.Effect<CloudflareBridgeHttpResponse> =>
        Effect.gen(function* () {
          if (input.path === "/instances" && input.method === "POST") {
            counter += 1;
            const id = `cf-fake-${counter}`;
            const body = (input.body ?? {}) as {
              readonly flavor?: string;
              readonly ports?: ReadonlyArray<number>;
            };
            const flavor = body.flavor ?? "workspace";
            const rootPath = nodePath.join(tmpdir(), "synara-cloudflare-fake", id);
            yield* fs.makeDirectory(rootPath, { recursive: true }).pipe(Effect.orDie);
            const routes =
              flavor === "container"
                ? (body.ports ?? []).map((port) => ({
                    id: `route-${(counter += 1)}`,
                    port,
                    url: null,
                    label: null,
                  }))
                : [];
            const instance: FakeInstance = {
              id,
              flavor,
              status: "running",
              rootPath,
              routes,
              networkPolicy: { defaultEgress: "allow", rules: [] },
              expiresAt: null,
              createdAt: now(),
            };
            instances.set(id, instance);
            return ok(serialize(instance), 201);
          }

          const id = instanceIdFromPath(input.path);
          if (id === null) {
            return { status: 404, json: { error: "not_found", detail: null } };
          }
          const instance = instances.get(id);

          if (input.path === `/instances/${id}` && input.method === "DELETE") {
            if (instance !== undefined) {
              instances.delete(id);
              yield* fs.remove(instance.rootPath, { recursive: true }).pipe(Effect.ignore);
            }
            return ok({ ok: true });
          }
          if (instance === undefined) {
            return notFound();
          }
          if (input.path === `/instances/${id}` && input.method === "GET") {
            return ok(serialize(instance));
          }
          if (input.path.endsWith("/exec") && input.method === "POST") {
            const body = input.body as {
              readonly command: string;
              readonly args?: ReadonlyArray<string>;
              readonly cwd?: string | null;
              readonly env?: Record<string, string>;
            };
            return yield* execReal(instance, body);
          }
          if (input.path.endsWith("/files") && input.method === "PUT") {
            const body = input.body as { readonly path: string; readonly contentBase64: string };
            const target = resolveCwd(instance.rootPath, body.path);
            yield* fs
              .makeDirectory(nodePath.dirname(target), { recursive: true })
              .pipe(Effect.ignore);
            yield* fs
              .writeFileString(target, fromBase64ToText(body.contentBase64))
              .pipe(Effect.orDie);
            return ok({ ok: true });
          }
          if (input.path.endsWith("/files") && input.method === "GET") {
            const path = input.query?.path;
            if (path === undefined) {
              return { status: 404, json: { error: "file_not_found", detail: null } };
            }
            const target = resolveCwd(instance.rootPath, path);
            const content = yield* fs.readFileString(target).pipe(
              Effect.map((text): string | undefined => text),
              Effect.orElseSucceed(() => undefined),
            );
            if (content === undefined) {
              return { status: 404, json: { error: "file_not_found", detail: null } };
            }
            return ok({ path, contentBase64: toBase64(content), truncated: false });
          }
          if (input.path.endsWith("/ports") && input.method === "POST") {
            const body = input.body as { readonly port: number; readonly label?: string | null };
            const route = {
              id: `route-${(counter += 1)}`,
              port: body.port,
              url: `https://port-${body.port}.example.workers.dev`,
              label: body.label ?? null,
            };
            instance.routes.push(route);
            return ok(route, 201);
          }
          if (input.path.endsWith("/network-policy") && input.method === "PUT") {
            const body = input.body as {
              readonly defaultEgress: string;
              readonly rules?: ReadonlyArray<unknown>;
            };
            instance.networkPolicy = {
              defaultEgress: body.defaultEgress,
              rules: body.rules ?? [],
            };
            return ok({ ok: true });
          }
          if (input.path.endsWith("/renew-activity") && input.method === "POST") {
            const body = input.body as { readonly extendSeconds?: number };
            const extend = body.extendSeconds ?? 300;
            instance.expiresAt = new Date(Date.now() + extend * 1000).toISOString();
            return ok({ expiresAt: instance.expiresAt, remainingSeconds: extend });
          }
          return { status: 404, json: { error: "unknown_route", detail: null } };
        });

      const request: CloudflareBridgeConnectionShape["request"] = (input) => handle(input);

      const connectWebSocket: CloudflareBridgeConnectionShape["connectWebSocket"] = (input) =>
        Effect.gen(function* () {
          const id = instanceIdFromPath(input.path);
          const instance = id === null ? undefined : instances.get(id);
          if (instance === undefined) {
            return yield* Effect.fail(
              new CloudflareBridgeError({
                operation: `WS ${input.path}`,
                status: 404,
                detail: "instance_not_found",
              }),
            );
          }

          const rawCommand = input.query?.command;
          const command = typeof rawCommand === "string" ? rawCommand : undefined;
          const rawArg = input.query?.arg;
          const args: ReadonlyArray<string> = Array.isArray(rawArg)
            ? rawArg
            : typeof rawArg === "string"
              ? [rawArg]
              : [];
          const rawCwd = input.query?.cwd;
          const cwd = resolveCwd(instance.rootPath, typeof rawCwd === "string" ? rawCwd : null);
          const childScope = yield* Scope.make();
          const messageHandlers: Array<(data: string) => void> = [];
          const closeHandlers: Array<() => void> = [];
          const stdinQueue = yield* Queue.unbounded<Uint8Array>();
          let closed = false;

          const closeSocket = Effect.suspend(() => {
            if (closed) {
              return Effect.void;
            }
            closed = true;
            for (const handler of closeHandlers) {
              handler();
            }
            return Scope.close(childScope, Exit.void);
          });

          // Spawn the real terminal command and forward it as bridge frames. The
          // harness opens a transport against `node -e <echo script>`, so a real
          // process roundtrips stdin -> stdout, proving transport-agnosticism.
          if (command !== undefined && command.length > 0) {
            const spawned = yield* spawner
              .spawn(ChildProcess.make(command, [...args], { cwd }))
              .pipe(Effect.provideService(Scope.Scope, childScope), Effect.exit);
            if (Exit.isSuccess(spawned)) {
              const child = spawned.value;
              yield* child.stdout.pipe(
                Stream.decodeText(),
                Stream.runForEach((chunk) =>
                  Effect.sync(() => {
                    for (const handler of messageHandlers) {
                      handler(JSON.stringify({ _tag: "data", data: chunk }));
                    }
                  }),
                ),
                Effect.ignore,
                Effect.forkIn(childScope),
              );
              yield* Stream.fromQueue(stdinQueue).pipe(
                Stream.run(child.stdin),
                Effect.ignore,
                Effect.forkIn(childScope),
              );
              yield* child.exitCode.pipe(
                Effect.matchCause({
                  onSuccess: (code): number | null => Number(code),
                  onFailure: (): number | null => null,
                }),
                Effect.flatMap((exitCode) =>
                  Effect.sync(() => {
                    for (const handler of messageHandlers) {
                      handler(JSON.stringify({ _tag: "exit", exitCode }));
                    }
                  }),
                ),
                Effect.forkIn(childScope),
              );
            }
          }

          const socket: BridgeWebSocket = {
            send: (data) => {
              let frame: { _tag?: string; data?: string };
              try {
                frame = JSON.parse(data) as { _tag?: string; data?: string };
              } catch {
                return;
              }
              if (frame._tag === "stdin" && frame.data !== undefined) {
                Effect.runFork(Queue.offer(stdinQueue, encoder.encode(frame.data)));
              }
            },
            close: () => {
              Effect.runFork(closeSocket);
            },
            onMessage: (handler) => {
              messageHandlers.push(handler);
            },
            onClose: (handler) => {
              closeHandlers.push(handler);
            },
          };
          lastTerminal = { closed: () => closed };
          return socket;
        });

      return { request, connectWebSocket } satisfies CloudflareBridgeConnectionShape;
    }),
  );

  return { layer, controller };
};

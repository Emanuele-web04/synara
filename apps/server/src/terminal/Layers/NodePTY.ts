import { createRequire } from "node:module";

import { Effect, FileSystem, Layer, Path } from "effect";
import {
  PtyAdapter,
  PtyAdapterShape,
  PtyExitEvent,
  PtyProcess,
  PtySpawnInput,
  PtySpawnError,
} from "../Services/PTY";

type NodePtyModule = typeof import("node-pty");
type NodePtyLoader = () => Promise<NodePtyModule>;

let didEnsureSpawnHelperExecutable = false;

const resolveNodePtySpawnHelperPath = Effect.gen(function* () {
  const requireForNodePty = createRequire(import.meta.url);
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  const packageJsonPath = requireForNodePty.resolve("node-pty/package.json");
  const packageDir = path.dirname(packageJsonPath);
  const candidates = [
    path.join(packageDir, "build", "Release", "spawn-helper"),
    path.join(packageDir, "build", "Debug", "spawn-helper"),
    path.join(packageDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  ];

  for (const candidate of candidates) {
    if (yield* fs.exists(candidate)) {
      return candidate;
    }
  }
  return null;
}).pipe(Effect.orElseSucceed(() => null));

export const ensureNodePtySpawnHelperExecutable = Effect.fn(function* (explicitPath?: string) {
  const fs = yield* FileSystem.FileSystem;
  if (process.platform === "win32") return;
  if (!explicitPath && didEnsureSpawnHelperExecutable) return;

  const helperPath = explicitPath ?? (yield* resolveNodePtySpawnHelperPath);
  if (!helperPath) return;
  if (!explicitPath) {
    didEnsureSpawnHelperExecutable = true;
  }

  if (!(yield* fs.exists(helperPath))) {
    return;
  }

  // avoid FileSystem.stat in packaged mode where fs metadata can be missing
  yield* fs.chmod(helperPath, 0o755).pipe(Effect.orElseSucceed(() => undefined));
});

class NodePtyProcess implements PtyProcess {
  constructor(private readonly process: import("node-pty").IPty) {}

  get pid(): number {
    return this.process.pid;
  }

  write(data: string): void {
    this.process.write(data);
  }

  resize(cols: number, rows: number): void {
    this.process.resize(cols, rows);
  }

  kill(signal?: string): void {
    this.process.kill(signal);
  }

  pause(): void {
    this.process.pause();
  }

  resume(): void {
    this.process.resume();
  }

  onData(callback: (data: string) => void): () => void {
    const disposable = this.process.onData(callback);
    return () => {
      disposable.dispose();
    };
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    const disposable = this.process.onExit((event) => {
      callback({
        exitCode: event.exitCode,
        signal: event.signal ?? null,
      });
    });
    return () => {
      disposable.dispose();
    };
  }
}

// injectable loader keeps startup/lazy-load behavior testable
export const makeNodePtyLayer = (loadNodePtyModule: NodePtyLoader = () => import("node-pty")) =>
  Layer.effect(
    PtyAdapter,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      // lazy-load node-pty so a bad packaged native binding can't crash server startup
      const loadNodePty = yield* Effect.cached(
        Effect.tryPromise({
          try: loadNodePtyModule,
          catch: (cause) =>
            new PtySpawnError({
              adapter: "node-pty",
              message: "Failed to load node-pty native module",
              cause,
            }),
        }),
      );
      const ensureNodePtySpawnHelperExecutableCached = yield* Effect.cached(
        ensureNodePtySpawnHelperExecutable().pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.orElseSucceed(() => undefined),
        ),
      );

      return {
        spawn: Effect.fn(function* (input: PtySpawnInput) {
          const nodePty = yield* loadNodePty;
          yield* ensureNodePtySpawnHelperExecutableCached;
          const ptyProcess = yield* Effect.try({
            try: () =>
              nodePty.spawn(input.shell, input.args ?? [], {
                cwd: input.cwd,
                cols: input.cols,
                rows: input.rows,
                env: input.env,
                name: globalThis.process.platform === "win32" ? "xterm-color" : "xterm-256color",
              }),
            catch: (cause) =>
              new PtySpawnError({
                adapter: "node-pty",
                message: "Failed to spawn PTY process",
                cause,
              }),
          });
          return new NodePtyProcess(ptyProcess);
        }),
      } satisfies PtyAdapterShape;
    }),
  );

export const layer = makeNodePtyLayer();

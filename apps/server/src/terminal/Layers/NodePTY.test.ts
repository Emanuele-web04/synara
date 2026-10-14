import { FileSystem, Path, Effect } from "effect";
import { assert, it } from "@effect/vitest";

import { PtyAdapter } from "../Services/PTY";
import { ensureNodePtySpawnHelperExecutable, makeNodePtyLayer } from "./NodePTY";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { prepareProcess } from "@synara/shared/platformProcess";

it.layer(NodeServices.layer)("ensureNodePtySpawnHelperExecutable", (it) => {
  it.effect("adds executable bits when helper exists but is not executable", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pty-helper-test-" });
      const helperPath = path.join(dir, "spawn-helper");
      yield* fs.writeFileString(helperPath, "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(helperPath, 0o644);

      yield* ensureNodePtySpawnHelperExecutable(helperPath);

      const mode = (yield* fs.stat(helperPath)).mode & 0o777;
      assert.equal(mode & 0o111, 0o111);
    }),
  );

  it.effect("keeps executable helper as executable", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pty-helper-test-" });
      const helperPath = path.join(dir, "spawn-helper");
      yield* fs.writeFileString(helperPath, "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(helperPath, 0o755);

      yield* ensureNodePtySpawnHelperExecutable(helperPath);

      const mode = (yield* fs.stat(helperPath)).mode & 0o777;
      assert.equal(mode & 0o111, 0o111);
    }),
  );

  it.effect("defers node-pty native loading until a terminal is spawned", () => {
    let loadCalls = 0;

    return Effect.gen(function* () {
      const adapter = yield* PtyAdapter;
      assert.equal(loadCalls, 0);

      const error = yield* adapter
        .spawn({
          shell: "/bin/sh",
          args: ["-lc", "exit 0"],
          cwd: process.cwd(),
          cols: 80,
          rows: 24,
          env: {},
        })
        .pipe(Effect.flip);

      assert.equal(loadCalls, 1);
      assert.equal(error._tag, "PtySpawnError");
      assert.equal(error.message, "Failed to load node-pty native module");
    }).pipe(
      Effect.provide(
        makeNodePtyLayer(async () => {
          loadCalls += 1;
          throw new Error("native binding missing");
        }),
      ),
    );
  });

  it.effect("preserves the prepared Windows batch command line at the node-pty boundary", () => {
    let received: string | string[] | undefined;
    const plan = prepareProcess("C:\\Program Files\\provider.cmd", ["auth", "login"], {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    });
    return Effect.gen(function* () {
      const adapter = yield* PtyAdapter;
      yield* adapter
        .spawn({
          shell: plan.command,
          args: plan.args,
          ...(plan.windowsVerbatimArguments
            ? { windowsVerbatimArguments: plan.windowsVerbatimArguments }
            : {}),
          cwd: process.cwd(),
          cols: 80,
          rows: 24,
          env: {},
        })
        .pipe(Effect.flip);
      assert.equal(
        received,
        '/d /s /v:off /c call "C:\\Program Files\\provider.cmd" "auth" "login"',
      );
    }).pipe(
      Effect.provide(
        makeNodePtyLayer(async () => {
          const native = await import("node-pty");
          const intercepted: typeof native = {
            ...native,
            spawn(_file, args) {
              received = args;
              throw new Error("Fixture stops before starting a native process.");
            },
          };
          return intercepted;
        }),
      ),
    );
  });
});

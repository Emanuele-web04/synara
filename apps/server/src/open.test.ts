import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { assertSuccess } from "@effect/vitest/utils";
import { FileSystem, Path, Effect } from "effect";

import {
  isCommandAvailable,
  launchDetached,
  resolveAvailableEditors,
  resolveEditorLaunch,
} from "./open";

it.layer(NodeServices.layer)("resolveEditorLaunch", (it) => {
  it.effect("returns commands for command-based editors", () =>
    Effect.gen(function* () {
      const antigravityLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "antigravity" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(antigravityLaunch, {
        command: "agy",
        args: ["/tmp/workspace"],
      });

      const cursorLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "cursor" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(cursorLaunch, {
        command: "cursor",
        args: ["/tmp/workspace"],
      });

      const vscodeLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "vscode" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(vscodeLaunch, {
        command: "code",
        args: ["/tmp/workspace"],
      });

      const traeLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "trae" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(traeLaunch, {
        command: "trae",
        args: ["/tmp/workspace"],
      });

      const zedLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "zed" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(zedLaunch, {
        command: "zed",
        args: ["/tmp/workspace"],
      });

      const windsurfLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "windsurf" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(windsurfLaunch, {
        command: "windsurf",
        args: ["/tmp/workspace"],
      });

      const sublimeLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "sublime" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(sublimeLaunch, {
        command: "subl",
        args: ["/tmp/workspace"],
      });

      const ideaLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "idea" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(ideaLaunch, {
        command: "idea",
        args: ["/tmp/workspace"],
      });
    }),
  );

  it.effect("uses --goto when editor supports line/column suffixes", () =>
    Effect.gen(function* () {
      const lineOnly = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/AGENTS.md:48", editor: "cursor" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(lineOnly, {
        command: "cursor",
        args: ["--goto", "/tmp/workspace/AGENTS.md:48"],
      });

      const lineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "cursor" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(lineAndColumn, {
        command: "cursor",
        args: ["--goto", "/tmp/workspace/src/open.ts:71:5"],
      });

      const vscodeLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "vscode" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(vscodeLineAndColumn, {
        command: "code",
        args: ["--goto", "/tmp/workspace/src/open.ts:71:5"],
      });

      const ideaLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "idea" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(ideaLineAndColumn, {
        command: "idea",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/open.ts"],
      });

      const zedLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "zed" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(zedLineAndColumn, {
        command: "zed",
        args: ["/tmp/workspace/src/open.ts:71:5"],
      });
    }),
  );

  it.effect("opens terminal-style editors in the target working directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-terminal-" });
      const filePath = path.join(dir, "src", "open.ts");
      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fs.writeFileString(filePath, "export const value = 1;\n");

      const ghosttyLaunch = yield* resolveEditorLaunch(
        { cwd: `${filePath}:71:5`, editor: "ghostty" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(ghosttyLaunch, {
        command: "ghostty",
        args: [`--working-directory=${path.dirname(filePath)}`],
      });

      const binDir = path.join(dir, "bin");
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.writeFileString(path.join(binDir, "konsole"), "#!/bin/sh\n");
      yield* fs.chmod(path.join(binDir, "konsole"), 0o755);

      const linuxTerminalLaunch = yield* resolveEditorLaunch(
        { cwd: `${filePath}:71:5`, editor: "terminal" },
        "linux",
        { PATH: binDir },
      );
      assert.deepEqual(linuxTerminalLaunch, {
        command: "konsole",
        args: ["--workdir", path.dirname(filePath)],
      });

      const linuxTerminalFallbackLaunch = yield* resolveEditorLaunch(
        { cwd: `${filePath}:71:5`, editor: "terminal" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(linuxTerminalFallbackLaunch, {
        command: "x-terminal-emulator",
        args: [`--working-directory=${path.dirname(filePath)}`],
      });

      yield* fs.writeFileString(path.join(binDir, "wt.CMD"), "@echo off\r\n");
      const windowsTerminalLaunch = yield* resolveEditorLaunch(
        { cwd: "C:\\workspace", editor: "terminal" },
        "win32",
        { PATH: binDir, PATHEXT: ".CMD" },
      );
      assert.deepEqual(windowsTerminalLaunch, {
        command: "wt",
        args: ["-d", "C:\\workspace"],
      });
    }),
  );

  it.effect("falls back to installed macOS app bundles when launchers are absent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-apps-" });
      yield* fs.makeDirectory(path.join(home, "Applications", "Ghostty.app"), {
        recursive: true,
      });
      yield* fs.makeDirectory(path.join(home, "Applications", "WebStorm.app"), {
        recursive: true,
      });
      yield* fs.makeDirectory(path.join(home, "Applications", "JetBrains Toolbox", "PyCharm.app"), {
        recursive: true,
      });

      const ghosttyLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "ghostty" },
        "darwin",
        { HOME: home, PATH: "" },
      );
      assert.deepEqual(ghosttyLaunch, {
        command: "open",
        args: ["-a", "Ghostty", "/tmp/workspace"],
      });

      const terminalLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "terminal" },
        "darwin",
        { HOME: home, PATH: "" },
      );
      assert.deepEqual(terminalLaunch, {
        command: "open",
        args: ["-a", "Terminal", "/tmp/workspace"],
      });

      const webstormLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "webstorm" },
        "darwin",
        { HOME: home, PATH: "" },
      );
      assert.deepEqual(webstormLaunch, {
        command: "open",
        args: [
          "-a",
          "WebStorm",
          "--args",
          "--line",
          "71",
          "--column",
          "5",
          "/tmp/workspace/src/open.ts",
        ],
      });

      const availableEditors = resolveAvailableEditors("darwin", { HOME: home, PATH: "" });
      assert.equal(availableEditors.includes("ghostty"), true);
      assert.equal(availableEditors.includes("webstorm"), true);
      assert.equal(availableEditors.includes("pycharm"), true);
    }),
  );

  it.effect("prefers the macOS Ghostty app launch even when a ghostty command is on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-ghostty-" });
      const binDir = path.join(home, "bin");
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.writeFileString(path.join(binDir, "ghostty"), "#!/bin/sh\n");
      yield* fs.chmod(path.join(binDir, "ghostty"), 0o755);
      yield* fs.makeDirectory(path.join(home, "Applications", "Ghostty.app"), {
        recursive: true,
      });

      const launch = yield* resolveEditorLaunch(
        { cwd: "/tmp/with space/workspace", editor: "ghostty" },
        "darwin",
        { HOME: home, PATH: binDir },
      );

      assert.deepEqual(launch, {
        command: "open",
        args: ["-a", "Ghostty", "/tmp/with space/workspace"],
      });
    }),
  );

  it.effect("maps file-manager editor to OS open commands", () =>
    Effect.gen(function* () {
      const launch1 = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "file-manager" },
        "darwin",
      );
      assert.deepEqual(launch1, {
        command: "open",
        args: ["/tmp/workspace"],
      });

      const launch2 = yield* resolveEditorLaunch(
        { cwd: "C:\\workspace", editor: "file-manager" },
        "win32",
      );
      assert.deepEqual(launch2, {
        command: "explorer",
        args: ["C:\\workspace"],
      });

      const launch3 = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "file-manager" },
        "linux",
      );
      assert.deepEqual(launch3, {
        command: "xdg-open",
        args: ["/tmp/workspace"],
      });
    }),
  );
});

it.layer(NodeServices.layer)("launchDetached", (it) => {
  it.effect("resolves when command can be spawned", () =>
    Effect.gen(function* () {
      const result = yield* launchDetached({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      }).pipe(Effect.result);
      assertSuccess(result, undefined);
    }),
  );

  it.effect("rejects when command does not exist", () =>
    Effect.gen(function* () {
      const result = yield* launchDetached({
        command: `t3code-no-such-command-${Date.now()}`,
        args: [],
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }),
  );
});

it.layer(NodeServices.layer)("isCommandAvailable", (it) => {
  it.effect("resolves win32 commands with PATHEXT", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-test-" });
      yield* fs.writeFileString(path.join(dir, "code.CMD"), "@echo off\r\n");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("code", { platform: "win32", env }), true);
    }),
  );

  it("returns false when a command is not on PATH", () => {
    const env = {
      PATH: "",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    } satisfies NodeJS.ProcessEnv;
    assert.equal(isCommandAvailable("definitely-not-installed", { platform: "win32", env }), false);
  });

  it.effect("does not treat bare files without executable extension as available on win32", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-test-" });
      yield* fs.writeFileString(path.join(dir, "npm"), "echo nope\r\n");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("npm", { platform: "win32", env }), false);
    }),
  );

  it.effect("appends PATHEXT for commands with non-executable extensions on win32", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-test-" });
      yield* fs.writeFileString(path.join(dir, "my.tool.CMD"), "@echo off\r\n");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("my.tool", { platform: "win32", env }), true);
    }),
  );

  it.effect("uses platform-specific PATH delimiter for platform overrides", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const firstDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-test-" });
      const secondDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-test-" });
      yield* fs.writeFileString(path.join(firstDir, "code.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(secondDir, "code.CMD"), "MZ");
      const env = {
        PATH: `${firstDir};${secondDir}`,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("code", { platform: "win32", env }), true);
    }),
  );
});

it.layer(NodeServices.layer)("resolveAvailableEditors", (it) => {
  it.effect("returns installed editors for command launches", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-editors-" });

      yield* fs.writeFileString(path.join(dir, "cursor.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "code-insiders.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "zeditor.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "explorer.CMD"), "MZ");
      const editors = resolveAvailableEditors("win32", {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      });
      assert.deepEqual(editors, ["cursor", "vscode-insiders", "zed", "file-manager"]);
    }),
  );
});

import { describe, expect, it } from "vitest";
import { matchesGlob } from "node:path";
import { desktopPackageFiles, includeDesktopDependencySources } from "./desktop-package-files.ts";

const ships = (platform: "mac" | "linux" | "win", file: string, diagnostics = false) =>
  !desktopPackageFiles(platform, diagnostics).some(
    (pattern) => pattern.startsWith("!") && matchesGlob(file, pattern.slice(1)),
  );

describe("desktop package file policy", () => {
  it("preserves executable code, runtime TS, licenses, native bindings and language data", () => {
    for (const platform of ["mac", "linux", "win"] as const) {
      for (const file of [
        "node_modules/effect/dist/Effect.js",
        "node_modules/@effect/platform-node-shared/dist/NodeChildProcessSpawner.js",
        "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
        "node_modules/agent-extension/tool.ts",
        "node_modules/agent-extension/data.map",
        "node_modules/effect/LICENSE",
        "node_modules/@earendil-works/pi-coding-agent/docs/extensions.md",
        "node_modules/node-pty/build/Release/pty.node",
        "node_modules/node-pty/build/Release/spawn-helper",
        "node_modules/@shikijs/langs/dist/typescript.mjs",
        "apps/server/dist/client/assets/app.js.br",
        "apps/server/dist/client/assets/app.js.gz",
        "apps/server/dist/index.mjs.map",
      ])
        expect(ships(platform, file), `${platform}: ${file}`).toBe(true);
    }
  });

  it("omits only known dependency diagnostics and restores them for diagnostic builds", () => {
    for (const file of [
      "node_modules/effect/src/Effect.ts",
      "node_modules/@effect/platform-node/src/NodeRuntime.ts",
      "node_modules/@effect/platform-node-shared/src/NodeChildProcessSpawner.ts",
      "node_modules/example/index.js.map",
      "node_modules/example/index.mjs.map",
      "node_modules/example/index.cjs.map",
      "node_modules/example/index.d.ts.map",
      "node_modules/example/index.d.mts.map",
      "node_modules/example/index.d.mts",
      "node_modules/example/index.d.cts",
    ]) {
      expect(ships("linux", file)).toBe(false);
      expect(ships("linux", file, true)).toBe(true);
    }
  });

  it("preserves all platform-specific icon choices and notification fallbacks", () => {
    const resources = {
      mac: ["dock-icon.png", "dock-icon-dark.png", "app-icon-macos.png"],
      linux: ["icon.png", "app-icon-linux.png", "synara.png"],
      win: ["icon.ico", "app-icon-windows.ico", "synara.png"],
    } as const;
    for (const platform of ["mac", "linux", "win"] as const) {
      for (const file of resources[platform]) {
        expect(ships(platform, `apps/desktop/prod-resources/${file}`)).toBe(true);
      }
      expect(ships(platform, "apps/desktop/prod-resources/new-runtime-asset.png")).toBe(true);
      expect(ships(platform, "apps/desktop/prod-resources/icon.icns")).toBe(false);
      // Build resources themselves must still be available to electron-builder.
      expect(ships(platform, "apps/desktop/resources/icon.icns")).toBe(true);
    }
    expect(ships("mac", "apps/desktop/prod-resources/app-icon-linux.png")).toBe(false);
    expect(ships("linux", "apps/desktop/prod-resources/app-icon-macos.png")).toBe(false);
    expect(ships("win", "apps/desktop/prod-resources/app-icon-linux.png")).toBe(false);
  });

  it("keeps native binaries for the target, including both universal Mac architectures", () => {
    for (const arch of ["x64", "arm64"]) {
      expect(
        ships("linux", `node_modules/@anthropic-ai/claude-agent-sdk-linux-${arch}/claude`),
      ).toBe(true);
      expect(
        ships("linux", `node_modules/@anthropic-ai/claude-agent-sdk-linux-${arch}-musl/claude`),
      ).toBe(false);
      expect(
        ships("mac", `node_modules/@anthropic-ai/claude-agent-sdk-darwin-${arch}/claude`),
      ).toBe(true);
      expect(
        ships("win", `node_modules/@anthropic-ai/claude-agent-sdk-win32-${arch}/claude.exe`),
      ).toBe(true);
      expect(ships("mac", `node_modules/node-pty/prebuilds/darwin-${arch}/pty.node`)).toBe(true);
      expect(ships("linux", `node_modules/node-pty/prebuilds/darwin-${arch}/pty.node`)).toBe(false);
      expect(ships("win", `node_modules/node-pty/prebuilds/win32-${arch}/conpty.node`)).toBe(true);
      expect(ships("mac", `node_modules/node-pty/prebuilds/win32-${arch}/conpty.node`)).toBe(false);
    }
  });

  it("recognizes each existing diagnostic source-map opt-in without treating false as true", () => {
    expect(includeDesktopDependencySources({})).toBe(false);
    for (const key of [
      "SYNARA_DESKTOP_SOURCEMAP",
      "SYNARA_SERVER_SOURCEMAP",
      "SYNARA_WEB_SOURCEMAP",
    ]) {
      for (const value of ["1", "true", " TRUE ", "hidden"]) {
        expect(includeDesktopDependencySources({ [key]: value })).toBe(true);
      }
      for (const value of ["", "0", "false"]) {
        expect(includeDesktopDependencySources({ [key]: value })).toBe(false);
      }
    }
  });
});

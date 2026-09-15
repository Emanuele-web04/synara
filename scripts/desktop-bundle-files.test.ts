import { describe, expect, it } from "vitest";

import {
  createDesktopBundleFilePatterns,
  preserveDependencyDiagnostics,
} from "./lib/desktop-bundle-files.ts";

// These are the real platform preference names, not a second copy of the UI map.
import { desktopAppIconResourceName } from "../apps/desktop/src/desktopAppIcon.ts";

import { matchesGlob } from "node:path";

function excluded(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => pattern.startsWith("!") && matchesGlob(path, pattern.slice(1)));
}

describe("desktop bundle file selection", () => {
  it("drops dependency diagnostics by default, not executable JavaScript or runtime helper sources", () => {
    const patterns = createDesktopBundleFilePatterns("mac");
    for (const path of [
      "node_modules/effect/dist/Effect.js.map",
      "node_modules/openai/index.d.mts",
      "node_modules/effect/src/Effect.ts",
      "node_modules/@effect/platform-node-shared/src/ChildProcess.ts",
    ]) {
      expect(excluded(path, patterns), path).toBe(true);
    }
    for (const path of [
      "node_modules/effect/dist/Effect.js",
      "node_modules/effect/package.json",
      "node_modules/@effect/platform-node-shared/dist/ChildProcess.js",
      "node_modules/custom-extension/src/index.ts",
      "apps/server/dist/device-helper/Sources/main.swift",
      "node_modules/node-pty/build/Release/pty.node",
      "node_modules/node-pty/build/Release/spawn-helper",
      "node_modules/@anthropic-ai/sdk/index.mjs",
    ]) {
      expect(excluded(path, patterns), path).toBe(false);
    }
  });

  it("retains dependency source maps and sources in diagnostic builds", () => {
    for (const name of [
      "SYNARA_WEB_SOURCEMAP",
      "SYNARA_SERVER_SOURCEMAP",
      "SYNARA_DESKTOP_SOURCEMAP",
    ]) {
      for (const value of ["1", " true ", "HIDDEN"]) {
        const diagnostics = preserveDependencyDiagnostics({ [name]: value });
        expect(diagnostics).toBe(true);
        const patterns = createDesktopBundleFilePatterns("linux", { diagnostics });
        expect(excluded("node_modules/effect/dist/Effect.js.map", patterns)).toBe(false);
        expect(excluded("node_modules/effect/src/Effect.ts", patterns)).toBe(false);
      }
    }
    expect(preserveDependencyDiagnostics({})).toBe(false);
    expect(preserveDependencyDiagnostics({ SYNARA_SERVER_SOURCEMAP: "false" })).toBe(false);
  });

  it("only removes the musl SDK executable for a confirmed glibc Linux build", () => {
    const musl = "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude";
    expect(excluded(musl, createDesktopBundleFilePatterns("linux"))).toBe(false);
    expect(excluded(musl, createDesktopBundleFilePatterns("mac", { linuxGlibc: true }))).toBe(
      false,
    );
    const patterns = createDesktopBundleFilePatterns("linux", { linuxGlibc: true });
    expect(excluded(musl, patterns)).toBe(true);
    expect(excluded("node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude", patterns)).toBe(
      false,
    );
  });

  it("preserves every supported icon preference and menu fallback", () => {
    for (const [platform, host] of [
      ["mac", "darwin"],
      ["linux", "linux"],
      ["win", "win32"],
    ] as const) {
      const patterns = createDesktopBundleFilePatterns(platform);
      for (const icon of ["default", "icon", "dark"] as const) {
        for (const isDarkAppearance of [true, false]) {
          const name = desktopAppIconResourceName({ platform: host, icon, isDarkAppearance });
          expect(
            excluded(`apps/desktop/prod-resources/${name}`, patterns),
            `${platform}/${name}`,
          ).toBe(false);
        }
      }
      expect(excluded("apps/desktop/prod-resources/synara.png", patterns)).toBe(false);
      expect(excluded("apps/desktop/resources/entitlements.mac.plist", patterns)).toBe(false);
    }
  });

  it("keeps native PTY prebuilds for the target platform, including both Mac architectures", () => {
    const mac = createDesktopBundleFilePatterns("mac");
    expect(excluded("node_modules/node-pty/prebuilds/darwin-arm64/pty.node", mac)).toBe(false);
    expect(excluded("node_modules/node-pty/prebuilds/darwin-x64/spawn-helper", mac)).toBe(false);
    expect(excluded("node_modules/node-pty/prebuilds/win32-x64/pty.node", mac)).toBe(true);
    const win = createDesktopBundleFilePatterns("win");
    expect(excluded("node_modules/node-pty/prebuilds/win32-x64/conpty.node", win)).toBe(false);
    expect(excluded("node_modules/node-pty/prebuilds/darwin-arm64/pty.node", win)).toBe(true);
  });
});

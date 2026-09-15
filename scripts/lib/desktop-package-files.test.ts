import { describe, expect, it } from "vitest";

import { createDesktopPlatformBuildConfig } from "./desktop-platform-build-config.ts";
import {
  desktopDependencyFileExclusions,
  desktopPlatformFileExclusions,
} from "./desktop-package-files.ts";

describe("desktop production file policy", () => {
  it("omits dependency maps and only audited compiled source trees by default", () => {
    const files = desktopDependencyFileExclusions();
    expect(files).toContain("!**/node_modules/**/*.{js,mjs,cjs,ts,mts,cts}.map");
    expect(files).toContain("!**/node_modules/effect/src/**");
    expect(files).toContain("!**/node_modules/@anthropic-ai/sdk/src/**");
    expect(files).not.toContain("!**/node_modules/**/src/**");
    // Agent docs, TypeScript extensions, declaration files, and source-only
    // packages are runtime inputs; do not replace the allowlist with broad globs.
    expect(files.some((file) => /pi-|examples|docs|\.d\.ts|\.swift/.test(file))).toBe(false);
  });

  it("restores dependency debugging inputs in diagnostic builds", () => {
    expect(desktopDependencyFileExclusions(true)).toEqual(["!**/node_modules/**/*.tsbuildinfo"]);
    const config = createDesktopPlatformBuildConfig({
      platform: "mac",
      target: "dmg",
      includeDependencySources: true,
    });
    expect(config.files).not.toContain("!**/node_modules/effect/src/**");
    expect(config.files).toContain("!apps/desktop/native/appsnap/build/**");
    expect(config.extraFiles).toContainEqual({
      from: "apps/server/dist/device-helper",
      to: "Resources/device-helper",
    });
  });

  for (const [platform, nodePlatform, icons] of [
    ["mac", "darwin", ["dock-icon.png", "dock-icon-dark.png", "app-icon-macos.png", "synara.png"]],
    ["linux", "linux", ["icon.png", "app-icon-linux.png", "synara.png"]],
    ["win", "win32", ["icon.ico", "app-icon-windows.ico", "synara.png"]],
  ] as const) {
    it(`retains ${platform} icon choices, notifications, and native PTY fallbacks`, () => {
      const exclusions = desktopPlatformFileExclusions(platform);
      for (const icon of icons) {
        expect(exclusions).not.toContain(`!apps/desktop/prod-resources/${icon}`);
      }
      expect(exclusions).not.toContain(`!**/node_modules/node-pty/prebuilds/${nodePlatform}-*/**`);
      expect(exclusions.some((file) => file.includes("build/Release"))).toBe(false);
      expect(exclusions.some((file) => file.includes("apps/desktop/resources/"))).toBe(false);
      const config = createDesktopPlatformBuildConfig({ platform, target: "dir" });
      expect(config.files?.[0]).toBe("**/*");
      expect(config.files).toContain("!**/node_modules/effect/src/**");
      expect(config.asarUnpack).toEqual(["node_modules/node-pty/**"]);
    });
  }
});

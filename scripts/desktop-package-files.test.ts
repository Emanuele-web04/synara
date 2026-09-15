import { matchesGlob } from "node:path";
import { assert, describe, it } from "@effect/vitest";

import {
  createDesktopPackageFilePatterns,
  type DesktopPackagePlatform,
} from "./lib/desktop-package-files.ts";

function ships(
  path: string,
  platform: DesktopPackagePlatform = "linux",
  environment: Readonly<Record<string, string | undefined>> = {},
): boolean {
  const patterns = createDesktopPackageFilePatterns(platform, environment);
  assert.equal(patterns[0], "**/*");
  return !patterns.slice(1).some((pattern) => matchesGlob(path, pattern.slice(1)));
}

describe("desktop package file policy", () => {
  it("removes only audited source/debug files, including nested SDK dependencies", () => {
    for (const path of [
      "node_modules/effect/src/Effect.ts",
      "node_modules/@effect/platform-node-shared/src/NodeChildProcessSpawner.ts",
      "node_modules/openai/src/client.ts",
      "node_modules/zod/src/index.ts",
      "node_modules/@earendil-works/pi-ai/node_modules/@anthropic-ai/sdk/src/client.ts",
      "node_modules/@pierre/diffs/dist/index.js.map",
      "node_modules/effect/dist/index.d.ts.map",
      "node_modules/node-pty/lib/unixTerminal.test.js",
      "node_modules/openai/index.d.mts",
      "node_modules/zod/index.d.cts",
      "node_modules/gaxios/build/tsconfig.tsbuildinfo",
    ])
      assert.equal(ships(path), false, path);

    for (const path of [
      "node_modules/effect/dist/Effect.js",
      "node_modules/@effect/platform-node-shared/dist/NodeChildProcessSpawner.js",
      "node_modules/openai/client.mjs",
      "node_modules/zod/index.cjs",
      "node_modules/betterwright/dist/src/index.js",
      "node_modules/some-extension/src/index.ts",
      "node_modules/some-extension/src/index.mts",
      "node_modules/some-extension/src/index.cts",
      "node_modules/some-package/data/characters.map",
      "node_modules/@earendil-works/pi-coding-agent/docs/extensions.md",
      "node_modules/@shikijs/langs/dist/italian.mjs",
      "node_modules/effect/LICENSE",
      "apps/server/dist/client/assets/worker.js.br",
      "apps/server/dist/client/assets/worker.js.gz",
      "apps/server/dist/index.mjs.map",
    ])
      assert.equal(ships(path), true, path);
  });

  it("preserves dependency sources and maps in opt-in diagnostic builds", () => {
    for (const key of [
      "SYNARA_DESKTOP_SOURCEMAP",
      "SYNARA_SERVER_SOURCEMAP",
      "SYNARA_WEB_SOURCEMAP",
    ]) {
      for (const value of ["1", "true", " TRUE ", "hidden"]) {
        assert.equal(ships("node_modules/effect/src/Effect.ts", "mac", { [key]: value }), true);
        assert.equal(
          ships("node_modules/effect/dist/Effect.js.map", "win", { [key]: value }),
          true,
        );
        assert.equal(ships("node_modules/openai/index.d.mts", "mac", { [key]: value }), true);
        assert.equal(ships("node_modules/zod/index.d.cts", "mac", { [key]: value }), true);
      }
      assert.equal(ships("node_modules/effect/src/Effect.ts", "linux", { [key]: "false" }), false);
    }
  });

  it("keeps the primary Claude executable and excludes only Linux musl siblings", () => {
    for (const arch of ["x64", "arm64"]) {
      assert.equal(ships(`node_modules/@anthropic-ai/claude-agent-sdk-linux-${arch}/claude`), true);
      assert.equal(
        ships(`node_modules/@anthropic-ai/claude-agent-sdk-linux-${arch}-musl/claude`),
        false,
      );
      assert.equal(
        ships(`node_modules/@anthropic-ai/claude-agent-sdk-darwin-${arch}/claude`, "mac"),
        true,
      );
      assert.equal(
        ships(`node_modules/@anthropic-ai/claude-agent-sdk-win32-${arch}/claude.exe`, "win"),
        true,
      );
    }
    assert.equal(ships("node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"), true);
  });

  it("keeps native terminal binaries and helper executables for the target platform", () => {
    for (const [platform, nativePlatform] of [
      ["mac", "darwin"],
      ["win", "win32"],
      ["linux", "linux"],
    ] as const) {
      for (const target of ["darwin", "win32", "linux"]) {
        for (const arch of ["x64", "arm64"]) {
          assert.equal(
            ships(`node_modules/node-pty/prebuilds/${target}-${arch}/pty.node`, platform),
            target === nativePlatform,
          );
        }
      }
      assert.equal(ships("node_modules/node-pty/build/Release/pty.node", platform), true);
      assert.equal(ships("node_modules/node-pty/build/Release/spawn-helper", platform), true);
    }
  });

  it("preserves every target appearance and notification asset", () => {
    const required = {
      mac: [
        "app-icon-macos.png",
        "dock-icon.png",
        "dock-icon-dark.png",
        "icon.icns",
        "icon.png",
        "synara.png",
      ],
      linux: ["app-icon-linux.png", "icon.png", "synara.png"],
      win: ["app-icon-windows.ico", "icon.ico", "icon.png", "synara.png"],
    } as const;
    for (const platform of ["mac", "linux", "win"] as const) {
      for (const name of required[platform])
        assert.equal(ships(`apps/desktop/prod-resources/${name}`, platform), true);
      assert.equal(ships("apps/desktop/prod-resources/entitlements.mac.plist", platform), false);
      assert.equal(ships("apps/desktop/resources/entitlements.mac.plist", platform), true);
      assert.equal(ships("apps/server/dist/device-helper/build.sh", platform), false);
      for (const suffix of ["", ".gz", ".br"])
        assert.equal(
          ships(`apps/server/dist/client/mockServiceWorker.js${suffix}`, platform),
          false,
        );
    }
    assert.equal(ships("apps/desktop/prod-resources/app-icon-macos.png", "linux"), false);
    assert.equal(ships("apps/desktop/prod-resources/app-icon-linux.png", "mac"), false);
  });
});

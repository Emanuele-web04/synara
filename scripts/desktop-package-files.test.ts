import { assert, describe, it } from "@effect/vitest";

import { desktopPackageFiles, isGlibcRuntime } from "./lib/desktop-package-files.ts";

describe("desktopPackageFiles", () => {
  it("extends default packaging without dropping runtime trees or licenses", () => {
    const files = desktopPackageFiles({ platform: "mac" });
    assert.equal(files[0], "**/*");
    assert.ok(files.includes("!node_modules/**/*.map"));
    assert.ok(files.includes("!node_modules/effect/src/**"));
    assert.ok(files.includes("!node_modules/**/*.{d.mts,d.cts,tsbuildinfo}"));
    assert.ok(!files.includes("!node_modules/**/src/**"));
    assert.ok(!files.some((file) => /LICENSE|locales|prebuilds/.test(file)));
  });

  it("preserves dependency source maps and original sources for diagnostic builds", () => {
    const files = desktopPackageFiles({ platform: "mac", dependencySourcemaps: true });
    assert.ok(!files.includes("!node_modules/**/*.map"));
    assert.ok(!files.includes("!node_modules/effect/src/**"));
  });

  it("removes only the unusable SDK fallback on known glibc Linux hosts", () => {
    const exclusion = "!node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl/**";
    assert.ok(desktopPackageFiles({ platform: "linux", linuxGlibc: true }).includes(exclusion));
    for (const platform of ["linux", "mac", "win"] as const) {
      assert.ok(!desktopPackageFiles({ platform, linuxGlibc: false }).includes(exclusion));
    }
    assert.ok(!desktopPackageFiles({ platform: "linux", linuxGlibc: false }).includes(exclusion));
  });

  it("requires affirmative libc evidence", () => {
    assert.ok(isGlibcRuntime({ header: { glibcVersionRuntime: "2.39" } }));
    for (const report of [
      undefined,
      null,
      {},
      { header: {} },
      { header: { glibcVersionRuntime: "" } },
    ]) {
      assert.equal(isGlibcRuntime(report), false);
    }
  });

  it("keeps each platform's selectable icons and the common notification icon", () => {
    const required = {
      mac: ["app-icon-macos.png", "dock-icon.png", "dock-icon-dark.png", "icon.icns", "icon.png"],
      linux: ["app-icon-linux.png", "icon.png", "synara.png"],
      win: ["app-icon-windows.ico", "icon.ico", "synara.png"],
    } as const;
    for (const platform of ["mac", "linux", "win"] as const) {
      const files = desktopPackageFiles({ platform });
      for (const icon of required[platform]) {
        assert.ok(!files.includes(`!apps/desktop/prod-resources/${icon}`));
      }
    }
  });
});

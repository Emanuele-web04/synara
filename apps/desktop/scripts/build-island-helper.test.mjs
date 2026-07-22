import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  defaultIslandHelperPath,
  liquidGlassArgumentsForSdkVersion,
  swiftTargetsForArch,
} from "./build-island-helper.mjs";

describe("island helper build targets", () => {
  it("maps Electron architectures to macOS 13 Swift targets", () => {
    expect(swiftTargetsForArch("arm64")).toEqual([
      { arch: "arm64", target: "arm64-apple-macos13.0" },
    ]);
    expect(swiftTargetsForArch("x64")).toEqual([
      { arch: "x86_64", target: "x86_64-apple-macos13.0" },
    ]);
    expect(swiftTargetsForArch("universal")).toEqual([
      { arch: "arm64", target: "arm64-apple-macos13.0" },
      { arch: "x86_64", target: "x86_64-apple-macos13.0" },
    ]);
  });

  it("rejects architectures the Swift build does not support", () => {
    expect(() => swiftTargetsForArch("ia32")).toThrow(
      "Unsupported island helper architecture: ia32. Expected arm64, x64, or universal.",
    );
  });

  it("uses the deterministic desktop runtime cache path", () => {
    expect(defaultIslandHelperPath).toBe(
      join(import.meta.dirname, "..", ".electron-runtime", "island", "synara-island-helper"),
    );
  });
});

describe("island helper SDK feature gates", () => {
  it("enables Liquid Glass only for SDK 26 and newer", () => {
    expect(liquidGlassArgumentsForSdkVersion("25.4")).toEqual([]);
    expect(liquidGlassArgumentsForSdkVersion("26.0")).toEqual(["-DSYNARA_HAS_LIQUID_GLASS"]);
    expect(liquidGlassArgumentsForSdkVersion("27.1.2")).toEqual(["-DSYNARA_HAS_LIQUID_GLASS"]);
  });

  it("fails clearly when xcrun reports an unexpected SDK version", () => {
    expect(() => liquidGlassArgumentsForSdkVersion("macOS 26.0")).toThrow(
      'Could not parse the macOS SDK version reported by xcrun: "macOS 26.0".',
    );
  });
});

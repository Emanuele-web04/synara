import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEVICE_HELPER_BINARY_NAME,
  DEVICE_HELPER_CACHE_SEGMENTS,
  deviceHelperCacheKey,
} from "@synara/shared/deviceHelperCache";

import type { ProcessRunResult } from "../processRunner.ts";
import { DEVICE_HELPER_CACHE_ROOT, IosSimulatorBackend } from "./IosSimulatorBackend.ts";

const XCODEBUILD_OUTPUT = "Xcode 26.2\nBuild version 17C52";

function result(stdout: string, code = 0): ProcessRunResult {
  return { stdout, stderr: "", code, signal: null, timedOut: false };
}

/** server and smoke CLI used to derive the cache path independently and disagreed — a passing smoke run left a binary the server never found; these pin the one shared derivation */
describe("helper cache path agreement", () => {
  it("builds into the directory the shared key names", async () => {
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const backend = new IosSimulatorBackend({
      platform: "darwin",
      helperSourceDir: "/tmp/synara-helper-src",
      helperCacheRoot: "/tmp/synara-helper-cache",
      run: async (command, args) => {
        commands.push({ command, args });
        if (command === "xcodebuild") return result(XCODEBUILD_OUTPUT);
        // the build "succeeds" but writes nothing — compilation fails after the output dir is chosen, which is all this test needs to observe
        return result("");
      },
    });

    await backend.compileHelperIfNeeded().catch(() => undefined);

    const build = commands.find((entry) => entry.command === "/bin/sh");
    const expectedKey = deviceHelperCacheKey(XCODEBUILD_OUTPUT)!;
    expect(build?.args[1]).toBe(join("/tmp/synara-helper-cache", expectedKey));
  });

  it("roots the cache where the smoke script writes it", () => {
    expect(DEVICE_HELPER_CACHE_ROOT).toBe(join(homedir(), ...DEVICE_HELPER_CACHE_SEGMENTS));
  });

  it("names the binary the build script produces", () => {
    expect(DEVICE_HELPER_BINARY_NAME).toBe("synara-device-helper");
  });
});

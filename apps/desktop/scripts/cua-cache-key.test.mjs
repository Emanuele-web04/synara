import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cuaBuildFlags,
  cuaCacheKey,
  collectCuaCacheInputs,
  collectCuaFileFingerprints,
} from "./cua-cache-key.mjs";

describe("Cua build cache identity", () => {
  it.each([
    "CARGO_BUILD_RUSTFLAGS",
    "RUSTFLAGS",
    "CARGO_PROFILE_RELEASE_STRIP",
    "CC_aarch64_apple_darwin",
    "PKG_CONFIG_ALL_STATIC",
    "RUSTC_WRAPPER",
    "SDKROOT",
    "MACOSX_DEPLOYMENT_TARGET",
  ])("fingerprints %s", (key) => {
    expect(cuaCacheKey({ flags: cuaBuildFlags({ [key]: "changed" }) })).not.toBe(
      cuaCacheKey({ flags: cuaBuildFlags({}) }),
    );
  });
  it("invalidates only macOS when the macOS staging command changes", () => {
    const scratch = mkdtempSync(join(tmpdir(), "synara-cua-platform-key-"));
    try {
      const root = new URL("../../../", import.meta.url);
      for (const path of [
        "apps/desktop/scripts",
        "apps/desktop/patches/cua-driver",
        "packages/shared/src/cuaDriverRelease.json",
        ".github/actions/provision-cua/action.yml",
        "scripts/lib/build-timing.ts",
      ]) {
        const destination = join(scratch, path);
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(new URL(path, root), destination, { recursive: true });
      }
      const hash = (platform) =>
        cuaCacheKey({ files: collectCuaFileFingerprints(scratch, platform) });
      const mac = hash("darwin");
      const linux = hash("linux");
      appendFileSync(
        join(scratch, "apps/desktop/scripts/strip-mac-cua-symbols.mjs"),
        "// new strip policy\n",
      );
      expect(hash("darwin")).not.toBe(mac);
      expect(hash("linux")).toBe(linux);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
  it("ignores staging paths and signing secrets", () => {
    expect(
      cuaBuildFlags({
        CARGO_TARGET_DIR: "/tmp/random",
        CSC_KEY_PASSWORD: "secret",
        APPLE_API_KEY: "secret",
        SYNARA_CUA_SIGN_IDENTITY: "secret",
      }),
    ).toEqual({});
  });
  it("rejects compiler wrappers whose bytes cannot be established by environment values", () => {
    expect(() => collectCuaCacheInputs(".", { RUSTC_WRAPPER: "/tmp/compiler" })).toThrow(
      "does not support",
    );
  });
  it.each(["files", "platform", "arch", "os", "rust", "cargo", "compiler", "sdk", "flags"])(
    "invalidates changed %s",
    (key) => {
      expect(cuaCacheKey({ [key]: "before" })).not.toBe(cuaCacheKey({ [key]: "after" }));
    },
  );
});

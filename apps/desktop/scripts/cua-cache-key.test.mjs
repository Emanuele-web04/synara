import { describe, expect, it } from "vitest";
import { cuaBuildFlags, cuaCacheKey, collectCuaCacheInputs } from "./cua-cache-key.mjs";

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

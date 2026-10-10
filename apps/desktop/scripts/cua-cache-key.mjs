// The Actions cache is only a transport. The key binds the build environment;
// provisioning still checks every executable and Linux sidecar on import.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function cuaCacheKey(inputs) {
  return `cua-v1-${createHash("sha256").update(JSON.stringify(inputs)).digest("hex")}`;
}

export function cuaBuildFlags(env) {
  return Object.fromEntries(
    Object.entries(env)
      .filter(
        ([key]) =>
          /^(CARGO_|RUST|CC($|_)|CXX($|_)|CFLAGS($|_)|CXXFLAGS($|_)|CPPFLAGS($|_)|LDFLAGS($|_)|AR($|_)|PKG_CONFIG|MACOSX_DEPLOYMENT_TARGET$|SDKROOT$)/.test(
            key,
          ) && !["CARGO_HOME", "CARGO_TARGET_DIR"].includes(key),
      )
      .toSorted(([a], [b]) => a.localeCompare(b)),
  );
}

export function collectCuaCacheInputs(root, env = process.env) {
  // Compiler paths/wrappers may change bytes at an unchanged path. The release
  // cache supports the selected runner toolchain, not arbitrary wrappers.
  for (const key of Object.keys(env)) {
    if (
      /^(RUSTC($|_)|RUSTDOC$|CC($|_)|CXX($|_)|AR($|_)|CARGO_BUILD_(RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER)$|CARGO_TARGET_.*_LINKER$)/.test(
        key,
      ) &&
      env[key]
    )
      throw new Error(`Release Cua cache does not support toolchain override ${key}.`);
  }
  const output = (command, args) => execFileSync(command, args, { encoding: "utf8" }).trim();
  const hashFile = (path) =>
    createHash("sha256")
      .update(readFileSync(resolve(root, path)))
      .digest("hex");
  const patchRoot = "apps/desktop/patches/cua-driver";
  const paths = [
    "packages/shared/src/cuaDriverRelease.json",
    "apps/desktop/scripts/provision-cua-driver.mjs",
    "apps/desktop/scripts/cua-artifact-provenance.mjs",
    "apps/desktop/scripts/cua-cache-key.mjs",
    "apps/desktop/scripts/find-cua-artifact.mjs",
    "scripts/lib/build-timing.ts",
    ".github/actions/provision-cua/action.yml",
    ...readdirSync(resolve(root, patchRoot))
      .toSorted()
      .map((name) => `${patchRoot}/${name}`),
  ];
  return {
    platform: process.platform,
    arch: process.arch,
    os:
      process.platform === "darwin"
        ? output("sw_vers", ["-productVersion"])
        : readFileSync("/etc/os-release", "utf8"),
    rust: output("rustc", ["-vV"]),
    cargo: output("cargo", ["--version"]),
    compiler: output("cc", ["--version"]),
    sdk:
      process.platform === "darwin"
        ? [
            output("xcodebuild", ["-version"]),
            output("xcrun", ["--show-sdk-version"]),
            output("xcrun", ["--show-sdk-build-version"]),
          ]
        : output("dpkg-query", [
            "-W",
            "-f=${Package}=${Version}\n",
            "libc6-dev",
            "libssl-dev",
            "libx11-dev",
            "libxtst-dev",
            "libxrandr-dev",
            "libxfixes-dev",
            "libxrender-dev",
            "libxcb-shape0-dev",
            "libxcb-xfixes0-dev",
            "libxkbcommon-dev",
            "libwayland-dev",
            "pkg-config",
          ]),
    flags: cuaBuildFlags(env),
    files: Object.fromEntries(paths.map((path) => [path, hashFile(path)])),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const key = cuaCacheKey(collectCuaCacheInputs(process.cwd()));
  console.log(key);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `key=${key}\n`);
}

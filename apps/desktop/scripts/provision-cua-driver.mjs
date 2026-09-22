// Build the exact upstream commit plus the native patch required by the host.
// The upstream binary archive is baseline provenance, never a patched artifact.
import { timeBuildStage, startBuildStage } from "../../../scripts/lib/build-timing.ts";
import { mkdir, readFile, writeFile, chmod, mkdtemp, rm, copyFile, cp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  assertCuaArtifactProvenance,
  assertLinuxCuaBinaryIdentity,
  assertLinuxCuaBuildHost,
  assertLinuxCuaSidecarChecksums,
  LINUX_CUA_INPUT_SCOPE,
  LINUX_CUA_SIDECAR_PATHS,
} from "./cua-artifact-provenance.mjs";
const release = JSON.parse(
  await readFile(
    new URL("../../../packages/shared/src/cuaDriverRelease.json", import.meta.url),
    "utf8",
  ),
);
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const destination = resolve(
  option("--destination") ?? fileURLToPath(new URL("../resources/cua-driver/", import.meta.url)),
);
const platform = option("--platform") ?? process.platform;
const arch = option("--arch") ?? process.arch;
const targets = {
  darwin: { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" },
  win32: { arm64: "windows-arm64", x64: "windows-x86_64" },
  linux: { arm64: "linux-arm64", x64: "linux-x86_64" },
};
const sourceTargets = {
  darwin: targets.darwin,
  linux: { arm64: "aarch64-unknown-linux-gnu", x64: "x86_64-unknown-linux-gnu" },
};
// Windows keeps the pinned upstream artifact. Linux builds the browser-only
// cancellation delta after the base patch; this does not enable native input.
const upstreamAsset = {
  win32: { binary: "cua-driver.exe", suffix: "zip" },
  linux: { binary: "cua-driver", suffix: "tar.gz" },
}[platform];
const architectures = arch === "universal" ? ["arm64", "x64"] : [arch];
const artifact = option("--artifact-dir") ?? process.env.SYNARA_CUA_ARTIFACT_DIR;
const signIdentity = option("--sign-identity") ?? process.env.SYNARA_CUA_SIGN_IDENTITY;
/** Stable signing identifier so macOS TCC remembers the driver across rebuilds. */
const CUA_DRIVER_SIGN_IDENTIFIER = "com.emanueledipietro.synara.cua.driver";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const patchPath = fileURLToPath(
  new URL("../patches/cua-driver/0001-synara-native.patch", import.meta.url),
);
const patch = await readFile(patchPath);
const linuxPatchPath = fileURLToPath(
  new URL("../patches/cua-driver/0002-synara-linux-browser.patch", import.meta.url),
);
if (
  !targets[platform] ||
  architectures.some((value) => !targets[platform][value]) ||
  (platform === "darwin" && process.platform !== "darwin") ||
  (platform !== "darwin" && arch === "universal")
)
  throw new Error(
    platform === "darwin"
      ? "Native Cua provisioning requires macOS and --arch arm64, x64 or universal."
      : `Cua provisioning for ${platform} requires --platform win32|linux and --arch arm64 or x64.`,
  );
if (option("--archive"))
  throw new Error(
    "The upstream binary lacks Synara's native patch. Use --source-checkout or --artifact-dir instead.",
  );
if (digest(patch) !== release.patchSha256) throw new Error("Cua native patch checksum mismatch.");
if (platform === "linux") {
  if (digest(await readFile(linuxPatchPath)) !== release.linuxBrowserPatchSha256)
    throw new Error("Cua Linux browser patch checksum mismatch.");
  assertLinuxCuaBuildHost({
    platform,
    hostPlatform: process.platform,
    arch,
    hostArch: process.arch,
    artifact,
  });
}
// Check the compiler before fetching ~190 MB of upstream source: a missing or
// mismatched toolchain is the common failure and needs no network to detect.
if (!(option("--artifact-dir") ?? process.env.SYNARA_CUA_ARTIFACT_DIR) && platform !== "win32") {
  let found;
  try {
    found = execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    found = "no rustc on PATH";
  }
  if (!found.startsWith(`rustc ${release.rustVersion} `)) {
    console.error(
      `Cua Driver needs the pinned Rust ${release.rustVersion} toolchain; found ${found}. Install it with: rustup toolchain install ${release.rustVersion} && rustup default ${release.rustVersion}`,
    );
    process.exit(1);
  }
}
const temporary = await mkdtemp(join(tmpdir(), "synara-cua-package-"));
const environment = {
  ...process.env,
  CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
  GIT_TERMINAL_PROMPT: "0",
  // The pinned Rust toolchain's debug stripping can misalign proc-macro
  // dylibs, which macOS 27 refuses to load (rust-lang/rust#157750). Preserve
  // symbols during this build; do not change the pinned compiler or source.
  ...(platform === "darwin"
    ? { CARGO_PROFILE_RELEASE_STRIP: process.env.CARGO_PROFILE_RELEASE_STRIP ?? "none" }
    : {}),
};
const run = (binary, args, cwd) =>
  timeBuildStage(
    `cua-${binary}-${args[0]}`,
    () => execFileSync(binary, args, { cwd, env: environment, stdio: "inherit" }),
    binary === "git" && args.includes("fetch") ? "download" : "local",
  );
const output = (binary, args, cwd) =>
  execFileSync(binary, args, {
    cwd,
    env: environment,
    encoding: "utf8",
  }).trim();
const finishProvision = startBuildStage(artifact ? "cua-artifact-import" : "cua-source-build");
let provisionSucceeded = false;
try {
  let binary;
  let provenance;
  let linuxSidecars;
  if (artifact) {
    binary = join(resolve(artifact), upstreamAsset?.binary ?? "cua-driver");
    provenance = JSON.parse(await readFile(join(resolve(artifact), "provenance.json"), "utf8"));
    assertCuaArtifactProvenance({
      provenance,
      release,
      platform,
      architectures,
      binarySha256: digest(await readFile(binary)),
    });
    if (platform === "linux" && provenance.patched === true) {
      linuxSidecars = Object.fromEntries(
        await Promise.all(
          LINUX_CUA_SIDECAR_PATHS.map(async (path) => [
            path,
            await readFile(join(resolve(artifact), path)),
          ]),
        ),
      );
      assertLinuxCuaSidecarChecksums(
        provenance,
        Object.fromEntries(
          Object.entries(linuxSidecars).map(([path, bytes]) => [path, digest(bytes)]),
        ),
      );
    }
  } else if (platform === "win32") {
    // Windows: stage the upstream release binary for the pinned
    // version. The authoritative checksum comes from the release's own
    // checksums.txt, verified before anything reaches the destination.
    const releaseBase = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${release.version}`;
    const checksums = await (await fetch(`${releaseBase}/checksums.txt`)).text();
    const expected = new Map(
      [...checksums.matchAll(/^([0-9a-f]{64})\s+(\S+)$/gm)].map((m) => [m[2], m[1]]),
    );
    const staged = join(temporary, "upstream");
    await mkdir(staged);
    const bundleArch = architectures[0];
    const assetName = `cua-driver-rs-${release.version}-${targets[platform][bundleArch]}-binary.${upstreamAsset.suffix}`;
    const wantSha = expected.get(assetName);
    if (!wantSha) throw new Error(`Upstream release has no checksum for ${assetName}.`);
    const archivePath = join(temporary, assetName);
    const downloaded = Buffer.from(
      await (await fetch(`${releaseBase}/${assetName}`)).arrayBuffer(),
    );
    if (digest(downloaded) !== wantSha) throw new Error(`Upstream ${assetName} checksum mismatch.`);
    await writeFile(archivePath, downloaded);
    // bsdtar (macOS, Windows) reads zip and tar.gz; GNU tar does not read
    // zip, so fall back to unzip for the Windows asset on Linux hosts.
    try {
      run("tar", ["-xf", archivePath, "-C", staged]);
    } catch {
      run("unzip", ["-o", archivePath, "-d", staged]);
    }
    binary = join(staged, upstreamAsset.binary);
    provenance = {
      version: release.version,
      source: release.source,
      nativeRevision: release.nativeRevision,
      patched: false,
      patchSha256: null,
      rustVersion: release.rustVersion,
      platform,
      architectures,
      binarySha256: digest(await readFile(binary)),
      upstreamArchiveSha256: wantSha,
    };
  } else {
    let source = option("--source-checkout");
    if (source) source = resolve(source);
    else {
      source = join(temporary, "upstream");
      run("git", ["init", "--bare", source]);
      run("git", [
        "-C",
        source,
        "fetch",
        "--depth=1",
        "https://github.com/trycua/cua.git",
        release.source,
      ]);
    }
    const commit = output("git", ["-C", source, "rev-parse", `${release.source}^{commit}`]);
    if (commit !== release.source) throw new Error("Cua source commit mismatch.");
    const archive = join(temporary, "source.tar");
    // Ignore local checkout edits; only the pinned commit enters the build.
    run("git", ["-C", source, "archive", `--output=${archive}`, release.source, "libs/cua-driver"]);
    const build = join(temporary, "build");
    await mkdir(build);
    run("tar", ["-xf", archive, "-C", build]);
    run("patch", ["--batch", "--forward", "-p1", "-i", patchPath], build);
    if (platform === "linux") {
      run("patch", ["--batch", "--forward", "-p1", "-i", linuxPatchPath], build);
    }
    const rust = join(build, "libs/cua-driver/rust");
    const rustcVersion = output("rustc", ["--version"], rust);
    if (!rustcVersion.startsWith(`rustc ${release.rustVersion} `))
      throw new Error(
        `Use the pinned Rust ${release.rustVersion} toolchain; found ${rustcVersion}.`,
      );
    const workspace = await readFile(join(rust, "Cargo.toml"), "utf8");
    if (!workspace.includes(`version = "${release.version}"`))
      throw new Error("Cua source package version mismatch.");
    const targetDir = resolve(process.env.CARGO_TARGET_DIR || join(temporary, "target"));
    const binaries = [];
    for (const architecture of architectures) {
      const target = sourceTargets[platform][architecture];
      run(
        "cargo",
        [
          "build",
          "--release",
          "--locked",
          "--target-dir",
          targetDir,
          "--target",
          target,
          "-p",
          "cua-driver",
          ...(platform === "linux" ? ["-p", "cursor-theme-cli"] : []),
          ...(process.argv.includes("--offline") ? ["--offline"] : []),
        ],
        rust,
      );
      binaries.push(join(targetDir, target, "release/cua-driver"));
    }
    binary = join(temporary, "cua-driver");
    if (binaries.length > 1) run("lipo", ["-create", ...binaries, "-output", binary]);
    else await copyFile(binaries[0], binary);
    if (platform === "linux") {
      const target = sourceTargets.linux[architectures[0]];
      linuxSidecars = Object.fromEntries(
        await Promise.all(
          LINUX_CUA_SIDECAR_PATHS.map(async (path) => [
            path,
            await readFile(
              path === "cua-cursor-theme"
                ? join(targetDir, target, "release/cua-cursor-theme")
                : join(build, "libs/cua-driver", path),
            ),
          ]),
        ),
      );
    }
    provenance = {
      version: release.version,
      source: release.source,
      nativeRevision: release.nativeRevision,
      platform,
      patched: true,
      patchSha256: release.patchSha256,
      ...(platform === "linux"
        ? {
            linuxBrowserPatchSha256: release.linuxBrowserPatchSha256,
            browserInputControl: release.linuxBrowserInputControl,
            inputScope: LINUX_CUA_INPUT_SCOPE,
            sidecarSha256: Object.fromEntries(
              Object.entries(linuxSidecars).map(([path, bytes]) => [path, digest(bytes)]),
            ),
          }
        : {}),
      rustVersion: release.rustVersion,
      rustcVersion,
      architectures,
      binarySha256: digest(await readFile(binary)),
      ...(platform === "linux"
        ? { sourceArchiveSha256: digest(await readFile(archive)) }
        : { upstreamArchiveSha256: release.sha256 }),
    };
  }
  if (platform === "darwin") {
    // Validate a foreign architecture without requiring Rosetta. The GUI also
    // verifies version, native revision, embedded mode and PID before dispatch.
    const present = output("lipo", ["-archs", binary]).split(/\s+/);
    if (architectures.some((value) => !present.includes(value === "x64" ? "x86_64" : "arm64")))
      throw new Error("Cua Mach-O is missing a requested architecture.");
  } else if (platform === "linux") {
    assertLinuxCuaBinaryIdentity(await readFile(binary), architectures);
    if (linuxSidecars) {
      assertLinuxCuaBinaryIdentity(linuxSidecars["cua-cursor-theme"], architectures);
    }
  }
  await mkdir(destination, { recursive: true });
  if (platform === "win32" || (platform === "linux" && provenance.patched === false)) {
    // The upstream archive is a bundle — driver plus its sidecars (cursor
    // theme, SDK, node runtime, UIA/Wayland helpers). Stage them all — from
    // the verified artifact dir when one was supplied, else the download.
    await cp(artifact ? resolve(artifact) : join(temporary, "upstream"), destination, {
      recursive: true,
    });
    if (platform !== "win32") await chmod(join(destination, upstreamAsset.binary), 0o755);
  } else if (platform === "linux") {
    // A previous upstream install may have left separately loadable SDK
    // binaries here. They are not used by Synara's direct daemon transport
    // and must not masquerade as this newly patched runtime.
    for (const obsolete of [
      "libcua_driver_sdk.so",
      "cua_driver_node_runtime.node",
      "cua_driver_abi.h",
    ]) {
      await rm(join(destination, obsolete), { force: true });
    }
    await writeFile(join(destination, "cua-driver"), await readFile(binary));
    await chmod(join(destination, "cua-driver"), 0o755);
    for (const [path, bytes] of Object.entries(linuxSidecars)) {
      const stagedPath = join(destination, path);
      await mkdir(dirname(stagedPath), { recursive: true });
      await writeFile(stagedPath, bytes);
      if (path === "cua-cursor-theme" || path.endsWith(".sh")) await chmod(stagedPath, 0o755);
    }
  } else {
    // Stage via a content write, not copyFile: macOS clonefile carries the
    // protected com.apple.provenance xattr, and Gatekeeper kills the staged
    // binary (SIGKILL at exec) when that marker survives onto a new path.
    await writeFile(join(destination, "cua-driver"), await readFile(binary));
    await chmod(join(destination, "cua-driver"), 0o755);
    // Re-stamp the signature. Default is a plain adhoc signature (the linker's
    // embedded `linker-signed` flag signature is killed at exec on recent
    // macOS). When a signing identity is supplied, use it with a stable
    // identifier so macOS TCC remembers this driver across rebuilds instead of
    // prompting as a brand-new unknown app every time.
    const signArgs = ["--force"];
    if (signIdentity) {
      signArgs.push("--identifier", CUA_DRIVER_SIGN_IDENTIFIER, "--sign", signIdentity);
    } else {
      signArgs.push("--sign", "-");
    }
    run("codesign", [...signArgs, join(destination, "cua-driver")]);
    // Signing rewrites the executable bytes, so record the digest of the
    // final staged file. The reuse path verifies binarySha256 against exactly
    // these bytes; recording the pre-sign digest forced every consumer to
    // patch provenance.json and re-sign by hand.
    if (signIdentity) provenance.signedIdentity = signIdentity;
    provenance.binarySha256 = digest(await readFile(join(destination, "cua-driver")));
  }
  // Legacy Mac artifacts predate the platform field; Mach-O/lipo verification
  // above establishes it without invalidating or recompiling their signed bytes.
  provenance.platform = platform;
  await writeFile(join(destination, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
  await copyFile(
    fileURLToPath(new URL("../../../docs/computer-use-cua/CUA-LICENSE.txt", import.meta.url)),
    join(destination, "LICENSE.txt"),
  );
  provisionSucceeded = true;
  console.log(
    `Cua ${release.version} ${provenance.patched === false ? "upstream (unpatched, no browser input control)" : platform === "linux" ? `browser input control ${provenance.browserInputControl}, native desktop input unavailable` : `native revision ${release.nativeRevision}`} (${architectures.join("+")}) staged at ${destination}`,
  );
} finally {
  finishProvision(provisionSucceeded);
  await rm(temporary, { recursive: true, force: true });
}

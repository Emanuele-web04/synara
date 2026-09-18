// Build the exact upstream commit plus the native patch required by the host.
// The upstream binary archive is baseline provenance, never a patched artifact.
import { mkdir, readFile, writeFile, chmod, mkdtemp, rm, copyFile, cp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
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
// Only macOS builds the Synara-patched binary today; Windows and Linux stage
// the upstream release artifact for the same pinned version instead — the
// unpatched driver carries none of the native safety layers the patch adds.
const upstreamAsset = {
  win32: { binary: "cua-driver.exe", suffix: "zip" },
  linux: { binary: "cua-driver", suffix: "tar.gz" },
}[platform];
const architectures = arch === "universal" ? ["arm64", "x64"] : [arch];
const artifact = option("--artifact-dir") ?? process.env.SYNARA_CUA_ARTIFACT_DIR;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const patchPath = fileURLToPath(
  new URL("../patches/cua-driver/0001-synara-native.patch", import.meta.url),
);
const patch = await readFile(patchPath);
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
const temporary = await mkdtemp(join(tmpdir(), "synara-cua-package-"));
const environment = {
  ...process.env,
  CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
  GIT_TERMINAL_PROMPT: "0",
};
const run = (binary, args, cwd) =>
  execFileSync(binary, args, { cwd, env: environment, stdio: "inherit" });
const output = (binary, args, cwd) =>
  execFileSync(binary, args, {
    cwd,
    env: environment,
    encoding: "utf8",
  }).trim();
try {
  let binary;
  let provenance;
  if (artifact) {
    binary = join(resolve(artifact), upstreamAsset?.binary ?? "cua-driver");
    provenance = JSON.parse(await readFile(join(resolve(artifact), "provenance.json"), "utf8"));
    if (
      provenance.version !== release.version ||
      provenance.source !== release.source ||
      provenance.nativeRevision !== release.nativeRevision ||
      // The native patch exists only for macOS; an unpatched platform
      // artifact declares `patched:false` and carries no patch checksum.
      (provenance.patched === false
        ? platform === "darwin"
        : provenance.patchSha256 !== release.patchSha256) ||
      provenance.rustVersion !== release.rustVersion ||
      architectures.some((value) => !provenance.architectures?.includes(value)) ||
      digest(await readFile(binary)) !== provenance.binarySha256
    ) {
      throw new Error("Cua artifact identity, architecture or binary checksum mismatch.");
    }
  } else if (upstreamAsset) {
    // Windows/Linux: stage the upstream release binary for the pinned
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
      const target = targets[platform][architecture];
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
          ...(process.argv.includes("--offline") ? ["--offline"] : []),
        ],
        rust,
      );
      binaries.push(join(targetDir, target, "release/cua-driver"));
    }
    binary = join(temporary, "cua-driver");
    if (binaries.length > 1) run("lipo", ["-create", ...binaries, "-output", binary]);
    else await copyFile(binaries[0], binary);
    provenance = {
      version: release.version,
      source: release.source,
      nativeRevision: release.nativeRevision,
      patchSha256: release.patchSha256,
      rustVersion: release.rustVersion,
      rustcVersion,
      architectures,
      binarySha256: digest(await readFile(binary)),
      upstreamArchiveSha256: release.sha256,
    };
  }
  if (platform === "darwin") {
    // Validate a foreign architecture without requiring Rosetta. The GUI also
    // verifies version, native revision, embedded mode and PID before dispatch.
    const present = output("lipo", ["-archs", binary]).split(/\s+/);
    if (architectures.some((value) => !present.includes(value === "x64" ? "x86_64" : "arm64")))
      throw new Error("Cua Mach-O is missing a requested architecture.");
  }
  await mkdir(destination, { recursive: true });
  if (upstreamAsset) {
    // The upstream archive is a bundle — driver plus its sidecars (cursor
    // theme, SDK, node runtime, UIA/Wayland helpers). Stage them all — from
    // the verified artifact dir when one was supplied, else the download.
    await cp(artifact ? resolve(artifact) : join(temporary, "upstream"), destination, {
      recursive: true,
    });
    if (platform !== "win32") await chmod(join(destination, upstreamAsset.binary), 0o755);
  } else {
    // Stage via a content write, not copyFile: macOS clonefile carries the
    // protected com.apple.provenance xattr, and Gatekeeper kills the staged
    // binary (SIGKILL at exec) when that marker survives onto a new path.
    await writeFile(join(destination, "cua-driver"), await readFile(binary));
    await chmod(join(destination, "cua-driver"), 0o755);
    // Re-stamp the adhoc signature: the linker's embedded `linker-signed`
    // flag signature is also killed at exec on recent macOS (the staged
    // binary must present a plain adhoc signature).
    run("codesign", ["--force", "--sign", "-", join(destination, "cua-driver")]);
  }
  await writeFile(join(destination, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
  await copyFile(
    fileURLToPath(new URL("../../../docs/computer-use-cua/CUA-LICENSE.txt", import.meta.url)),
    join(destination, "LICENSE.txt"),
  );
  console.log(
    `Cua ${release.version} ${platform === "darwin" ? `native revision ${release.nativeRevision}` : "upstream (unpatched)"} (${architectures.join("+")}) staged at ${destination}`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}

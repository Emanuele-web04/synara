import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { hashFile } from "./lib/file-digest.ts";
import {
  hybridArchiveMetadata,
  hybridLicense,
  hybridPatch,
  hybridSourceReference,
  verifyMacHybridElectron,
} from "./lib/mac-hybrid-electron.ts";

const usage = `node scripts/build-mac-hybrid-electron.ts --source CHROMIUM_SRC --arch arm64|x64 --output DIRECTORY
node scripts/build-mac-hybrid-electron.ts --verify DIRECTORY --arch arm64|x64
node scripts/build-mac-hybrid-electron.ts --source-reference`;
const { values } = parseArgs({
  options: {
    source: { type: "string" },
    arch: { type: "string" },
    output: { type: "string" },
    verify: { type: "string" },
    "source-reference": { type: "boolean" },
    help: { type: "boolean" },
  },
});

async function build(source: string, arch: string, output: string) {
  if (process.platform !== "darwin")
    throw new Error("The native macOS Electron build requires macOS.");
  const manifest = hybridArchiveMetadata(arch);
  if (existsSync(output) && (await readdir(output)).length) {
    throw new Error("Choose an empty or new runtime output directory.");
  }
  const electron = join(source, "electron");
  if (
    basename(source) !== "src" ||
    !existsSync(join(dirname(source), ".gclient")) ||
    !existsSync(join(source, "chrome", "VERSION")) ||
    !existsSync(join(electron, "BUILD.gn"))
  ) {
    throw new Error(
      "Provide a complete gclient-synced src directory for the pinned Electron release.",
    );
  }
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  if (
    git(electron, "rev-parse", "HEAD") !== manifest.electronCommit ||
    git(electron, "rev-parse", `v${manifest.electronVersion}^{commit}`) !== manifest.electronCommit
  ) {
    throw new Error("Electron source and release tag must match the pinned commit.");
  }
  const chromiumPatches = readFileSync(join(electron, "patches/chromium/.patches"), "utf8")
    .trim()
    .split(/\r?\n/);
  if (git(source, "rev-parse", `HEAD~${chromiumPatches.length}`) !== manifest.chromiumCommit) {
    throw new Error(
      "Chromium does not have Electron's patch stack on the pinned Chromium revision. Run gclient sync.",
    );
  }
  if (
    git(electron, "status", "--porcelain") ||
    git(source, "status", "--porcelain", "--ignore-submodules=all", "--", ".", ":(exclude)electron")
  ) {
    throw new Error("Use a clean Electron and Chromium checkout.");
  }
  // gclient applies a series of commits on top of the Chrome tag. Compare them with
  // the release's own patches instead of insisting that Chromium HEAD equals the bare tag.
  execFileSync(
    "python3",
    [
      join(electron, "script/export_all_patches.py"),
      "--dry-run",
      join(electron, "patches/config.json"),
    ],
    { cwd: dirname(source), stdio: "inherit" },
  );
  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(join(dirname(output), ".synara-hybrid-"));
  const buildDir = `out/SynaraHybrid-${arch}`;
  const env = { ...process.env, CHROMIUM_BUILDTOOLS_PATH: join(source, "buildtools") };
  try {
    git(electron, "apply", "--index", hybridPatch);
    try {
      execFileSync(
        "gn",
        [
          "gen",
          buildDir,
          `--args=import("//electron/build/args/release.gn")\ntarget_cpu="${arch}"`,
        ],
        { cwd: source, env, stdio: "inherit" },
      );
      execFileSync("autoninja", ["-C", buildDir, manifest.target], {
        cwd: source,
        env,
        stdio: "inherit",
      });
      const zip = join(staging, manifest.archive);
      await copyFile(join(source, buildDir, "dist.zip"), zip);
      await copyFile(hybridLicense, join(staging, "LICENSE-Nightly-Labs"));
      // Keep the third-party notice with the compiled distribution even if the zip is copied separately.
      execFileSync("/usr/bin/zip", ["-q", zip, "LICENSE-Nightly-Labs"], { cwd: staging });
      await writeFile(
        join(staging, "manifest.json"),
        JSON.stringify(
          {
            ...manifest,
            archiveSha256: await hashFile(zip),
          },
          null,
          2,
        ) + "\n",
      );
      await verifyMacHybridElectron(staging, arch, manifest.electronVersion);
    } finally {
      git(electron, "apply", "--reverse", "--index", hybridPatch);
    }
    await rename(staging, output);
    console.log(`Verified source-built Electron archive at ${join(output, manifest.archive)}`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (values.help) {
  console.log(usage);
} else if (values["source-reference"]) {
  console.log(
    JSON.stringify(
      {
        electronRepository: "https://github.com/electron/electron",
        chromiumRepository: "https://chromium.googlesource.com/chromium/src.git",
        target: "electron:electron_dist_zip",
        ...hybridSourceReference(),
      },
      null,
      2,
    ),
  );
} else if (values.verify && values.arch) {
  console.log(
    await verifyMacHybridElectron(
      values.verify,
      values.arch,
      hybridSourceReference().electronVersion,
    ),
  );
} else if (values.source && values.arch && values.output) {
  await build(realpathSync(values.source), values.arch, resolve(values.output));
} else {
  throw new Error(usage);
}

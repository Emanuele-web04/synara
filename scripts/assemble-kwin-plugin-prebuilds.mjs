import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

export const EXPECTED_KWIN_PREBUILDS = [
  ["fedora-43", "x64"],
  ["fedora-43", "arm64"],
  ["fedora-44", "x64"],
  ["fedora-44", "arm64"],
  ["debian-trixie", "x64"],
  ["debian-trixie", "arm64"],
  ["ubuntu-2604", "x64"],
  ["ubuntu-2604", "arm64"],
  ["opensuse-tumbleweed", "x64"],
  ["opensuse-tumbleweed", "arm64"],
  ["arch", "x64"],
];

function text(value) {
  return typeof value === "string" && value.trim() !== "";
}

function readMetadata(path) {
  const metadata = JSON.parse(readFileSync(path, "utf8"));
  if (
    !metadata ||
    typeof metadata !== "object" ||
    !text(metadata.kwinVersion) ||
    !text(metadata.arch) ||
    !text(metadata.builtOn) ||
    !text(metadata.file) ||
    basename(metadata.file) !== metadata.file ||
    metadata.file.includes("\\") ||
    metadata.file === "." ||
    metadata.file === ".." ||
    !EXPECTED_KWIN_PREBUILDS.some(
      ([builtOn, arch]) => builtOn === metadata.builtOn && arch === metadata.arch,
    )
  ) {
    throw new Error(`Invalid KWin prebuild metadata: ${path}`);
  }
  return metadata;
}

/** Assemble every distro-specific artifact and check coverage after retention. */
export function assembleKWinPluginPrebuilds({
  sourceDirectory,
  outputDirectory,
  strict = false,
  expected = EXPECTED_KWIN_PREBUILDS,
  log = console.log,
}) {
  mkdirSync(outputDirectory, { recursive: true });
  const metadataFiles = readdirSync(sourceDirectory)
    .filter((name) => name.endsWith(".so.json"))
    .toSorted();
  const builds = [];
  const selectors = new Set();
  const outputFiles = new Set();

  for (const metadataName of metadataFiles) {
    const metadata = readMetadata(join(sourceDirectory, metadataName));
    const binary = join(sourceDirectory, metadata.file);
    let bytes;
    try {
      bytes = readFileSync(binary);
    } catch {
      log(`skipping ${metadata.file}: binary is missing`);
      continue;
    }

    const selector = `${metadata.builtOn}\0${metadata.kwinVersion}\0${metadata.arch}`;
    if (selectors.has(selector)) {
      throw new Error(
        `Duplicate KWin prebuild selector: ${metadata.builtOn}, KWin ${metadata.kwinVersion}, ${metadata.arch}`,
      );
    }
    if (outputFiles.has(metadata.file)) {
      throw new Error(`Duplicate KWin prebuild output file: ${metadata.file}`);
    }
    selectors.add(selector);
    outputFiles.add(metadata.file);

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    copyFileSync(binary, join(outputDirectory, metadata.file));
    builds.push({ ...metadata, sha256 });
  }

  writeFileSync(
    join(outputDirectory, "manifest.json"),
    `${JSON.stringify({ builds }, undefined, 2)}\n`,
  );
  log(`${builds.length} build(s) in the manifest`);
  if (builds.length === 0) {
    throw new Error("No KWin plugin builds arrived; the release would ship an empty prebuilt/");
  }

  const retained = new Set(builds.map((build) => `${build.builtOn}\0${build.arch}`));
  const missing = expected.filter(([builtOn, arch]) => !retained.has(`${builtOn}\0${arch}`));
  for (const [builtOn, arch] of missing) {
    const kind = strict ? "error" : "warning";
    log(`::${kind}::No retained KWin plugin build from ${builtOn} (${arch})`);
  }
  if (strict && missing.length > 0) {
    throw new Error(`Strict KWin prebuild coverage failed with ${missing.length} missing build(s)`);
  }
  return { builds, missing };
}

function main() {
  const sourceDirectory = process.argv[2] ?? "downloaded";
  const outputDirectory = process.argv[3] ?? "prebuilt";
  assembleKWinPluginPrebuilds({
    sourceDirectory,
    outputDirectory,
    strict: process.env.STRICT === "true",
  });
  process.stdout.write(readFileSync(join(outputDirectory, "manifest.json"), "utf8"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

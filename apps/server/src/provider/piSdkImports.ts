// FILE: piSdkImports.ts
// Purpose: Loads the SDK from the Pi CLI selected for a provider instance.
// Layer: Provider runtime support

import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { resolve as resolveImport } from "import-meta-resolve";

import { resolveExecutable } from "@synara/shared/executable";

const PI_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";

export type PiPackageImporter = <M>(specifier: string) => Promise<M>;

export interface PiInstallation {
  readonly binaryPath: string;
  readonly importPackage: PiPackageImporter;
}

export function makePiPackageImporter(agentEntry: string): PiPackageImporter {
  return async <M>(specifier: string): Promise<M> =>
    (await import(
      specifier === PI_AGENT_PACKAGE ? agentEntry : resolveImport(specifier, agentEntry)
    )) as M;
}

async function readPiManifest(packageDir: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as {
      name?: unknown;
      bin?: { pi?: unknown };
    };
    if (manifest.name === PI_AGENT_PACKAGE && typeof manifest.bin?.pi === "string") {
      return resolve(packageDir, manifest.bin.pi);
    }
  } catch {
    // This candidate directory is not the selected Pi package.
  }
  return undefined;
}

async function findDeclaredPiPackage(realBinaryPath: string): Promise<string | undefined> {
  for (let directory = dirname(realBinaryPath); ; directory = dirname(directory)) {
    const declaredBin = await readPiManifest(directory);
    if (declaredBin && (await realpath(declaredBin).catch(() => undefined)) === realBinaryPath) {
      return directory;
    }
    if (dirname(directory) === directory) return undefined;
  }
}

async function readBunShimTarget(binaryPath: string): Promise<string | undefined> {
  const sidecar = binaryPath.replace(/\.exe$/iu, ".bunx");
  const info = await stat(sidecar).catch(() => undefined);
  if (!info?.isFile() || info.size < 8 || info.size > 65_536 || info.size % 2 !== 0) return;
  const data = await readFile(sidecar);
  if (data.length !== info.size) return;
  const flags = data.readUInt16LE(data.length - 2);
  // Bun's v5 .bunx format stores a UTF-16LE path followed by a quoted terminator.
  if (flags >>> 4 !== 2739) return;
  const hasShebang = (flags & 4) !== 0;
  if (hasShebang && data.length < 16) return;
  const pathLength = hasShebang ? data.readUInt32LE(data.length - 10) : data.length - 6;
  const argumentLength = hasShebang ? data.readUInt32LE(data.length - 6) : 0;
  if (
    pathLength === 0 ||
    pathLength % 2 !== 0 ||
    pathLength + argumentLength + (hasShebang ? 14 : 6) !== data.length ||
    data.readUInt16LE(pathLength) !== 34 ||
    data.readUInt16LE(pathLength + 2) !== 0
  )
    return;
  const target = data.toString("utf16le", 0, pathLength).replaceAll("\\", sep);
  if (target.includes("\0") || isAbsolute(target) !== ((flags & 8) !== 0)) return;
  return resolve(dirname(binaryPath), "..", target);
}

// The official POSIX launcher selects a release through current-version.
// Read that same metadata without running a wrapper or guessing an SDK root.
async function findManagedPiPackageDir(launcher: string): Promise<string | undefined> {
  const installDir = join(dirname(dirname(launcher)), "install");
  const marker = JSON.parse(await readFile(join(installDir, "managed-install.json"), "utf8")) as {
    kind?: unknown;
    schemaVersion?: unknown;
    layout?: unknown;
    entrypoint?: { type?: unknown; path?: unknown };
  } | null;
  if (
    marker?.kind !== "pi-managed-install" ||
    marker.schemaVersion !== 1 ||
    marker.layout !== "releases-v1" ||
    (marker.entrypoint?.type !== "script" && marker.entrypoint?.type !== "symlink") ||
    typeof marker.entrypoint.path !== "string" ||
    !isAbsolute(marker.entrypoint.path) ||
    (await realpath(marker.entrypoint.path)) !== launcher
  ) {
    return undefined;
  }

  const current = await readFile(join(installDir, "current-version"), "utf8");
  // The installer's release metadata requires a version, not an arbitrary path.
  const version = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\n/u.exec(current)?.[1];
  if (!version) return undefined;
  const modules = join(installDir, "releases", version, "node_modules");
  const releaseBin = resolveExecutable(join(modules, ".bin", "pi"));
  if (!releaseBin) return undefined;

  const packageDir = await findDeclaredPiPackage(await realpath(releaseBin));
  return packageDir === join(modules, PI_AGENT_PACKAGE) ? packageDir : undefined;
}

async function findPiPackageDir(binaryPath: string): Promise<string | undefined> {
  const realBinaryPath = await realpath(binaryPath);
  // npm and Bun on Unix normally link directly to the package's declared bin.
  if (/\.exe$/iu.test(realBinaryPath)) {
    const target = await readBunShimTarget(realBinaryPath);
    const resolvedTarget = target && (await realpath(target).catch(() => undefined));
    return resolvedTarget ? findDeclaredPiPackage(resolvedTarget) : undefined;
  }
  const packageDir = await findDeclaredPiPackage(realBinaryPath);
  if (packageDir) return packageDir;

  if ((await stat(realBinaryPath)).size > 16 * 1024) return undefined;
  const script = await readFile(realBinaryPath, "utf8");
  if (
    realBinaryPath.endsWith("/bin/pi") &&
    script.startsWith("#!/bin/sh\n") &&
    script.includes("\npi_current_file=$pi_agent_dir/install/current-version\n") &&
    script.includes("\npi_release_dir=$pi_agent_dir/install/releases/$pi_current_version\n") &&
    script.includes("\npi_release_bin=$pi_release_dir/node_modules/.bin/pi\n") &&
    script.endsWith('exec "$pi_release_bin" "$@"\n')
  ) {
    return findManagedPiPackageDir(realBinaryPath);
  }

  // npm's Windows .cmd and text shims refer to their target relative to the bin directory.
  const shim = script.replaceAll("\\", "/");
  const binaryDir = dirname(realBinaryPath);
  for (const root of [
    join(binaryDir, "node_modules"),
    join(binaryDir, ".."),
    join(binaryDir, "..", "lib", "node_modules"),
    join(binaryDir, "..", "install", "global", "node_modules"),
  ]) {
    const packageDir = join(root, PI_AGENT_PACKAGE);
    const target = await readPiManifest(packageDir);
    if (!target || !(await realpath(target).catch(() => false))) continue;
    const relativeTarget = relative(binaryDir, target).replaceAll("\\", "/");
    if (
      shim.includes(`"${target.replaceAll("\\", "/")}"`) ||
      shim.includes(`%dp0%/${relativeTarget}"`) ||
      shim.includes(`$basedir/${relativeTarget}"`)
    ) {
      return packageDir;
    }
  }
  return undefined;
}

/** No Pi executable was found, as opposed to one that is present but unusable. */
export class PiNotInstalledError extends Error {
  override readonly name = "PiNotInstalledError";
}

export async function resolvePiInstallation(
  options: { binaryPath?: string | undefined; env?: NodeJS.ProcessEnv | undefined } = {},
): Promise<PiInstallation> {
  const executable = options.binaryPath?.trim() || "pi";
  const binaryPath = resolveExecutable(executable, { env: options.env });
  if (!binaryPath) {
    throw new PiNotInstalledError(
      options.binaryPath?.trim()
        ? `The configured Pi CLI (${executable}) is unavailable.`
        : "Pi is not installed. Install the Pi CLI with `npm install -g @earendil-works/pi-coding-agent` or `bun install -g @earendil-works/pi-coding-agent`.",
    );
  }

  try {
    const packageDir = await findPiPackageDir(binaryPath);
    if (!packageDir) throw new Error("The executable does not identify a Pi SDK package.");
    const agentEntry = resolveImport(
      PI_AGENT_PACKAGE,
      pathToFileURL(join(packageDir, "package.json")).href,
    );
    // Resolve Pi AI from the coding agent, so it can have a private dependency.
    // Health checks use the same graph without evaluating any SDK modules.
    await Promise.all(
      [
        agentEntry,
        ...[
          "@earendil-works/pi-ai/compat",
          "@earendil-works/pi-ai/providers/azure",
          "@earendil-works/pi-ai/providers/opencode",
          "@earendil-works/pi-ai/providers/openrouter",
          "@earendil-works/pi-ai/utils/model-operations",
        ].map((specifier) => resolveImport(specifier, agentEntry)),
      ].map(async (entry) => {
        if (!(await stat(new URL(entry))).isFile()) throw new Error("Missing Pi SDK entry.");
      }),
    );
    return { binaryPath, importPackage: makePiPackageImporter(agentEntry) };
  } catch (cause) {
    throw new Error(`Could not locate a compatible Pi SDK for the CLI at ${binaryPath}.`, {
      cause,
    });
  }
}

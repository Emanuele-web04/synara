#!/usr/bin/env node
// FILE: smoke-mac-update-artifact.ts
// Purpose: HEAD-only smoke test for macOS update artifacts without downloading the zip.
// Layer: Release/build script
// Depends on: build-desktop-artifact.ts and mac-update-zip helpers.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };
import {
  assertMacUpdateManifestZipMetadata,
  resolveSingleMacUpdateZipFileName,
} from "./lib/mac-update-zip.ts";

interface SmokeResult {
  readonly artifactDir: string;
  readonly manifestName: string;
  readonly zipFileName: string;
  readonly zipSize: number;
  readonly manifestHeadContentLength: number;
  readonly zipHeadContentLength: number;
  readonly zipBlockmapRemoved: boolean;
  readonly cleanedUp: boolean;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

function printHelp(): void {
  console.log(`Usage: node scripts/smoke-mac-update-artifact.ts [options]

Builds or validates a macOS mock update artifact, then performs HEAD-only
checks against latest-mac.yml and the update zip without downloading the zip.

Options:
  --artifact-dir <dir>      Validate an existing artifact directory instead of building.
  --arch <arm64|x64>        Build architecture. Defaults to the current host arch.
  --build                   Rebuild desktop/server/web dist before packaging.
  --build-version <version> Version for the mock update build.
  --keep-output             Keep the generated temporary output directory.
  --port <port>             Local HEAD-only smoke server port. Defaults to 58147.
  --skip-build              Use existing dist files while packaging. Default.
  --target <target>         electron-builder target. Defaults to dmg.
  --verbose                 Stream build command output.
  --help                    Show this help.
`);
}

function parsePort(rawValue: string | boolean | undefined): number {
  const port = Number(rawValue ?? "58147");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid smoke server port '${String(rawValue)}'.`);
  }
  return port;
}

function resolveDefaultArch(): "arm64" | "x64" {
  return process.arch === "arm64" ? "arm64" : "x64";
}

function resolveSmokeArch(rawValue: string | boolean | undefined): "arm64" | "x64" {
  if (rawValue === undefined) {
    return resolveDefaultArch();
  }
  if (rawValue === "arm64" || rawValue === "x64") {
    return rawValue;
  }
  throw new Error(`Invalid smoke arch '${String(rawValue)}'. Expected arm64 or x64.`);
}

function resolveSingleMacUpdateManifestName(entries: ReadonlyArray<string>): string {
  const manifestNames = entries.filter((entry) => entry.endsWith("-mac.yml"));
  if (manifestNames.length !== 1 || !manifestNames[0]) {
    throw new Error(`Expected one macOS update manifest, found ${manifestNames.length}.`);
  }
  return manifestNames[0];
}

function computeSha512Base64(filePath: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha512");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("base64")));
  });
}

function runBuildArtifactCommand(options: {
  readonly outputDir: string;
  readonly version: string;
  readonly port: number;
  readonly arch: "arm64" | "x64";
  readonly target: string;
  readonly skipBuild: boolean;
  readonly verbose: boolean;
}): void {
  const args = [
    "scripts/build-desktop-artifact.ts",
    "--platform",
    "mac",
    "--arch",
    options.arch,
    "--target",
    options.target,
    "--mock-updates",
    "--mock-update-server-port",
    String(options.port),
    "--build-version",
    options.version,
    "--output-dir",
    options.outputDir,
  ];
  if (options.skipBuild) {
    args.push("--skip-build");
  }
  if (options.verbose) {
    args.push("--verbose");
  }

  const result = spawnSync("node", args, {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`build-desktop-artifact smoke build failed with exit code ${result.status}.`);
  }
}

function contentTypeForFile(fileName: string): string {
  if (fileName.endsWith(".zip")) return "application/zip";
  if (fileName.endsWith(".yml")) return "application/octet-stream";
  return "application/octet-stream";
}

function listenHeadOnlyServer(
  artifactDir: string,
  allowedFiles: ReadonlySet<string>,
  port: number,
): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== "HEAD") {
      response.writeHead(405);
      response.end();
      return;
    }

    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const fileName = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "");
    if (!allowedFiles.has(fileName)) {
      response.writeHead(404);
      response.end();
      return;
    }

    const filePath = join(artifactDir, fileName);
    const stat = statSync(filePath);
    response.writeHead(200, {
      "Content-Length": String(stat.size),
      "Content-Type": contentTypeForFile(fileName),
    });
    response.end();
  });

  return new Promise((resolveServer, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolveServer(server));
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolveClose();
    });
  });
}

async function fetchHeadContentLength(url: string): Promise<number> {
  const response = await fetch(url, { method: "HEAD" });
  if (!response.ok) {
    throw new Error(`HEAD ${url} failed with ${response.status} ${response.statusText}.`);
  }
  const rawLength = response.headers.get("content-length");
  const length = Number(rawLength);
  if (!Number.isFinite(length)) {
    throw new Error(`HEAD ${url} did not return a valid content-length.`);
  }
  return length;
}

async function smokeMacUpdateArtifact(): Promise<SmokeResult> {
  if (process.platform !== "darwin") {
    throw new Error("macOS update artifact smoke test must run on macOS.");
  }

  const { values } = parseArgs({
    options: {
      "artifact-dir": { type: "string" },
      arch: { type: "string" },
      build: { type: "boolean", default: false },
      "build-version": { type: "string" },
      "keep-output": { type: "boolean", default: false },
      port: { type: "string", default: "58147" },
      "skip-build": { type: "boolean", default: true },
      target: { type: "string", default: "dmg" },
      verbose: { type: "boolean", default: false },
    },
  });

  const port = parsePort(values.port);
  const arch = resolveSmokeArch(values.arch);
  const version =
    typeof values["build-version"] === "string"
      ? values["build-version"]
      : desktopPackageJson.version;
  const target = typeof values.target === "string" ? values.target : "dmg";
  const skipBuild = values.build === true ? false : values["skip-build"] !== false;
  const verbose = values.verbose === true;
  const keepOutput = values["keep-output"] === true;
  const artifactDirWasProvided = typeof values["artifact-dir"] === "string";
  const artifactDir = artifactDirWasProvided
    ? resolve(repoRoot, values["artifact-dir"] as string)
    : mkdtempSync(join(tmpdir(), "synara-mac-update-smoke-"));
  const cleanedUp = !artifactDirWasProvided && !keepOutput;
  let server: Server | null = null;

  try {
    if (!artifactDirWasProvided) {
      runBuildArtifactCommand({
        outputDir: artifactDir,
        version,
        port,
        arch,
        target,
        skipBuild,
        verbose,
      });
    }

    const entries = readdirSync(artifactDir);
    const zipFileName = resolveSingleMacUpdateZipFileName(entries);
    const manifestName = resolveSingleMacUpdateManifestName(entries);
    const zipPath = join(artifactDir, zipFileName);
    const manifestPath = join(artifactDir, manifestName);
    const zipSize = statSync(zipPath).size;
    const zipSha512 = await computeSha512Base64(zipPath);
    const manifest = readFileSync(manifestPath, "utf8");
    assertMacUpdateManifestZipMetadata(manifest, zipFileName, {
      sha512: zipSha512,
      size: zipSize,
    });

    const zipBlockmapPath = `${zipPath}.blockmap`;
    if (existsSync(zipBlockmapPath)) {
      throw new Error(
        `macOS update zip blockmap should have been removed: ${basename(zipBlockmapPath)}`,
      );
    }

    server = await listenHeadOnlyServer(artifactDir, new Set([manifestName, zipFileName]), port);
    const manifestHeadContentLength = await fetchHeadContentLength(
      `http://127.0.0.1:${port}/${encodeURIComponent(manifestName)}`,
    );
    const zipHeadContentLength = await fetchHeadContentLength(
      `http://127.0.0.1:${port}/${encodeURIComponent(zipFileName)}`,
    );
    if (manifestHeadContentLength !== statSync(manifestPath).size) {
      throw new Error("Manifest HEAD content-length does not match local file size.");
    }
    if (zipHeadContentLength !== zipSize) {
      throw new Error("Zip HEAD content-length does not match local file size.");
    }

    return {
      artifactDir,
      manifestName,
      zipFileName,
      zipSize,
      manifestHeadContentLength,
      zipHeadContentLength,
      zipBlockmapRemoved: true,
      cleanedUp,
    };
  } finally {
    if (server) {
      await closeServer(server);
    }
    if (cleanedUp) {
      rmSync(artifactDir, { force: true, recursive: true });
    }
  }
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printHelp();
  process.exit(0);
}

try {
  const result = await smokeMacUpdateArtifact();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

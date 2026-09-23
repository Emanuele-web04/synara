// FILE: AntigravityInstaller.ts
// Purpose: Installs a pinned `agy_acp_server` artifact with SHA-512 verification.
// Layer: Server provider maintenance
//
// Synara never downloads on startup or provider enable. Install runs only when
// an explicit maintenance action calls `installAntigravityAcpServer`. When no
// download source is configured the installer fails with an actionable error
// instead of inventing a URL.

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const ANTIGRAVITY_ACP_PINNED_VERSION = "1.1.1";
export const ANTIGRAVITY_ACP_DOWNLOAD_URL_ENV = "ANTIGRAVITY_ACP_DOWNLOAD_URL";
export const ANTIGRAVITY_ACP_SHA512_ENV = "ANTIGRAVITY_ACP_SHA512";
export const ANTIGRAVITY_ACP_INSTALL_LOCK_KEY = "antigravity-acp-install";

export type AntigravityAcpArtifactKind = "executable" | "par";

export interface AntigravityAcpInstallManifestEntry {
  readonly version: string;
  readonly kind: AntigravityAcpArtifactKind;
  readonly sha512: string;
  readonly downloadUrl: string;
}

export interface AntigravityAcpInstallSource {
  readonly version: string;
  readonly downloadUrl: string;
  readonly sha512: string;
  readonly kind: AntigravityAcpArtifactKind;
}

export interface AntigravityAcpInstallOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly fetchImpl?: (url: string) => Promise<Response>;
  readonly tmpDir?: string;
}

export interface AntigravityAcpInstallResult {
  readonly outcome: "installed" | "already-installed" | "source-unconfigured" | "failed";
  readonly executablePath?: string;
  readonly version?: string;
  readonly detail?: string;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function antigravityAcpInstallDir(homeDir?: string): string {
  return nodePath.join(homeDir ?? nodeOs.homedir(), ".synara", "acp-servers", "antigravity");
}

export function antigravityAcpExecutableName(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return "agy_acp_server.exe";
  }
  return "agy_acp_server";
}

export function resolveAntigravityAcpInstallSource(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): AntigravityAcpInstallSource | null {
  const downloadUrl = nonEmpty(env[ANTIGRAVITY_ACP_DOWNLOAD_URL_ENV]);
  const sha512 = nonEmpty(env[ANTIGRAVITY_ACP_SHA512_ENV]);
  if (!downloadUrl || !sha512) {
    return null;
  }
  const kind: AntigravityAcpArtifactKind =
    platform === "win32" || downloadUrl.toLowerCase().endsWith(".exe") ? "executable" : "par";
  return {
    version: ANTIGRAVITY_ACP_PINNED_VERSION,
    downloadUrl,
    sha512: sha512.toLowerCase(),
    kind,
  };
}

async function sha512OfFile(filePath: string): Promise<string> {
  const hash = createHash("sha512");
  const { createReadStream } = await import("node:fs");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

export async function installAntigravityAcpServer(
  options: AntigravityAcpInstallOptions = {},
): Promise<AntigravityAcpInstallResult> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const installDir = antigravityAcpInstallDir(options.homeDir);
  const executablePath = nodePath.join(installDir, antigravityAcpExecutableName(platform));

  const source = resolveAntigravityAcpInstallSource(env, platform);
  if (!source) {
    return {
      outcome: "source-unconfigured",
      detail:
        `No agy_acp_server ${ANTIGRAVITY_ACP_PINNED_VERSION} download source is configured. ` +
        `Set ${ANTIGRAVITY_ACP_DOWNLOAD_URL_ENV} and ${ANTIGRAVITY_ACP_SHA512_ENV}, ` +
        `or place the server under ${installDir}, then retry.`,
    };
  }

  if (await fileExists(executablePath)) {
    try {
      const digest = await sha512OfFile(executablePath);
      if (digest === source.sha512) {
        return { outcome: "already-installed", executablePath, version: source.version };
      }
    } catch {
      // Fall through and reinstall when the existing file cannot be verified.
    }
  }

  const fetchImpl =
    options.fetchImpl ??
    (async (url: string) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Download failed with HTTP ${response.status} for ${url}`);
      }
      return response;
    });

  const tmpDir = options.tmpDir ?? installDir;
  await mkdir(tmpDir, { recursive: true });
  const tmpPath = nodePath.join(tmpDir, `.agy_acp_server-${process.pid}-${Date.now()}.download`);

  try {
    const response = await fetchImpl(source.downloadUrl);
    const body = response.body;
    if (!body) {
      throw new Error(`Download returned an empty body for ${source.downloadUrl}`);
    }
    await pipeline(
      Readable.fromWeb(body as unknown as import("node:stream/web").ReadableStream),
      createWriteStream(tmpPath),
    );

    const digest = await sha512OfFile(tmpPath);
    if (digest !== source.sha512) {
      throw new Error(
        `SHA-512 mismatch for agy_acp_server ${source.version}: expected ${source.sha512}, got ${digest}.`,
      );
    }

    await mkdir(installDir, { recursive: true });
    await rename(tmpPath, executablePath);
    if (platform !== "win32") {
      await chmod(executablePath, 0o755);
    }
    return { outcome: "installed", executablePath, version: source.version };
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    return {
      outcome: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

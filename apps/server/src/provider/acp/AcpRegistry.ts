// FILE: AcpRegistry.ts
// Purpose: Read the curated ACP agent registry (agentclientprotocol.com) and
//   resolve each entry into a Synara provider-instance launch config — npx/uvx
//   agents launch directly, binary agents download and unpack into a managed
//   directory under the Synara base dir.
// Layer: Provider registry
// Depends on: node fs for downloads, processRuntime for archive extraction.
//
// The registry is the same index other ACP clients (Zed, JetBrains IDEs) use,
// so "any ACP agent" keeps working without a Synara-side integration.

import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import { resolveExecutable } from "@synara/shared/executable";
import { execProcessFile } from "@synara/shared/processRuntime";

const execFileAsync = (command: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execProcessFile(command, args, {}, (error) => (error ? reject(error) : resolve()));
  });

export const ACP_REGISTRY_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const REGISTRY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30 * 1000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const INSTALL_MARKER = ".synara-install.json";

// ---- Raw registry payload (untrusted; parsed defensively) ----

type RegistryBinaryTarget = {
  archive?: unknown;
  cmd?: unknown;
  args?: unknown;
  sha256?: unknown;
};

type RegistryAgentJson = {
  id?: unknown;
  name?: unknown;
  version?: unknown;
  description?: unknown;
  repository?: unknown;
  icon?: unknown;
  distribution?: {
    npx?: { package?: unknown; args?: unknown };
    uvx?: { package?: unknown; args?: unknown };
    binary?: Record<string, RegistryBinaryTarget>;
  };
};

export type AcpRegistryLaunch = {
  kind: "npx" | "uvx" | "binary";
  installable: boolean;
  command?: string;
  args?: string[];
};

export type AcpRegistryAvailability = {
  // "installed": the pinned managed build for this registry version is on disk.
  // "update-available": an older managed version is on disk; installing fetches
  //   the registry's current build.
  // "on-path": the agent's own CLI resolves on PATH (binary agents only).
  state: "installed" | "update-available" | "on-path";
  path?: string;
  installedVersion?: string;
};

export type AcpRegistryAgentDescriptor = {
  id: string;
  name: string;
  version: string;
  description?: string;
  repository?: string;
  icon?: string;
  launch: AcpRegistryLaunch;
  availability?: AcpRegistryAvailability;
};

export type AcpRegistryInstallResult = {
  command: string;
  args: string[];
  installDir?: string;
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const asArgs = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((a): a is string => typeof a === "string") : [];

// ---- Platform key, e.g. "darwin-aarch64" ----

const PLATFORM_NAMES: Record<string, string> = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};
const ARCH_NAMES: Record<string, string> = {
  arm64: "aarch64",
  x64: "x86_64",
};

export function acpRegistryPlatformKey(
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  const os = PLATFORM_NAMES[platform];
  const cpu = ARCH_NAMES[arch];
  if (!os || !cpu) return null;
  return `${os}-${cpu}`;
}

// ---- Registry fetch + cache ----

let registryCache: { fetchedAt: number; agents: RegistryAgentJson[] } | null = null;
let registryInflight: Promise<RegistryAgentJson[]> | null = null;

export function clearAcpRegistryCacheForTests(): void {
  registryCache = null;
  registryInflight = null;
}

async function fetchRegistryAgents(): Promise<RegistryAgentJson[]> {
  if (registryCache && Date.now() - registryCache.fetchedAt < REGISTRY_CACHE_TTL_MS) {
    return registryCache.agents;
  }
  registryInflight ??= (async () => {
    const response = await fetch(ACP_REGISTRY_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`ACP registry responded ${response.status}`);
    }
    const body: unknown = await response.json();
    const agents =
      body && typeof body === "object" && Array.isArray((body as { agents?: unknown }).agents)
        ? (body as { agents: RegistryAgentJson[] }).agents
        : [];
    registryCache = { fetchedAt: Date.now(), agents };
    return agents;
  })().finally(() => {
    registryInflight = null;
  });
  return registryInflight;
}

// ---- Launch resolution ----

function binaryTargetFor(
  agent: RegistryAgentJson,
  platformKey: string,
): RegistryBinaryTarget | null {
  const binary = agent.distribution?.binary;
  if (!binary) return null;
  const target = binary[platformKey];
  return target && asString(target.archive) && asString(target.cmd) ? target : null;
}

function resolveLaunch(agent: RegistryAgentJson, platformKey: string | null): AcpRegistryLaunch {
  // npx/uvx launch through the package runner, so no download is needed at all.
  const npx = agent.distribution?.npx;
  if (npx && asString(npx.package)) {
    return {
      kind: "npx",
      installable: true,
      command: "npx",
      args: [asString(npx.package)!, ...asArgs(npx.args)],
    };
  }
  const uvx = agent.distribution?.uvx;
  if (uvx && asString(uvx.package)) {
    return {
      kind: "uvx",
      installable: true,
      command: "uvx",
      args: [asString(uvx.package)!, ...asArgs(uvx.args)],
    };
  }
  const target = platformKey !== null ? binaryTargetFor(agent, platformKey) : null;
  if (!target) {
    return { kind: "binary", installable: false };
  }
  // The bare executable name (e.g. "cursor-agent") for PATH detection and
  // display; the managed absolute path only exists after install.
  const cmd = asString(target.cmd)!;
  return {
    kind: "binary",
    installable: true,
    command: nodePath.basename(cmd.replaceAll("\\", "/")),
    args: asArgs(target.args),
  };
}

// ---- Managed-install availability ----

async function hasInstallMarker(dir: string): Promise<boolean> {
  try {
    await stat(nodePath.join(dir, INSTALL_MARKER));
    return true;
  } catch {
    return false;
  }
}

// Detects which lifecycle state a binary agent is in for this machine:
// managed install at the registry's version, an older managed install
// (update-available), or the agent's own CLI already on PATH.
async function resolveAvailability(
  agent: RegistryAgentJson,
  launch: AcpRegistryLaunch,
  platformKey: string | null,
  synaraBaseDir: string,
): Promise<AcpRegistryAvailability | undefined> {
  if (launch.kind !== "binary" || platformKey === null) return undefined;
  const id = asString(agent.id);
  const version = asString(agent.version);
  const target = binaryTargetFor(agent, platformKey);
  if (!id || !version || !target) return undefined;
  const relCmd = asString(target.cmd)!.replaceAll("\\", "/").replace(/^\.\//u, "");
  // Unsafe registry metadata is a hard failure on install; on the read-only
  // availability path it simply means nothing is installed.
  let parent: string;
  let currentDir: string;
  let sanitizedVersion: string;
  try {
    parent = nodePath.join(synaraAcpAgentsDir(synaraBaseDir), sanitizePathSegment(id, "agent id"));
    sanitizedVersion = sanitizePathSegment(version, "version");
    currentDir = nodePath.join(parent, sanitizedVersion);
  } catch {
    return undefined;
  }
  const managedCommand = nodePath.join(currentDir, relCmd);
  if ((await hasInstallMarker(currentDir)) && (await stat(managedCommand).catch(() => null))) {
    return { state: "installed", path: managedCommand };
  }
  try {
    for (const entry of await readdir(parent)) {
      if (entry === sanitizedVersion) continue;
      if (await hasInstallMarker(nodePath.join(parent, entry))) {
        return { state: "update-available", installedVersion: entry };
      }
    }
  } catch {
    // No managed directory at all.
  }
  const onPath = launch.command ? resolveExecutable(launch.command) : null;
  return onPath ? { state: "on-path", path: onPath } : undefined;
}

export async function listAcpRegistryAgents(synaraBaseDir?: string): Promise<{
  agents: AcpRegistryAgentDescriptor[];
  cached: boolean;
  runners: { npx: boolean; uvx: boolean };
}> {
  const hadCache =
    registryCache !== null && Date.now() - registryCache.fetchedAt < REGISTRY_CACHE_TTL_MS;
  const agents = await fetchRegistryAgents();
  const platformKey = acpRegistryPlatformKey();
  const runners = {
    npx: resolveExecutable("npx") !== null,
    uvx: resolveExecutable("uvx") !== null,
  };
  const descriptors: AcpRegistryAgentDescriptor[] = [];
  for (const agent of agents) {
    const id = asString(agent.id);
    const name = asString(agent.name);
    const version = asString(agent.version);
    if (!id || !name || !version) continue;
    const launch = resolveLaunch(agent, platformKey);
    const descriptor: AcpRegistryAgentDescriptor = {
      id,
      name,
      version,
      launch,
    };
    if (synaraBaseDir !== undefined) {
      const availability = await resolveAvailability(agent, launch, platformKey, synaraBaseDir);
      if (availability !== undefined) descriptor.availability = availability;
    }
    const description = asString(agent.description);
    if (description !== undefined) descriptor.description = description;
    const repository = asString(agent.repository);
    if (repository !== undefined) descriptor.repository = repository;
    const icon = asString(agent.icon);
    if (icon !== undefined) descriptor.icon = icon;
    descriptors.push(descriptor);
  }
  return { agents: descriptors, cached: hadCache, runners };
}

// ---- Install ----

export function synaraAcpAgentsDir(synaraBaseDir: string): string {
  return nodePath.join(synaraBaseDir, "acp-agents");
}

const sanitizePathSegment = (value: string, label: string): string => {
  const sanitized = value.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  // "." and ".." survive the character filter but escape the agent directory.
  if (sanitized === "" || sanitized === "." || sanitized === "..") {
    throw new Error(`Registry ${label} "${value}" is not a safe path segment.`);
  }
  return sanitized;
};

async function downloadArchive(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    redirect: "follow",
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }
  const declaredSize = Number(response.headers.get("content-length") ?? "0");
  if (declaredSize > MAX_ARCHIVE_BYTES) {
    throw new Error("Registry agent download is too large.");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_ARCHIVE_BYTES) {
        throw new Error("Registry agent download is too large.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  // bsdtar (macOS, Windows 10+, many Linux distros) unpacks zip too; GNU tar on
  // Linux cannot, so .zip falls back to `unzip` there.
  const hostPlatform = process.platform;
  if (archivePath.endsWith(".zip") && hostPlatform === "linux") {
    await execFileAsync("unzip", ["-o", "-q", archivePath, "-d", destDir]);
    return;
  }
  await execFileAsync("tar", ["-xf", archivePath, "-C", destDir]);
}

// Keyed by registry id so concurrent installs of the same agent share one download.
const pendingInstalls = new Map<string, Promise<AcpRegistryInstallResult>>();

async function installBinaryAgent(
  agent: RegistryAgentJson,
  platformKey: string,
  synaraBaseDir: string,
): Promise<AcpRegistryInstallResult> {
  const id = asString(agent.id)!;
  const version = asString(agent.version)!;
  // Validate path segments before any filesystem use: "." and ".." survive the
  // character filter but escape the agent directory during the recursive delete.
  const agentsRoot = synaraAcpAgentsDir(synaraBaseDir);
  const parent = nodePath.join(agentsRoot, sanitizePathSegment(id, "agent id"));
  const installDir = nodePath.join(parent, sanitizePathSegment(version, "version"));
  if (!installDir.startsWith(parent + nodePath.sep)) {
    throw new Error(`Registry install path escapes the agent directory for "${id}".`);
  }
  const target = binaryTargetFor(agent, platformKey);
  if (!target) {
    throw new Error(`"${asString(agent.name) ?? id}" has no build for ${platformKey}`);
  }
  const archiveUrl = asString(target.archive)!;
  const expectedSha = asString(target.sha256);
  const relCmd = asString(target.cmd)!.replaceAll("\\", "/").replace(/^\.\//u, "");
  const args = asArgs(target.args);
  const command = nodePath.join(installDir, relCmd);
  if (!command.startsWith(installDir + nodePath.sep)) {
    throw new Error(`Registry command "${relCmd}" escapes the install directory for "${id}".`);
  }

  const isInstalled = async (): Promise<boolean> => {
    try {
      await stat(nodePath.join(installDir, INSTALL_MARKER));
      await stat(command);
      return true;
    } catch {
      return false;
    }
  };
  if (await isInstalled()) {
    return { command, args, installDir };
  }

  const pending = (async () => {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(nodePath.join(parent, ".install-"));
    try {
      const archive = await downloadArchive(archiveUrl);
      if (expectedSha) {
        const actual = createHash("sha256").update(archive).digest("hex");
        if (actual !== expectedSha) {
          throw new Error(`Checksum mismatch for ${id} (${actual} != ${expectedSha})`);
        }
      }
      const archivePath = nodePath.join(staging, "agent-archive");
      await writeFile(archivePath, archive);
      const unpacked = nodePath.join(staging, "unpacked");
      await mkdir(unpacked, { recursive: true });
      await extractArchive(archivePath, unpacked);
      const stagedCommand = nodePath.join(unpacked, relCmd);
      const hostPlatform = process.platform;
      if (hostPlatform !== "win32") {
        await chmod(stagedCommand, 0o755);
      }
      await stat(stagedCommand); // fail loudly when the archive layout differs
      await writeFile(
        nodePath.join(unpacked, INSTALL_MARKER),
        JSON.stringify({ archive: archiveUrl, sha256: expectedSha ?? null, cmd: relCmd }),
        { mode: 0o600 },
      );
      await rm(installDir, { recursive: true, force: true });
      try {
        await rename(unpacked, installDir);
      } catch (error) {
        // Another server process sharing this state directory may have finished first.
        if (!(await isInstalled())) throw error;
      }
      return { command, args, installDir };
    } finally {
      // Only our unique, newly created staging directory; never user files.
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  })().finally(() => {
    pendingInstalls.delete(id);
  });
  pendingInstalls.set(id, pending);
  return pending;
}

export async function installAcpRegistryAgent(
  agentId: string,
  synaraBaseDir: string,
): Promise<AcpRegistryInstallResult> {
  const existing = pendingInstalls.get(agentId);
  if (existing) return existing;

  const agents = await fetchRegistryAgents();
  const agent = agents.find((candidate) => asString(candidate.id) === agentId);
  if (!agent) {
    throw new Error(`ACP registry agent "${agentId}" not found`);
  }
  const platformKey = acpRegistryPlatformKey();
  const launch = resolveLaunch(agent, platformKey);
  if (launch.kind !== "binary") {
    return { command: launch.command!, args: launch.args ?? [] };
  }
  if (platformKey === null) {
    throw new Error(
      `Unsupported platform for registry binaries: ${process.platform}/${process.arch}`,
    );
  }
  return installBinaryAgent(agent, platformKey, synaraBaseDir);
}

// ---- Uninstall ----

export type AcpUninstallResult = {
  removed: boolean;
  /** Set when another provider instance still launches from this managed dir. */
  inUseByInstanceId?: string;
};

// Removes the managed install an account's command points into. Only deletes
// directories under the private `acp-agents` root; any other path is a no-op.
export async function uninstallAcpManagedAgent(input: {
  command: string;
  synaraBaseDir: string;
  /** instanceId -> command of other ACP instances that may share this install. */
  otherInstances: ReadonlyArray<{ instanceId: string; command?: string }>;
}): Promise<AcpUninstallResult> {
  const root = nodePath.resolve(synaraAcpAgentsDir(input.synaraBaseDir));
  const relative = nodePath.relative(root, nodePath.resolve(input.command));
  if (relative === "" || relative.startsWith("..") || nodePath.isAbsolute(relative)) {
    return { removed: false };
  }
  const segments = relative.split(nodePath.sep);
  const id = segments[0];
  const version = segments[1];
  // Command must name a file inside <id>/<version>/, not the dir itself.
  if (!id || !version || segments.length < 3) {
    return { removed: false };
  }
  const idDir = nodePath.join(root, id);
  for (const other of input.otherInstances) {
    if (!other.command) continue;
    const otherRel = nodePath.relative(idDir, nodePath.resolve(other.command));
    if (otherRel !== "" && !otherRel.startsWith("..") && !nodePath.isAbsolute(otherRel)) {
      return { removed: false, inUseByInstanceId: other.instanceId };
    }
  }
  await rm(nodePath.join(idDir, version), { recursive: true, force: true });
  // Drop the agent dir entirely once its last version is gone.
  const remaining = await readdir(idDir).catch(() => [] as string[]);
  if (remaining.length === 0) {
    await rm(idDir, { recursive: true, force: true });
  }
  return { removed: true };
}

// FILE: codexProcessEnv.ts
// Purpose: Builds the exact environment used when Synara launches Codex subprocesses.
// Layer: Server runtime utility
// Exports: Codex process env builder and browser-plugin overlay helpers.
// Depends on: Codex home path helpers, shared Codex config parsing, login-shell env reader.

import * as fs from "node:fs/promises";
import { lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import path from "node:path";

import { readActiveCodexProviderEnvKey } from "@synara/shared/codexConfig";
import {
  readEnvironmentFromLoginShell,
  resolveLoginShell,
  type ShellEnvironmentReader,
} from "@synara/shared/shell";

import {
  resolveBaseCodexHomePath,
  resolveCodexHomeOverlayAccountSegment,
  resolveSynaraCodexHomeOverlayPath,
} from "./codexHomePaths.ts";
import { codexPathsReferenceSameLocation, resolveCodexPathIdentity } from "./codexPathIdentity.ts";
import {
  buildProviderChildEnvironment,
  registerProviderCredentialKey,
} from "./providerChildEnvironment.ts";

const CODEX_PROCESS_SHELL_ENV_NAMES = ["PATH", "SSH_AUTH_SOCK"] as const;
const CODEX_OVERLAY_SHARED_STATE_FILES = new Set(["auth.json"]);
const CODEX_ACCOUNT_PRIVATE_STATE_FILES = new Set(["auth.json", "models_cache.json"]);
// SQLite databases and their WAL/SHM/journal sidecars are never mirrored into
// the overlay. SQLite derives sidecar paths from the path it opened the
// database through, and on Windows deleting a sidecar through a symlink only
// removes the link, so a per-file mirror lets Synara's app-server and an
// external `codex` CLI end up with two WALs on one database. The overlay
// instead points CODEX_SQLITE_HOME at the source home so every process opens
// the same files through the same path.
const CODEX_SQLITE_STATE_ENTRY_PATTERN = /^.+\.sqlite(?:-(?:wal|shm|journal))?$/;
const SYNARA_CONFIG_SUPPRESSIONS_FILE = "synara-config-suppressions-v1.json";
const SYNARA_SHARED_CONTINUATION_MARKER_FILE = "synara-shared-continuation-v1.json";
const SYNARA_SHARED_CONTINUATION_MARKER_VERSION = 1;
const SYNARA_SHARED_CONTINUATION_LOCK_DIRECTORY = ".synara-shared-continuation-v1.lock";
const SYNARA_SHARED_CONTINUATION_LOCK_OWNER_FILE = "owner.json";
const SYNARA_SHARED_CONTINUATION_LOCK_TIMEOUT_MS = 10_000;
const SYNARA_SHARED_CONTINUATION_LOCK_POLL_MS = 25;
const SYNARA_SHARED_CONTINUATION_ORPHAN_LOCK_GRACE_MS = 30_000;
const REQUIRED_SHARED_CONTINUATION_DIRECTORIES = [
  "sessions",
  "archived_sessions",
  "sqlite",
] as const;
const REQUIRED_SHARED_CONTINUATION_FILES = [
  "history.jsonl",
  "session_index.jsonl",
  "state_5.sqlite",
] as const;
const SYNARA_MANAGED_MCP_TABLE_HEADER = "[mcp_servers.synara]";
export const SYNARA_COMPETING_BROWSER_PLUGIN_SECTION_HEADERS = [
  '[plugins."browser@openai-bundled"]',
  '[plugins."chrome@openai-bundled"]',
  '[plugins."computer-use@openai-bundled"]',
] as const;
const MAX_CONFIG_SUPPRESSION_SECTIONS = 32;
const MAX_CONFIG_SUPPRESSION_HEADER_LENGTH = 256;
const codexOverlayPreparationQueues = new Map<string, Promise<void>>();
// Retired local browser integrations used a stable six-character namespace.
// Match the structural conflict without retaining any previous product name.
const CONFLICTING_LOCAL_BROWSER_PLUGIN_SECTION_PATTERN =
  /^\[plugins\."[a-z0-9][a-z0-9-]{5}-browser@local"\]$/;

interface CodexOverlayEntryLinker {
  readonly symlink: typeof fs.symlink;
  readonly copyFile: typeof fs.copyFile;
}

function isSafePluginSectionHeader(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_CONFIG_SUPPRESSION_HEADER_LENGTH &&
    /^\[plugins\."[^"\r\n]+"\]$/.test(value)
  );
}

export async function readSynaraConfigSuppressions(markerPath: string): Promise<readonly string[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(markerPath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return [];
    const marker = parsed as { version?: unknown; sectionHeaders?: unknown };
    if (marker.version !== 1 || !Array.isArray(marker.sectionHeaders)) return [];
    if (marker.sectionHeaders.length > MAX_CONFIG_SUPPRESSION_SECTIONS) return [];
    return [...new Set(marker.sectionHeaders.filter(isSafePluginSectionHeader))];
  } catch {
    return [];
  }
}

function findConflictingLocalBrowserPluginSections(config: string): readonly string[] {
  return [
    ...new Set(
      config
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => CONFLICTING_LOCAL_BROWSER_PLUGIN_SECTION_PATTERN.test(line)),
    ),
  ];
}

export function disableCodexConfigSections(
  config: string,
  sectionHeaders: readonly string[],
  appendMissing = false,
): string {
  const targetsByName = new Map<string, string>();
  for (const header of sectionHeaders) {
    if (!isSafePluginSectionHeader(header)) continue;
    const tableName = normalizeTomlTableHeaderName(header);
    if (tableName !== undefined && !targetsByName.has(tableName)) {
      targetsByName.set(tableName, header);
    }
  }
  const lines = config.split(/\r?\n/);
  const output: string[] = [];
  let inTargetSection = false;
  const seenTargetSections = new Set<string>();
  let targetSectionHasEnabled = false;

  const closeTargetSection = () => {
    if (inTargetSection && !targetSectionHasEnabled) {
      output.push("enabled = false");
    }
  };

  for (const line of lines) {
    const tableName = normalizeTomlTableHeaderName(line);
    if (tableName !== undefined) {
      closeTargetSection();
      inTargetSection = targetsByName.has(tableName);
      if (inTargetSection) seenTargetSections.add(tableName);
      targetSectionHasEnabled = false;
      output.push(line);
      continue;
    }

    if (inTargetSection && /^\s*enabled\s*=/.test(line)) {
      output.push("enabled = false");
      targetSectionHasEnabled = true;
      continue;
    }

    output.push(line);
  }

  closeTargetSection();

  if (appendMissing) {
    for (const [tableName, header] of targetsByName) {
      if (seenTargetSections.has(tableName)) continue;
      if (output.length > 0 && output.at(-1)?.trim()) {
        output.push("");
      }
      output.push(header, "enabled = false");
    }
  }

  return output.join("\n");
}

export function disableCompetingCodexBrowserPluginsInConfig(config: string): string {
  return disableCodexConfigSections(
    config,
    [
      ...SYNARA_COMPETING_BROWSER_PLUGIN_SECTION_HEADERS,
      ...findConflictingLocalBrowserPluginSections(config),
    ],
    true,
  );
}

async function writeSynaraConfigSuppressions(
  markerPath: string,
  sectionHeaders: readonly string[],
): Promise<void> {
  const normalized = [...new Set(sectionHeaders.filter(isSafePluginSectionHeader))].slice(
    0,
    MAX_CONFIG_SUPPRESSION_SECTIONS,
  );
  const temporaryPath = `${markerPath}.${process.pid}.tmp`;
  await fs.writeFile(
    temporaryPath,
    `${JSON.stringify({ version: 1, sectionHeaders: normalized }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.rename(temporaryPath, markerPath);
}

export async function linkOrCopyCodexOverlayEntry(
  input: {
    readonly entryName: string;
    readonly sourcePath: string;
    readonly targetPath: string;
    readonly type: "dir" | "file";
  },
  linker: CodexOverlayEntryLinker = {
    symlink: fs.symlink,
    copyFile: fs.copyFile,
  },
): Promise<void> {
  try {
    await linker.symlink(input.sourcePath, input.targetPath, input.type);
  } catch (error: unknown) {
    if (input.type === "file" && CODEX_OVERLAY_SHARED_STATE_FILES.has(input.entryName)) {
      await linker.copyFile(input.sourcePath, input.targetPath);
      return;
    }
    throw error;
  }
}

export function prioritizeCodexOverlayEntries(entries: readonly string[]): string[] {
  const sharedStateEntries: string[] = [];
  const otherEntries: string[] = [];

  for (const entry of entries) {
    if (CODEX_OVERLAY_SHARED_STATE_FILES.has(entry)) {
      sharedStateEntries.push(entry);
    } else {
      otherEntries.push(entry);
    }
  }

  return [...sharedStateEntries, ...otherEntries];
}

async function ensureCodexOverlaySymlink(input: {
  readonly entryName: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly type: "dir" | "file";
  readonly force?: boolean;
}, linker?: CodexOverlayEntryLinker): Promise<void> {
  let targetStat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
  try {
    targetStat = await fs.lstat(input.targetPath);
  } catch {
    targetStat = undefined;
  }

  if (targetStat) {
    if (targetStat.isSymbolicLink() && (await fs.readlink(input.targetPath)) === input.sourcePath) {
      return;
    }

    if (
      input.force ||
      targetStat.isSymbolicLink() ||
      CODEX_OVERLAY_SHARED_STATE_FILES.has(input.entryName)
    ) {
      // Account-private state and auth must mirror the selected Codex home so
      // external `codex login` changes are visible.
      await fs.rm(input.targetPath, { recursive: true, force: true });
    } else {
      return;
    }
  }

  await linkOrCopyCodexOverlayEntry(input, linker);
}

function isCodexSqliteStateEntry(entryName: string): boolean {
  return CODEX_SQLITE_STATE_ENTRY_PATTERN.test(entryName);
}

type SharedContinuationEntryKind = "dir" | "file";

interface SharedContinuationMigration {
  readonly entryName: string;
  readonly kind: SharedContinuationEntryKind;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly action: "create-source" | "link-only";
}

function sharedContinuationMarkerPath(sourceHomePath: string): string {
  return path.join(sourceHomePath, SYNARA_SHARED_CONTINUATION_MARKER_FILE);
}

function sharedContinuationLockPath(sourceHomePath: string): string {
  return path.join(sourceHomePath, SYNARA_SHARED_CONTINUATION_LOCK_DIRECTORY);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code ?? "")
    : undefined;
}

function isMissingPathError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

async function readSharedContinuationLockOwner(lockPath: string): Promise<number | undefined> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(lockPath, SYNARA_SHARED_CONTINUATION_LOCK_OWNER_FILE), "utf8"),
    ) as { readonly pid?: unknown };
    return typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0
      ? parsed.pid
      : undefined;
  } catch (error) {
    if (isMissingPathError(error) || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

async function canReclaimSharedContinuationLock(lockPath: string): Promise<boolean> {
  const ownerPid = await readSharedContinuationLockOwner(lockPath);
  if (ownerPid !== undefined) {
    return !processIsAlive(ownerPid);
  }
  const lockStat = await lstatIfExists(lockPath);
  return (
    lockStat !== undefined &&
    Date.now() - Number(lockStat.mtimeMs) >= SYNARA_SHARED_CONTINUATION_ORPHAN_LOCK_GRACE_MS
  );
}

async function withSharedContinuationLock<T>(
  sourceHomePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  await fs.mkdir(sourceHomePath, { recursive: true });
  const lockPath = sharedContinuationLockPath(sourceHomePath);
  const startedAt = Date.now();

  while (true) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      try {
        await fs.writeFile(
          path.join(lockPath, SYNARA_SHARED_CONTINUATION_LOCK_OWNER_FILE),
          `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
      } catch (error) {
        await fs.rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
      if (await canReclaimSharedContinuationLock(lockPath)) {
        await fs.rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - startedAt >= SYNARA_SHARED_CONTINUATION_LOCK_TIMEOUT_MS) {
        throw new Error(
          `Timed out waiting for Codex continuation-state preparation lock at ${lockPath}.`,
          { cause: error },
        );
      }
      await sleep(SYNARA_SHARED_CONTINUATION_LOCK_POLL_MS);
    }
  }

  try {
    return await operation();
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}

function isSharedContinuationEntry(entryName: string): boolean {
  return (
    REQUIRED_SHARED_CONTINUATION_DIRECTORIES.includes(
      entryName as (typeof REQUIRED_SHARED_CONTINUATION_DIRECTORIES)[number],
    ) ||
    REQUIRED_SHARED_CONTINUATION_FILES.includes(
      entryName as (typeof REQUIRED_SHARED_CONTINUATION_FILES)[number],
    ) ||
    isCodexSqliteStateEntry(entryName)
  );
}

async function readDirectoryEntries(directoryPath: string): Promise<readonly string[]> {
  try {
    return await fs.readdir(directoryPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }
}

function sharedContinuationEntryKind(entryName: string): SharedContinuationEntryKind {
  return REQUIRED_SHARED_CONTINUATION_DIRECTORIES.includes(
    entryName as (typeof REQUIRED_SHARED_CONTINUATION_DIRECTORIES)[number],
  )
    ? "dir"
    : "file";
}

async function resolvedSymlinkTarget(linkPath: string): Promise<string> {
  const target = await fs.readlink(linkPath);
  return path.isAbsolute(target) ? target : path.resolve(path.dirname(linkPath), target);
}

async function lstatIfExists(
  entryPath: string,
): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try {
    return await fs.lstat(entryPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

function assertSharedContinuationEntryType(input: {
  readonly entryName: string;
  readonly entryPath: string;
  readonly kind: SharedContinuationEntryKind;
  readonly stat: NonNullable<Awaited<ReturnType<typeof fs.lstat>>>;
}): void {
  const matches = input.kind === "dir" ? input.stat.isDirectory() : input.stat.isFile();
  if (!matches) {
    throw new Error(
      `Codex continuation state '${input.entryName}' at ${input.entryPath} is not a ${input.kind === "dir" ? "directory" : "regular file"}.`,
    );
  }
}

async function planSharedContinuationMigration(input: {
  readonly entryName: string;
  readonly sourceHomePath: string;
  readonly overlayHomePath: string;
}): Promise<SharedContinuationMigration | undefined> {
  const kind = sharedContinuationEntryKind(input.entryName);
  const sourcePath = path.join(input.sourceHomePath, input.entryName);
  const targetPath = path.join(input.overlayHomePath, input.entryName);
  const [sourceStat, targetStat] = await Promise.all([
    lstatIfExists(sourcePath),
    lstatIfExists(targetPath),
  ]);

  if (targetStat?.isSymbolicLink()) {
    if (!codexPathsReferenceSameLocation(await resolvedSymlinkTarget(targetPath), sourcePath)) {
      throw new Error(
        `Codex continuation state at ${targetPath} points outside the shared source home; remove or repair the stale link before starting this account.`,
      );
    }
    if (sourceStat) {
      assertSharedContinuationEntryType({
        entryName: input.entryName,
        entryPath: sourcePath,
        kind,
        stat: sourceStat,
      });
      return undefined;
    }
    return { entryName: input.entryName, kind, sourcePath, targetPath, action: "create-source" };
  }

  if (!sourceStat && !targetStat) {
    return { entryName: input.entryName, kind, sourcePath, targetPath, action: "create-source" };
  }
  if (sourceStat && !targetStat) {
    return { entryName: input.entryName, kind, sourcePath, targetPath, action: "link-only" };
  }
  if (!sourceStat && targetStat) {
    assertSharedContinuationEntryType({
      entryName: input.entryName,
      entryPath: targetPath,
      kind,
      stat: targetStat,
    });
    throw new Error(
      `Codex continuation state '${input.entryName}' exists only in ${input.overlayHomePath}; refusing to migrate legacy state automatically because an active Codex process may still own it. Move it to ${input.sourceHomePath} while Codex is stopped, then retry.`,
    );
  }

  assertSharedContinuationEntryType({
    entryName: input.entryName,
    entryPath: sourcePath,
    kind,
    stat: sourceStat!,
  });
  assertSharedContinuationEntryType({
    entryName: input.entryName,
    entryPath: targetPath,
    kind,
    stat: targetStat!,
  });

  throw new Error(
    `Codex continuation state '${input.entryName}' exists as real entries in both ${input.sourceHomePath} and ${input.overlayHomePath}; refusing to replace either copy because an active Codex process may still own it.`,
  );
}

async function assertMigrationPreconditionsStillHold(
  migration: SharedContinuationMigration,
): Promise<void> {
  const [sourceStat, targetStat] = await Promise.all([
    lstatIfExists(migration.sourcePath),
    lstatIfExists(migration.targetPath),
  ]);
  switch (migration.action) {
    case "create-source":
      if (sourceStat !== undefined) {
        throw new Error(
          `Codex continuation source appeared during preparation at ${migration.sourcePath}; refusing to overwrite unexpected state.`,
        );
      }
      if (targetStat?.isSymbolicLink()) {
        if (
          !codexPathsReferenceSameLocation(
            await resolvedSymlinkTarget(migration.targetPath),
            migration.sourcePath,
          )
        ) {
          throw new Error(
            `Codex continuation link changed during preparation at ${migration.targetPath}.`,
          );
        }
      } else if (targetStat !== undefined) {
        throw new Error(
          `Codex continuation target appeared during preparation at ${migration.targetPath}; refusing to overwrite unexpected state.`,
        );
      }
      return;
    case "link-only":
      if (!sourceStat || targetStat) {
        throw new Error(
          `Codex continuation state changed during preparation for ${migration.entryName}; retry after the active writer stops.`,
        );
      }
      assertSharedContinuationEntryType({
        entryName: migration.entryName,
        entryPath: migration.sourcePath,
        kind: migration.kind,
        stat: sourceStat,
      });
      return;
  }
}

async function createSharedContinuationSource(
  migration: SharedContinuationMigration,
): Promise<void> {
  if (migration.kind === "dir") {
    await fs.mkdir(migration.sourcePath);
  } else {
    await fs.writeFile(migration.sourcePath, "", { flag: "wx", mode: 0o600 });
  }
}

async function executeSharedContinuationMigration(
  migration: SharedContinuationMigration,
  linker?: CodexOverlayEntryLinker,
): Promise<void> {
  await assertMigrationPreconditionsStillHold(migration);
  switch (migration.action) {
    case "create-source":
      await createSharedContinuationSource(migration);
      break;
    case "link-only":
      break;
  }

  // SQLite state is shared through CODEX_SQLITE_HOME so every process opens
  // one canonical path and one set of sidecars. Other continuation entries are
  // shared through the account overlay itself.
  if (isCodexSqliteStateEntry(migration.entryName)) {
    return;
  }
  const targetStat = await lstatIfExists(migration.targetPath);
  if (
    targetStat?.isSymbolicLink() &&
    codexPathsReferenceSameLocation(
      await resolvedSymlinkTarget(migration.targetPath),
      migration.sourcePath,
    )
  ) {
    return;
  }
  await linkOrCopyCodexOverlayEntry(
    {
      entryName: migration.entryName,
      sourcePath: migration.sourcePath,
      targetPath: migration.targetPath,
      type: migration.kind,
    },
    linker,
  );
}

async function prepareSharedCodexContinuationState(input: {
  readonly sourceHomePath: string;
  readonly overlayHomePath: string;
  readonly overlayEntryLinker?: CodexOverlayEntryLinker;
}): Promise<void> {
  await withSharedContinuationLock(input.sourceHomePath, async () => {
    await fs.rm(sharedContinuationMarkerPath(input.sourceHomePath), { force: true });
    const [sourceEntries, overlayEntries] = await Promise.all([
      readDirectoryEntries(input.sourceHomePath),
      readDirectoryEntries(input.overlayHomePath),
    ]);
    const entryNames = new Set<string>([
      ...REQUIRED_SHARED_CONTINUATION_DIRECTORIES,
      ...REQUIRED_SHARED_CONTINUATION_FILES,
      ...sourceEntries.filter(isSharedContinuationEntry),
      ...overlayEntries.filter(isSharedContinuationEntry),
    ]);
    const migrations = (
      await Promise.all(
        [...entryNames].toSorted().map((entryName) =>
          planSharedContinuationMigration({
            entryName,
            sourceHomePath: input.sourceHomePath,
            overlayHomePath: input.overlayHomePath,
          }),
        ),
      )
    ).filter((migration): migration is SharedContinuationMigration => migration !== undefined);

    for (const migration of migrations) {
      await executeSharedContinuationMigration(migration, input.overlayEntryLinker);
    }
    if (
      !selectedCodexOverlaySharesContinuationState({
        sourceHomePath: input.sourceHomePath,
        overlayHomePath: input.overlayHomePath,
      })
    ) {
      throw new Error(
        `Codex continuation state at ${input.overlayHomePath} is not fully linked to ${input.sourceHomePath}.`,
      );
    }
    await writeSharedCodexContinuationMarker(input.sourceHomePath);
  });
}

async function writeSharedCodexContinuationMarker(sourceHomePath: string): Promise<void> {
  const markerPath = sharedContinuationMarkerPath(sourceHomePath);
  const temporaryPath = `${markerPath}.${process.pid}.tmp`;
  await fs.writeFile(
    temporaryPath,
    `${JSON.stringify({
      version: SYNARA_SHARED_CONTINUATION_MARKER_VERSION,
      sourceHomeIdentity: resolveCodexPathIdentity(sourceHomePath),
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.rename(temporaryPath, markerPath);
}

function lstatSyncIfExists(entryPath: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(entryPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

function readDirectoryEntriesSync(directoryPath: string): readonly string[] {
  try {
    return readdirSync(directoryPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }
}

function resolvedSymlinkTargetSync(linkPath: string): string {
  const target = readlinkSync(linkPath);
  return path.isAbsolute(target) ? target : path.resolve(path.dirname(linkPath), target);
}

function sharedContinuationIdentityEntryNames(input: {
  readonly sourceHomePath: string;
  readonly overlayHomePath: string;
}): readonly string[] {
  const stateDatabaseFilePattern = /^.+\.sqlite$/;
  return [
    ...new Set([
      ...REQUIRED_SHARED_CONTINUATION_DIRECTORIES,
      ...REQUIRED_SHARED_CONTINUATION_FILES,
      ...readDirectoryEntriesSync(input.sourceHomePath).filter((entryName) =>
        stateDatabaseFilePattern.test(entryName),
      ),
      ...readDirectoryEntriesSync(input.overlayHomePath).filter(isCodexSqliteStateEntry),
    ]),
  ];
}

function selectedCodexOverlaySharesContinuationState(input: {
  readonly sourceHomePath: string;
  readonly overlayHomePath: string;
}): boolean {
  if (codexPathsReferenceSameLocation(input.sourceHomePath, input.overlayHomePath)) {
    return true;
  }
  return sharedContinuationIdentityEntryNames(input).every((entryName) => {
    const sourcePath = path.join(input.sourceHomePath, entryName);
    const targetPath = path.join(input.overlayHomePath, entryName);
    const kind = sharedContinuationEntryKind(entryName);
    const sourceStat = lstatSyncIfExists(sourcePath);
    const targetStat = lstatSyncIfExists(targetPath);
    const sourceMatchesExpectedType =
      sourceStat !== undefined &&
      (kind === "dir" ? sourceStat.isDirectory() : sourceStat.isFile());
    if (!sourceMatchesExpectedType) {
      return false;
    }
    if (isCodexSqliteStateEntry(entryName)) {
      // SQLite state is opened through CODEX_SQLITE_HOME, never through an
      // overlay mirror, so any overlay-side database entry is stale.
      return targetStat === undefined;
    }
    return (
      targetStat?.isSymbolicLink() === true &&
      codexPathsReferenceSameLocation(resolvedSymlinkTargetSync(targetPath), sourcePath)
    );
  });
}

export function isCodexSharedContinuationStatePrepared(input: {
  readonly env?: NodeJS.ProcessEnv;
  readonly homePath?: string;
  readonly shadowHomePath?: string;
  readonly accountId?: string;
} = {}): boolean {
  const env = { ...(input.env ?? process.env) };
  const sourceHomePath = resolveBaseCodexHomePath(env, input.homePath);
  const shadowHomePath = input.shadowHomePath
    ? resolveBaseCodexHomePath(env, input.shadowHomePath)
    : undefined;
  const overlayHomePath = resolveSynaraCodexHomeOverlayPath(
    env,
    sourceHomePath,
    resolveCodexHomeOverlayAccountSegment({
      homePath: sourceHomePath,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(shadowHomePath ? { shadowHomePath } : {}),
    }),
  );
  try {
    const marker = JSON.parse(
      readFileSync(sharedContinuationMarkerPath(sourceHomePath), "utf8"),
    ) as { readonly version?: unknown; readonly sourceHomeIdentity?: unknown };
    const markerMatches =
      marker.version === SYNARA_SHARED_CONTINUATION_MARKER_VERSION &&
      marker.sourceHomeIdentity === resolveCodexPathIdentity(sourceHomePath);
    const sourceHasRequiredState =
      REQUIRED_SHARED_CONTINUATION_DIRECTORIES.every((entryName) =>
        statSync(path.join(sourceHomePath, entryName)).isDirectory(),
      ) &&
      REQUIRED_SHARED_CONTINUATION_FILES.every((entryName) =>
        statSync(path.join(sourceHomePath, entryName)).isFile(),
      );
    return (
      markerMatches &&
      sourceHasRequiredState &&
      selectedCodexOverlaySharesContinuationState({ sourceHomePath, overlayHomePath })
    );
  } catch {
    return false;
  }
}

/**
 * Removes SQLite links that earlier Synara releases mirrored into the overlay.
 * Only symlinks are removed: a regular database file in the overlay is left
 * untouched because Synara no longer owns or reads it.
 */
async function removeLegacyCodexOverlaySqliteLinks(overlayHomePath: string): Promise<void> {
  for (const entry of await fs.readdir(overlayHomePath)) {
    if (!isCodexSqliteStateEntry(entry)) {
      continue;
    }
    const targetPath = path.join(overlayHomePath, entry);
    if ((await fs.lstat(targetPath)).isSymbolicLink()) {
      await fs.rm(targetPath, { force: true });
    }
  }
}

export function appendCodexConfigSection(config: string, section: string): string {
  const trimmedSection = section.trim();
  if (!trimmedSection) {
    return config;
  }
  if (config.includes(trimmedSection.split("\n")[0] ?? trimmedSection)) {
    return config;
  }
  const base = config.trimEnd();
  return base.length > 0 ? `${base}\n\n${trimmedSection}\n` : `${trimmedSection}\n`;
}

export const SYNARA_MANAGED_CODEX_CONFIG_BEGIN = "# >>> synara managed config >>>";
export const SYNARA_MANAGED_CODEX_CONFIG_END = "# <<< synara managed config <<<";

export function extractManagedCodexConfigSection(config: string): string | undefined {
  const begin = config.indexOf(SYNARA_MANAGED_CODEX_CONFIG_BEGIN);
  if (begin === -1) {
    return undefined;
  }
  const contentStart = begin + SYNARA_MANAGED_CODEX_CONFIG_BEGIN.length;
  const end = config.indexOf(SYNARA_MANAGED_CODEX_CONFIG_END, contentStart);
  if (end === -1) {
    return undefined;
  }
  const content = config.slice(contentStart, end).trim();
  return content.length > 0 ? content : undefined;
}

function normalizeTomlTableHeaderName(line: string): string | undefined {
  const match = /^\s*\[\s*(.*?)\s*\]\s*(?:#.*)?$/.exec(line);
  if (!match) {
    return undefined;
  }
  const tableName = match[1];
  if (tableName === undefined) {
    return undefined;
  }
  const parts: string[] = [];
  let index = 0;
  const skipWhitespace = () => {
    while (index < tableName.length && /[\t ]/.test(tableName[index]!)) index += 1;
  };
  const parseBasicQuotedKey = (): string | undefined => {
    index += 1;
    let value = "";
    while (index < tableName.length) {
      const character = tableName[index++]!;
      if (character === '"') return value;
      if (character !== "\\") {
        if (character.charCodeAt(0) < 0x20) return undefined;
        value += character;
        continue;
      }
      const escape = tableName[index++];
      const simpleEscapes: Readonly<Record<string, string>> = {
        b: "\b",
        t: "\t",
        n: "\n",
        f: "\f",
        r: "\r",
        '"': '"',
        "\\": "\\",
      };
      if (escape !== undefined && simpleEscapes[escape] !== undefined) {
        value += simpleEscapes[escape];
        continue;
      }
      if (escape !== "u" && escape !== "U") return undefined;
      const length = escape === "u" ? 4 : 8;
      const hexadecimal = tableName.slice(index, index + length);
      if (!new RegExp(`^[0-9A-Fa-f]{${length}}$`).test(hexadecimal)) return undefined;
      const codePoint = Number.parseInt(hexadecimal, 16);
      if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return undefined;
      value += String.fromCodePoint(codePoint);
      index += length;
    }
    return undefined;
  };
  const parseLiteralQuotedKey = (): string | undefined => {
    index += 1;
    const end = tableName.indexOf("'", index);
    if (end === -1) return undefined;
    const value = tableName.slice(index, end);
    index = end + 1;
    return value;
  };

  while (index < tableName.length) {
    skipWhitespace();
    let part: string | undefined;
    if (tableName[index] === '"') {
      part = parseBasicQuotedKey();
    } else if (tableName[index] === "'") {
      part = parseLiteralQuotedKey();
    } else {
      const start = index;
      while (index < tableName.length && /[A-Za-z0-9_-]/.test(tableName[index]!)) index += 1;
      part = index > start ? tableName.slice(start, index) : undefined;
    }
    if (part === undefined) return undefined;
    parts.push(part);
    skipWhitespace();
    if (index === tableName.length) break;
    if (tableName[index] !== ".") return undefined;
    index += 1;
    skipWhitespace();
    if (index === tableName.length) return undefined;
  }
  return parts.length > 0 ? JSON.stringify(parts) : undefined;
}

interface TomlTableHeaderLocation {
  readonly index: number;
  readonly end: number;
}

function findTomlTableHeader(config: string, header: string): TomlTableHeaderLocation | undefined {
  const target = normalizeTomlTableHeaderName(header);
  if (!target) {
    return undefined;
  }
  let offset = 0;
  for (const rawLine of config.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (normalizeTomlTableHeaderName(line) === target) {
      return { index: offset, end: offset + line.length };
    }
    offset += rawLine.length + 1;
  }
  return undefined;
}

function findNextTomlTableHeaderIndex(config: string, start: number): number {
  const tail = config.slice(start);
  let offset = 0;
  for (const rawLine of tail.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (normalizeTomlTableHeaderName(line) !== undefined) {
      return start + offset;
    }
    offset += rawLine.length + 1;
  }
  return config.length;
}

export function configHasTomlTableHeader(config: string, header: string): boolean {
  return findTomlTableHeader(config, header) !== undefined;
}

function splitTomlTables(snippet: string): string[] {
  const tables: string[] = [];
  let current: string[] = [];
  for (const line of snippet.split("\n")) {
    if (/^\s*\[/.test(line) && current.length > 0) {
      tables.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) {
    tables.push(current.join("\n").trim());
  }
  return tables.filter((table) => table.length > 0);
}

function findTomlTableHeaderInNamespace(
  config: string,
  namespaceHeader: string,
): TomlTableHeaderLocation | undefined {
  const namespace = normalizeTomlTableHeaderName(namespaceHeader);
  if (!namespace) {
    return undefined;
  }
  const descendantPrefix = `${namespace.slice(0, -1)},`;
  let offset = 0;
  for (const rawLine of config.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const table = normalizeTomlTableHeaderName(line);
    if (table === namespace || table?.startsWith(descendantPrefix)) {
      return { index: offset, end: offset + line.length };
    }
    offset += rawLine.length + 1;
  }
  return undefined;
}

function removeTomlTableNamespace(config: string, namespaceHeader: string): string {
  let result = config;
  while (true) {
    const match = findTomlTableHeaderInNamespace(result, namespaceHeader);
    if (!match) {
      return result;
    }
    const tableEnd = findNextTomlTableHeaderIndex(result, match.end);
    result = `${result.slice(0, match.index)}${result.slice(tableEnd)}`;
  }
}

function maskTomlComments(input: string): string {
  let result = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let inComment = false;

  for (const character of input) {
    if (inComment) {
      if (character === "\n" || character === "\r") {
        inComment = false;
        result += character;
      } else {
        result += " ";
      }
      continue;
    }

    if (quote) {
      result += character;
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      result += character;
    } else if (character === "#") {
      inComment = true;
      result += " ";
    } else {
      result += character;
    }
  }

  return result;
}

function findTomlArrayEnd(input: string, openBracketIndex: number): number | undefined {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let depth = 0;

  for (let index = openBracketIndex; index < input.length; index += 1) {
    const character = input[index];
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return undefined;
}

function mergeTomlStringArrayValues(
  config: string,
  tableHeader: string,
  key: string,
  values: readonly string[],
): string {
  const additions = [...new Set(values.filter(Boolean))];
  if (additions.length === 0) {
    return config;
  }
  const headerMatch = findTomlTableHeader(config, tableHeader);
  if (!headerMatch) {
    return config;
  }
  const tableStart = headerMatch.end;
  const tableEnd = findNextTomlTableHeaderIndex(config, tableStart);
  const tableBody = config.slice(tableStart, tableEnd);
  const activeTableBody = maskTomlComments(tableBody);
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const arrayPattern = new RegExp(`(^[\\t ]*${escapedKey}[\\t ]*=[\\t ]*\\[)`, "m");
  const arrayMatch = arrayPattern.exec(activeTableBody);

  if (arrayMatch) {
    const openBracketIndex = arrayMatch.index + arrayMatch[0].lastIndexOf("[");
    const closeBracketIndex = findTomlArrayEnd(activeTableBody, openBracketIndex);
    if (closeBracketIndex === undefined) {
      return config;
    }
    const activeArray = activeTableBody.slice(openBracketIndex + 1, closeBracketIndex);
    const missing = additions.filter((value) => {
      const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return !new RegExp(`(["'])${escapedValue}\\1`).test(activeArray);
    });
    if (missing.length === 0) {
      return config;
    }

    const insertAt = tableStart + openBracketIndex + 1;
    const separator = activeArray.trim().length > 0 ? ", " : "";
    return `${config.slice(0, insertAt)}${missing.map((value) => JSON.stringify(value)).join(", ")}${separator}${config.slice(insertAt)}`;
  }

  return `${config.slice(0, tableStart)}\n${key} = [${additions.map((value) => JSON.stringify(value)).join(", ")}]${config.slice(tableStart)}`;
}

export function mergeShellEnvPolicyExclude(config: string, envVarName: string): string {
  return mergeTomlStringArrayValues(
    config,
    "[shell_environment_policy]",
    "exclude",
    envVarName ? [envVarName] : [],
  );
}

function appendManagedCodexConfigSection(config: string, section: string): string {
  let overlayConfig = config;
  const managedMcpTableName = normalizeTomlTableHeaderName(SYNARA_MANAGED_MCP_TABLE_HEADER);
  const managedMcpDescendantPrefix = `${managedMcpTableName!.slice(0, -1)},`;
  const tables: string[] = [];

  for (const table of splitTomlTables(section.trim())) {
    const header = table.split("\n")[0]?.trim();
    if (header === undefined) {
      tables.push(table);
      continue;
    }
    const tableName = normalizeTomlTableHeaderName(header);
    if (tableName?.startsWith(managedMcpDescendantPrefix)) {
      continue;
    }
    if (tableName === managedMcpTableName) {
      // The session-scoped gateway entry is authoritative inside Synara's
      // overlay. The user's source config remains untouched.
      overlayConfig = removeTomlTableNamespace(overlayConfig, SYNARA_MANAGED_MCP_TABLE_HEADER);
      // Recover only the fields Synara generates for its HTTP gateway. Saved
      // stdio fields (including multiline args/env) make Codex reject the config.
      tables.push(
        [
          header,
          ...table.split("\n").filter((line) => /^\s*(url|bearer_token_env_var)\s*=/.test(line)),
        ].join("\n"),
      );
      continue;
    }
    if (!configHasTomlTableHeader(overlayConfig, header)) {
      tables.push(table);
    }
  }

  if (tables.length === 0) {
    return overlayConfig;
  }
  return appendCodexConfigSection(
    overlayConfig,
    `${SYNARA_MANAGED_CODEX_CONFIG_BEGIN}\n${tables.join("\n\n")}\n${SYNARA_MANAGED_CODEX_CONFIG_END}`,
  );
}

async function serializeCodexOverlayPreparation<A>(
  overlayHomePath: string,
  prepare: () => Promise<A>,
): Promise<A> {
  const previous = codexOverlayPreparationQueues.get(overlayHomePath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(prepare);
  const queued = current.then(
    () => undefined,
    () => undefined,
  );
  codexOverlayPreparationQueues.set(overlayHomePath, queued);
  try {
    return await current;
  } finally {
    if (codexOverlayPreparationQueues.get(overlayHomePath) === queued) {
      codexOverlayPreparationQueues.delete(overlayHomePath);
    }
  }
}

async function prepareSynaraCodexHomeOverlayUnlocked(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homePath?: string;
  readonly shadowHomePath?: string;
  readonly accountId?: string;
  readonly appendConfigToml?: string;
  readonly overlayEntryLinker?: CodexOverlayEntryLinker;
}): Promise<string | undefined> {
  const sourceHomePath = resolveBaseCodexHomePath(input.env, input.homePath);
  // A genuinely distinct explicit home belongs to the account and may mirror
  // private state. Repeating the shared CODEX_HOME explicitly must not turn it
  // into an account-owned home or leak the default account's credentials.
  const hasDedicatedAccountHome =
    Boolean(input.homePath?.trim()) &&
    path.resolve(sourceHomePath) !== path.resolve(resolveBaseCodexHomePath(input.env));
  const shadowHomePath = input.shadowHomePath
    ? resolveBaseCodexHomePath(input.env, input.shadowHomePath)
    : undefined;
  if (shadowHomePath) {
    if (path.resolve(sourceHomePath) === path.resolve(shadowHomePath)) {
      throw new Error("Codex account shadow home must be different from CODEX_HOME.");
    }
    // A symlinked shadow home aliases another account's credentials through the
    // directory itself, bypassing the per-file symlink guard further down.
    let shadowStat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
    try {
      shadowStat = await fs.lstat(shadowHomePath);
    } catch {
      shadowStat = undefined;
    }
    if (shadowStat?.isSymbolicLink()) {
      throw new Error(
        `Codex account shadow home at ${shadowHomePath} is a symlink; it must be a real directory so accounts cannot alias each other's auth.`,
      );
    }
    const resolveRealPath = async (candidate: string): Promise<string | undefined> => {
      try {
        return await fs.realpath(candidate);
      } catch {
        return undefined;
      }
    };
    const shadowRealPath = shadowStat ? await resolveRealPath(shadowHomePath) : undefined;
    const sourceRealPath = await resolveRealPath(sourceHomePath);
    if (
      shadowRealPath &&
      sourceRealPath &&
      path.resolve(shadowRealPath) === path.resolve(sourceRealPath)
    ) {
      throw new Error("Codex account shadow home must be different from CODEX_HOME.");
    }
  }
  const accountSegment = resolveCodexHomeOverlayAccountSegment({
    homePath: sourceHomePath,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(shadowHomePath ? { shadowHomePath } : {}),
  });
  const overlayHomePath = resolveSynaraCodexHomeOverlayPath(
    input.env,
    sourceHomePath,
    accountSegment,
  );
  if (path.resolve(sourceHomePath) === path.resolve(overlayHomePath)) {
    return undefined;
  }

  await fs.mkdir(overlayHomePath, { recursive: true });
  await removeLegacyCodexOverlaySqliteLinks(overlayHomePath);
  // Continuation preparation is all-or-nothing for default and account
  // overlays. A host that cannot create the required links fails closed.
  await prepareSharedCodexContinuationState({
    sourceHomePath,
    overlayHomePath,
    ...(input.overlayEntryLinker ? { overlayEntryLinker: input.overlayEntryLinker } : {}),
  });

  try {
    // Auth must get a best-effort link/copy before optional entries whose
    // symlinks may fail on restricted Windows installs.
    for (const entry of prioritizeCodexOverlayEntries(await fs.readdir(sourceHomePath))) {
      if (
        entry === "config.toml" ||
        entry === SYNARA_SHARED_CONTINUATION_MARKER_FILE ||
        isSharedContinuationEntry(entry)
      ) {
        continue;
      }
      // Account overlays only inherit account-private state when the source
      // home is the account's own dedicated home. With a shadow home the
      // private files are linked from there below; with a shared source home
      // the account keeps its own login inside the overlay instead of
      // silently reusing the default account's credentials.
      if (
        accountSegment &&
        CODEX_ACCOUNT_PRIVATE_STATE_FILES.has(entry) &&
        (shadowHomePath || !hasDedicatedAccountHome)
      ) {
        continue;
      }
      const sourcePath = path.join(sourceHomePath, entry);
      const targetPath = path.join(overlayHomePath, entry);
      const stat = await fs.lstat(sourcePath);
      await ensureCodexOverlaySymlink({
        entryName: entry,
        sourcePath,
        targetPath,
        type: stat.isDirectory() ? "dir" : "file",
      });
    }
  } catch {
    // If the source home is partially missing, Codex can still start with the
    // overlay config and create any required state lazily.
  }

  if (accountSegment && !shadowHomePath && !hasDedicatedAccountHome) {
    for (const entry of CODEX_ACCOUNT_PRIVATE_STATE_FILES) {
      const targetPath = path.join(overlayHomePath, entry);
      try {
        // Earlier builds symlinked shared auth into account overlays; drop the
        // stale alias so the account's own login (a real file) takes its place.
        if ((await fs.lstat(targetPath)).isSymbolicLink()) {
          await fs.rm(targetPath, { force: true });
        }
      } catch {
        // Missing private state is created lazily by the account's own login.
      }
    }
  }

  if (shadowHomePath) {
    for (const entry of CODEX_ACCOUNT_PRIVATE_STATE_FILES) {
      const sourcePath = path.join(shadowHomePath, entry);
      let sourceStat: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        sourceStat = await fs.lstat(sourcePath);
      } catch {
        // Missing shadow homes should not prevent Codex from creating account
        // state lazily, but existing private files must never be read or logged.
        continue;
      }
      // Symlinked account-private state can silently alias another account's
      // credentials, so it must always be a real file in the shadow home.
      if (sourceStat.isSymbolicLink()) {
        throw new Error(
          `Codex account private state at ${sourcePath} is a symlink; it must be a real file so accounts cannot alias each other's private state.`,
        );
      }
      const targetPath = path.join(overlayHomePath, entry);
      await ensureCodexOverlaySymlink({
        entryName: entry,
        sourcePath,
        targetPath,
        type: sourceStat.isDirectory() ? "dir" : "file",
        force: true,
      });
    }
  }

  const sourceConfigPath = path.join(sourceHomePath, "config.toml");
  const sourceConfig = await fs.readFile(sourceConfigPath, "utf8").catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw cause;
  });
  const suppressionMarkerPath = path.join(overlayHomePath, SYNARA_CONFIG_SUPPRESSIONS_FILE);
  const suppressedSections = [
    ...new Set([
      ...SYNARA_COMPETING_BROWSER_PLUGIN_SECTION_HEADERS,
      ...findConflictingLocalBrowserPluginSections(sourceConfig),
      ...(await readSynaraConfigSuppressions(suppressionMarkerPath)),
    ]),
  ].slice(0, MAX_CONFIG_SUPPRESSION_SECTIONS);
  const overlayConfigPath = path.join(overlayHomePath, "config.toml");
  let overlayConfig = disableCodexConfigSections(sourceConfig, suppressedSections, true);
  const managedSection =
    input.appendConfigToml ??
    (await fs
      .readFile(overlayConfigPath, "utf8")
      .then(extractManagedCodexConfigSection)
      .catch((cause: unknown) => {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw cause;
      }));
  if (managedSection) {
    overlayConfig = appendManagedCodexConfigSection(overlayConfig, managedSection);
    const tokenEnvVar = /bearer_token_env_var\s*=\s*"([^"]+)"/.exec(managedSection)?.[1];
    if (tokenEnvVar) {
      overlayConfig = mergeShellEnvPolicyExclude(overlayConfig, tokenEnvVar);
    }
  }
  await fs.writeFile(overlayConfigPath, overlayConfig, "utf8");
  await writeSynaraConfigSuppressions(suppressionMarkerPath, suppressedSections);

  return overlayHomePath;
}

async function prepareSynaraCodexHomeOverlay(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homePath?: string;
  readonly shadowHomePath?: string;
  readonly accountId?: string;
  readonly appendConfigToml?: string;
  readonly overlayEntryLinker?: CodexOverlayEntryLinker;
}): Promise<string | undefined> {
  const sourceHomePath = resolveBaseCodexHomePath(input.env, input.homePath);
  const shadowHomePath = input.shadowHomePath
    ? resolveBaseCodexHomePath(input.env, input.shadowHomePath)
    : undefined;
  const overlayHomePath = resolveSynaraCodexHomeOverlayPath(
    input.env,
    sourceHomePath,
    resolveCodexHomeOverlayAccountSegment({
      homePath: sourceHomePath,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(shadowHomePath ? { shadowHomePath } : {}),
    }),
  );
  if (path.resolve(sourceHomePath) === path.resolve(overlayHomePath)) {
    return undefined;
  }
  return serializeCodexOverlayPreparation(overlayHomePath, () =>
    prepareSynaraCodexHomeOverlayUnlocked(input),
  );
}

export async function buildCodexProcessEnv(
  input: {
    readonly env?: NodeJS.ProcessEnv;
    readonly homePath?: string;
    readonly shadowHomePath?: string;
    readonly accountId?: string;
    readonly platform?: NodeJS.Platform;
    readonly readEnvironment?: ShellEnvironmentReader;
    readonly appendConfigToml?: string;
    readonly skipHomeOverlay?: boolean;
    readonly overlayEntryLinker?: CodexOverlayEntryLinker;
  } = {},
): Promise<NodeJS.ProcessEnv> {
  const baseEnv = { ...(input.env ?? process.env) };
  const overlayHomePath = input.skipHomeOverlay
    ? undefined
    : await prepareSynaraCodexHomeOverlay({
        env: baseEnv,
        ...(input.homePath ? { homePath: input.homePath } : {}),
        ...(input.shadowHomePath ? { shadowHomePath: input.shadowHomePath } : {}),
        ...(input.accountId ? { accountId: input.accountId } : {}),
        ...(input.appendConfigToml ? { appendConfigToml: input.appendConfigToml } : {}),
        ...(input.overlayEntryLinker
          ? { overlayEntryLinker: input.overlayEntryLinker }
          : {}),
      });
  const directAccountHomePath = input.shadowHomePath
    ? resolveBaseCodexHomePath(baseEnv, input.shadowHomePath)
    : input.homePath
      ? resolveBaseCodexHomePath(baseEnv, input.homePath)
      : undefined;
  const configuredEnv =
    overlayHomePath || directAccountHomePath
      ? { ...baseEnv, CODEX_HOME: overlayHomePath ?? directAccountHomePath }
      : baseEnv;
  if (overlayHomePath && !configuredEnv.CODEX_SQLITE_HOME?.trim()) {
    // Keep every Codex process (Synara's app-server, the user's own `codex`
    // CLI) on one SQLite home reached through one path; see
    // CODEX_SQLITE_STATE_ENTRY_PATTERN. A user-provided value wins.
    configuredEnv.CODEX_SQLITE_HOME = resolveBaseCodexHomePath(baseEnv, input.homePath);
  }
  const platform = input.platform ?? process.platform;
  const effectiveEnv = buildProviderChildEnvironment({
    provider: "codex",
    baseEnv: configuredEnv,
  });
  const providerEnvKey = readActiveCodexProviderEnvKey(effectiveEnv);
  if (providerEnvKey) {
    registerProviderCredentialKey(providerEnvKey);
  }

  if (platform === "darwin" || platform === "linux") {
    try {
      const shell = resolveLoginShell(platform, effectiveEnv.SHELL);
      if (shell && providerEnvKey && !effectiveEnv[providerEnvKey]?.trim()) {
        const shellEnvironment = (input.readEnvironment ?? readEnvironmentFromLoginShell)(shell, [
          ...CODEX_PROCESS_SHELL_ENV_NAMES,
          providerEnvKey,
        ]);

        if (shellEnvironment.PATH) {
          effectiveEnv.PATH = shellEnvironment.PATH;
        }
        if (!effectiveEnv.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) {
          effectiveEnv.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
        }
        if (shellEnvironment[providerEnvKey]) {
          effectiveEnv[providerEnvKey] = shellEnvironment[providerEnvKey];
        }
      }
    } catch {
      // Keep inherited environment if shell lookup fails.
    }
  }

  return effectiveEnv;
}

// FILE: codexProcessEnv.ts
// Purpose: Builds the exact environment used when Synara launches Codex subprocesses.
// Layer: Server runtime utility
// Exports: Codex process env builder and browser-plugin overlay helpers.
// Depends on: Codex home path helpers, shared Codex config parsing, login-shell env reader.

import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  realpathSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  type BigIntStats,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { parse as parseToml } from "smol-toml";

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

const CODEX_PROCESS_SHELL_ENV_NAMES = ["PATH", "SSH_AUTH_SOCK"] as const;
const CODEX_SQLITE_HOME_ENV_NAME = "CODEX_SQLITE_HOME";
const NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS = "NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS";
const CODEX_OVERLAY_SHARED_STATE_FILES = new Set(["auth.json"]);
const CODEX_ACCOUNT_PRIVATE_STATE_FILES = new Set(["auth.json", "models_cache.json"]);
const SYNARA_CONFIG_SUPPRESSIONS_FILE = "synara-config-suppressions-v1.json";
const SYNARA_AUTH_COPY_MARKER_FILE = "synara-auth-copy-v1.json";
const LEGACY_SYNARA_SHARED_CONTINUATION_MARKER_FILE = "synara-shared-continuation-v1.json";
const SYNARA_SHARED_CONTINUATION_MARKER_FILE = "synara-shared-continuation-v2.json";
const SYNARA_SHARED_CONTINUATION_MARKER_VERSION = 2;
const SHARED_CONTINUATION_GENERATION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUIRED_SHARED_CONTINUATION_DIRECTORIES = ["sessions", "archived_sessions"] as const;
const REQUIRED_SHARED_CONTINUATION_FILES = ["history.jsonl", "session_index.jsonl"] as const;
const CODEX_SQLITE_STATE_ENTRY_PATTERN = /\.sqlite(?:-(?:wal|shm|journal))?$/;
const MAX_CONFIG_SUPPRESSION_SECTIONS = 32;
const MAX_CONFIG_SUPPRESSION_HEADER_LENGTH = 256;
// Retired local browser integrations used a stable six-character namespace.
// Match the structural conflict without retaining any previous product name.
const CONFLICTING_LOCAL_BROWSER_PLUGIN_SECTION_PATTERN =
  /^\[plugins\."[a-z0-9][a-z0-9-]{5}-browser@local"\]$/;

export interface CodexOverlayEntryLinker {
  readonly symlink: typeof symlinkSync;
  readonly copyFile: typeof copyFileSync;
}

export function resolveCodexBrowserUsePipePath(
  input: {
    readonly env?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
  } = {},
): string {
  const env = input.env ?? process.env;
  const configured = env.SYNARA_BROWSER_USE_PIPE_PATH?.trim();
  if (configured) {
    return configured;
  }
  return (input.platform ?? process.platform) === "win32"
    ? String.raw`\\.\pipe\codex-browser-use`
    : "/tmp/codex-browser-use.sock";
}

function isSafePluginSectionHeader(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_CONFIG_SUPPRESSION_HEADER_LENGTH &&
    /^\[plugins\."[^"\r\n]+"\]$/.test(value)
  );
}

export function readSynaraConfigSuppressions(markerPath: string): readonly string[] {
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as unknown;
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
  const targets = new Set(sectionHeaders.filter(isSafePluginSectionHeader));
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
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      closeTargetSection();
      inTargetSection = targets.has(trimmed);
      if (inTargetSection) seenTargetSections.add(trimmed);
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
    for (const header of targets) {
      if (seenTargetSections.has(header)) continue;
      if (output.length > 0 && output.at(-1)?.trim()) {
        output.push("");
      }
      output.push(header, "enabled = false");
    }
  }

  return output.join("\n");
}

export type CodexAuthCredentialsStoreMode = "file" | "keyring" | "auto" | "ephemeral";

export interface CodexAuthTracking {
  readonly sourceConfigPath: string;
  readonly authoritativeAuthFilePath: string;
  readonly effectiveAuthFilePath?: string;
}

export type CodexPreparedHomeSource =
  | { readonly kind: "missing" }
  | {
      readonly kind: "bound";
      readonly canonicalHomePath: string;
      readonly device: bigint;
      readonly inode: bigint;
    };

export type CodexPreparedAuthSource = CodexPreparedHomeSource;

export type CodexPreparedHomeFileSnapshotFailure =
  | "home-changed"
  | "home-unavailable"
  | "file-check-failed"
  | "symbolic-link"
  | "not-regular-file"
  | "file-changed"
  | "file-read-failed";

export class CodexPreparedHomeFileSnapshotError extends Error {
  readonly failure: CodexPreparedHomeFileSnapshotFailure;
  readonly fileName: string;

  constructor(
    failure: CodexPreparedHomeFileSnapshotFailure,
    fileName: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodexPreparedHomeFileSnapshotError";
    this.failure = failure;
    this.fileName = fileName;
  }
}

export interface PreparedCodexAuthTracking extends CodexAuthTracking {
  /** Stable config bytes captured from the same source-home identity selected for this request. */
  readonly sourceConfigSnapshot: string;
  /** The exact directory identity auxiliary generation is allowed to read. */
  readonly authSource: CodexPreparedAuthSource;
}

export interface CodexAuthTrackingPreparationHooks {
  /** Deterministic race-test seam. Production callers must omit this hook. */
  readonly afterSourceHomeBound?: () => void;
}

export interface CodexProcessLaunchContext {
  readonly env: NodeJS.ProcessEnv;
  readonly authTracking: CodexAuthTracking;
  readonly appServerArgs: readonly string[];
}

export function buildCodexAppServerArgs(sourceHomePath: string): readonly string[] {
  const absoluteSourceHomePath = path.resolve(sourceHomePath);
  // These are global clap options in the minimum supported Codex 0.105.0 and
  // are accepted after the app-server subcommand. Keeping them last gives them
  // CLI precedence over every config layer loaded by app-server.
  return [
    "app-server",
    "--config",
    `sqlite_home=${JSON.stringify(absoluteSourceHomePath)}`,
    "--config",
    'cli_auth_credentials_store="file"',
  ];
}

export interface CodexProcessEnvInput {
  readonly env?: NodeJS.ProcessEnv;
  readonly homePath?: string;
  readonly shadowHomePath?: string;
  readonly accountId?: string;
  readonly platform?: NodeJS.Platform;
  readonly readEnvironment?: ShellEnvironmentReader;
  readonly overlayEntryLinker?: CodexOverlayEntryLinker;
  /**
   * Pins a persisted resume/fork launch to the exact source-home generation
   * validated by ProviderService. When present, launch preparation is
   * validation-only and must never create or repair source continuation state.
   */
  readonly expectedSharedContinuationGeneration?: string;
  /** Validation-only v1 -> v2 migration used while upgrading persisted bindings. */
  readonly allowLegacySharedContinuationMigration?: boolean;
}

export function hydrateCodexProviderCredentialEnvironment(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly credentialEnvNames: ReadonlyArray<string>;
  readonly trustedEnv?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly readEnvironment?: ShellEnvironmentReader;
}): NodeJS.ProcessEnv {
  const env = { ...input.env };
  const missingNames = [...new Set(input.credentialEnvNames)].filter((name) => !env[name]?.trim());
  const platform = input.platform ?? process.platform;
  if (missingNames.length === 0 || (platform !== "darwin" && platform !== "linux")) {
    return env;
  }

  try {
    const shell = resolveLoginShell(platform, (input.trustedEnv ?? process.env).SHELL);
    if (!shell) return env;
    const shellEnvironment = (input.readEnvironment ?? readEnvironmentFromLoginShell)(
      shell,
      missingNames,
    );
    for (const name of missingNames) {
      const value = shellEnvironment[name];
      if (value?.trim()) env[name] = value;
    }
  } catch {
    // Login-shell probing is best effort; inherited provider credentials stay authoritative.
  }
  return env;
}

interface CodexOverlayResolution {
  readonly sourceHomePath: string;
  readonly hasDedicatedAccountHome: boolean;
  readonly shadowHomePath?: string;
  readonly accountSegment?: string;
  readonly overlayHomePath: string;
}

type SharedContinuationEntryKind = "dir" | "file";
type SharedContinuationSourcePolicy = "create-if-missing" | "require-prepared";

interface SharedContinuationSourceRequirements {
  readonly expectedGeneration?: string;
  readonly allowLegacyMigration?: boolean;
}

interface SharedContinuationGenerationMetadata {
  readonly generation: string;
  readonly migratedFromVersion?: 1;
}

type SharedContinuationGenerationState =
  | { readonly kind: "absent" }
  | { readonly kind: "legacy" }
  | ({ readonly kind: "v2" } & SharedContinuationGenerationMetadata);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseManagedCodexConfig(config: string): {
  readonly root: Record<string, unknown>;
  readonly activeProfile?: Record<string, unknown>;
} {
  let root: Record<string, unknown>;
  try {
    root = parseToml(config) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      "Codex config.toml must be valid TOML so Synara can verify managed account state safely.",
      { cause: error },
    );
  }

  if (root.profile === undefined) {
    return { root };
  }
  if (typeof root.profile !== "string" || root.profile.trim().length === 0) {
    throw new Error("Codex config profile must name a valid profile table.");
  }
  const activeProfile = asRecord(asRecord(root.profiles)?.[root.profile]);
  if (!activeProfile) {
    throw new Error(`Codex config profile '${root.profile}' does not name a valid profile table.`);
  }
  return { root, activeProfile };
}

function readEffectiveCodexSqliteHome(config: string): string | undefined {
  // Codex 0.105+ defines sqlite_home only on the root Config schema. A
  // same-named profile key is ignored by Codex and must not override the root
  // value in Synara's safety checks.
  const configured = parseManagedCodexConfig(config).root.sqlite_home;
  if (configured === undefined) {
    return undefined;
  }
  if (typeof configured !== "string") {
    throw new Error(
      "Codex sqlite_home must be a string absolute path so Synara can verify continuation storage safely.",
    );
  }
  return configured;
}

function assertCodexSqliteHomeMatchesSource(input: {
  readonly sourceConfig: string;
  readonly sourceHomePath: string;
}): void {
  const configured = readEffectiveCodexSqliteHome(input.sourceConfig);
  if (configured === undefined) {
    return;
  }
  if (
    !path.isAbsolute(configured) ||
    !codexPathsReferenceSameLocation(configured, input.sourceHomePath)
  ) {
    throw new Error(
      `Codex config sqlite_home at ${configured || "<empty>"} must resolve to the source CODEX_HOME ${path.resolve(input.sourceHomePath)} so Synara account overlays share one continuation database.`,
    );
  }
}

export function readEffectiveCodexAuthCredentialsStoreMode(
  config: string,
): CodexAuthCredentialsStoreMode {
  // cli_auth_credentials_store is also root-only in the supported Codex
  // schema. Treating a profile lookalike as effective can mask a root keyring
  // setting and leave an app-server's account identity unobservable.
  const mode = parseManagedCodexConfig(config).root.cli_auth_credentials_store;
  if (mode === undefined) {
    return "file";
  }
  if (mode === "file" || mode === "keyring" || mode === "auto" || mode === "ephemeral") {
    return mode;
  }
  throw new Error(
    "Codex cli_auth_credentials_store must be one of file, keyring, auto, or ephemeral.",
  );
}

function assertManagedCodexHomeUsesObservableAuth(input: {
  readonly sourceConfig: string;
  readonly accountId?: string;
}): void {
  const mode = readEffectiveCodexAuthCredentialsStoreMode(input.sourceConfig);
  if (mode !== "keyring" && mode !== "auto") {
    return;
  }
  const accountLabel = input.accountId?.trim() || "default";
  throw new Error(
    `Codex account '${accountLabel}' uses cli_auth_credentials_store = "${mode}". Synara-managed Codex homes require file-backed Codex auth so account changes can invalidate long-lived app-server sessions; set the root cli_auth_credentials_store = "file" before starting this account.`,
  );
}

function resolveCodexOverlayResolution(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homePath?: string;
  readonly shadowHomePath?: string;
  readonly accountId?: string;
}): CodexOverlayResolution {
  const sourceHomePath = resolveBaseCodexHomePath(input.env, input.homePath);
  const defaultHomePath = resolveBaseCodexHomePath(input.env);
  const hasDedicatedAccountHome = Boolean(
    input.homePath?.trim() && !codexPathsReferenceSameLocation(sourceHomePath, defaultHomePath),
  );
  const shadowHomePath = input.shadowHomePath
    ? resolveBaseCodexHomePath(input.env, input.shadowHomePath)
    : undefined;
  const accountSegment = resolveCodexHomeOverlayAccountSegment({
    homePath: sourceHomePath,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(shadowHomePath ? { shadowHomePath } : {}),
  });
  return {
    sourceHomePath,
    hasDedicatedAccountHome,
    ...(shadowHomePath ? { shadowHomePath } : {}),
    ...(accountSegment ? { accountSegment } : {}),
    overlayHomePath: resolveSynaraCodexHomeOverlayPath(input.env, sourceHomePath, accountSegment),
  };
}

function sharedContinuationMarkerPath(sourceHomePath: string): string {
  return path.join(sourceHomePath, SYNARA_SHARED_CONTINUATION_MARKER_FILE);
}

function legacySharedContinuationMarkerPath(sourceHomePath: string): string {
  return path.join(sourceHomePath, LEGACY_SYNARA_SHARED_CONTINUATION_MARKER_FILE);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code ?? "")
    : undefined;
}

function isMissingPathError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function lstatIfExists(filePath: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

function isSharedContinuationEntry(entryName: string): boolean {
  return (
    REQUIRED_SHARED_CONTINUATION_DIRECTORIES.includes(
      entryName as (typeof REQUIRED_SHARED_CONTINUATION_DIRECTORIES)[number],
    ) ||
    REQUIRED_SHARED_CONTINUATION_FILES.includes(
      entryName as (typeof REQUIRED_SHARED_CONTINUATION_FILES)[number],
    )
  );
}

function isCodexSqliteStateEntry(entryName: string): boolean {
  return CODEX_SQLITE_STATE_ENTRY_PATTERN.test(entryName);
}

function sharedContinuationEntryKind(entryName: string): SharedContinuationEntryKind {
  return REQUIRED_SHARED_CONTINUATION_DIRECTORIES.includes(
    entryName as (typeof REQUIRED_SHARED_CONTINUATION_DIRECTORIES)[number],
  )
    ? "dir"
    : "file";
}

function resolvedSymlinkTarget(linkPath: string): string {
  const target = readlinkSync(linkPath);
  return path.isAbsolute(target) ? target : path.resolve(path.dirname(linkPath), target);
}

function assertSharedContinuationEntryType(input: {
  readonly entryName: string;
  readonly entryPath: string;
  readonly kind: SharedContinuationEntryKind;
  readonly stat: NonNullable<ReturnType<typeof lstatSync>>;
}): void {
  const matches = input.kind === "dir" ? input.stat.isDirectory() : input.stat.isFile();
  if (!matches) {
    throw new Error(
      `Codex continuation state '${input.entryName}' at ${input.entryPath} is not a ${input.kind === "dir" ? "directory" : "regular file"}.`,
    );
  }
}

function assertContinuationTargetCanShareSource(input: {
  readonly entryName: string;
  readonly kind: SharedContinuationEntryKind;
  readonly sourceHomePath: string;
  readonly overlayHomePath: string;
}): void {
  const sourcePath = path.join(input.sourceHomePath, input.entryName);
  const targetPath = path.join(input.overlayHomePath, input.entryName);
  const sourceStat = lstatIfExists(sourcePath);
  const targetStat = lstatIfExists(targetPath);

  if (targetStat?.isSymbolicLink()) {
    if (!codexPathsReferenceSameLocation(resolvedSymlinkTarget(targetPath), sourcePath)) {
      throw new Error(
        `Codex continuation state at ${targetPath} points outside the shared source home; remove or repair the stale link before starting this account.`,
      );
    }
    if (sourceStat) {
      assertSharedContinuationEntryType({
        entryName: input.entryName,
        entryPath: sourcePath,
        kind: input.kind,
        stat: sourceStat,
      });
    }
    return;
  }

  if (!targetStat) {
    if (sourceStat) {
      assertSharedContinuationEntryType({
        entryName: input.entryName,
        entryPath: sourcePath,
        kind: input.kind,
        stat: sourceStat,
      });
    }
    return;
  }

  if (!sourceStat) {
    assertSharedContinuationEntryType({
      entryName: input.entryName,
      entryPath: targetPath,
      kind: input.kind,
      stat: targetStat,
    });
    throw new Error(
      `Codex continuation state '${input.entryName}' exists only in ${input.overlayHomePath}; refusing to migrate legacy state automatically because an active Codex process may still own it. Move it to ${input.sourceHomePath} while Codex is stopped, then retry.`,
    );
  }

  assertSharedContinuationEntryType({
    entryName: input.entryName,
    entryPath: sourcePath,
    kind: input.kind,
    stat: sourceStat!,
  });
  assertSharedContinuationEntryType({
    entryName: input.entryName,
    entryPath: targetPath,
    kind: input.kind,
    stat: targetStat!,
  });

  throw new Error(
    `Codex continuation state '${input.entryName}' exists as real entries in both ${input.sourceHomePath} and ${input.overlayHomePath}; refusing to replace either copy because an active Codex process may still own it.`,
  );
}

function ensureSharedContinuationSource(input: {
  readonly entryName: string;
  readonly kind: SharedContinuationEntryKind;
  readonly sourceHomePath: string;
  readonly overlayHomePath: string;
}): void {
  assertContinuationTargetCanShareSource(input);
  const sourcePath = path.join(input.sourceHomePath, input.entryName);
  const sourceStat = lstatIfExists(sourcePath);
  if (sourceStat) {
    assertSharedContinuationEntryType({
      entryName: input.entryName,
      entryPath: sourcePath,
      kind: input.kind,
      stat: sourceStat,
    });
    return;
  }

  try {
    if (input.kind === "dir") {
      mkdirSync(sourcePath);
    } else {
      writeFileSync(sourcePath, "", { flag: "wx", mode: 0o600 });
    }
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      throw error;
    }
    const racedSourceStat = lstatIfExists(sourcePath);
    if (!racedSourceStat) {
      throw error;
    }
    assertSharedContinuationEntryType({
      entryName: input.entryName,
      entryPath: sourcePath,
      kind: input.kind,
      stat: racedSourceStat,
    });
  }
}

function existingSharedContinuationTargetIsValid(input: {
  readonly entryName: string;
  readonly sourcePath: string;
  readonly targetPath: string;
}): boolean {
  const targetStat = lstatIfExists(input.targetPath);
  if (!targetStat) {
    return false;
  }
  if (
    targetStat.isSymbolicLink() &&
    codexPathsReferenceSameLocation(resolvedSymlinkTarget(input.targetPath), input.sourcePath)
  ) {
    return true;
  }
  if (targetStat.isSymbolicLink()) {
    throw new Error(
      `Codex continuation state '${input.entryName}' at ${input.targetPath} points outside the shared source home; remove or repair the stale link before starting this account.`,
    );
  }
  throw new Error(
    `Codex continuation target '${input.entryName}' appeared at ${input.targetPath}; refusing to overwrite raced or independently owned state.`,
  );
}

function ensureSharedContinuationTarget(
  input: {
    readonly entryName: string;
    readonly kind: SharedContinuationEntryKind;
    readonly sourceHomePath: string;
    readonly overlayHomePath: string;
  },
  linker?: CodexOverlayEntryLinker,
): void {
  const sourcePath = path.join(input.sourceHomePath, input.entryName);
  const targetPath = path.join(input.overlayHomePath, input.entryName);
  if (
    existingSharedContinuationTargetIsValid({
      entryName: input.entryName,
      sourcePath,
      targetPath,
    })
  ) {
    return;
  }

  try {
    (linker?.symlink ?? symlinkSync)(sourcePath, targetPath, input.kind);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      throw error;
    }
    if (
      existingSharedContinuationTargetIsValid({
        entryName: input.entryName,
        sourcePath,
        targetPath,
      })
    ) {
      return;
    }
    throw error;
  }
  if (
    !existingSharedContinuationTargetIsValid({
      entryName: input.entryName,
      sourcePath,
      targetPath,
    })
  ) {
    throw new Error(`Codex continuation link disappeared after creation at ${targetPath}.`);
  }
}

function prepareSharedCodexContinuationState(input: {
  readonly sourceHomePath: string;
  readonly overlayHomePath: string;
  readonly overlayEntryLinker?: CodexOverlayEntryLinker;
  readonly sourcePolicy?: SharedContinuationSourcePolicy;
  readonly sourceRequirements?: SharedContinuationSourceRequirements;
}): SharedContinuationGenerationMetadata {
  const sourcePolicy = input.sourcePolicy ?? "create-if-missing";
  let metadata: SharedContinuationGenerationMetadata;
  if (sourcePolicy === "create-if-missing") {
    mkdirSync(input.sourceHomePath, { recursive: true });
    const initialState = readSharedContinuationGenerationState(input.sourceHomePath);
    if (initialState.kind === "absent") {
      for (const entryName of sharedContinuationIdentityEntryNames().toSorted()) {
        ensureSharedContinuationSource({
          entryName,
          kind: sharedContinuationEntryKind(entryName),
          sourceHomePath: input.sourceHomePath,
          overlayHomePath: input.overlayHomePath,
        });
      }
    } else {
      // Once a source has a v1 marker or a v2 generation marker, missing state
      // is damage rather than fresh setup. Never heal it under the old
      // generation: a persisted cursor could otherwise open an empty store.
      assertRequiredSharedContinuationEntriesPrepared(input.sourceHomePath);
    }
    metadata = ensureSharedContinuationGenerationMetadata(input.sourceHomePath);
  } else {
    metadata = requireSharedContinuationGenerationMetadata(
      input.sourceHomePath,
      input.sourceRequirements,
    );
  }

  assertSharedCodexContinuationGenerationPrepared(input.sourceHomePath, metadata.generation);
  mkdirSync(input.overlayHomePath, { recursive: true });
  for (const entryName of sharedContinuationIdentityEntryNames().toSorted()) {
    const entry = {
      entryName,
      kind: sharedContinuationEntryKind(entryName),
      sourceHomePath: input.sourceHomePath,
      overlayHomePath: input.overlayHomePath,
    } as const;
    const sourceStat = lstatIfExists(path.join(input.sourceHomePath, entryName));
    if (!sourceStat) {
      throw new Error(
        `Codex shared continuation source at ${input.sourceHomePath} became incomplete while preparing '${entryName}'; refusing to recreate persisted session state.`,
      );
    }
    assertSharedContinuationEntryType({
      entryName,
      entryPath: path.join(input.sourceHomePath, entryName),
      kind: entry.kind,
      stat: sourceStat,
    });
    ensureSharedContinuationTarget(entry, input.overlayEntryLinker);
  }
  assertSharedCodexContinuationGenerationPrepared(input.sourceHomePath, metadata.generation);
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
  return metadata;
}

function readRegularSharedContinuationFile(filePath: string, label: string): string | undefined {
  const stat = lstatIfExists(filePath);
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Codex shared continuation ${label} at ${filePath} is not a regular file.`);
  }
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

function readLegacySharedContinuationMarker(sourceHomePath: string): boolean {
  const markerPath = legacySharedContinuationMarkerPath(sourceHomePath);
  const content = readRegularSharedContinuationFile(markerPath, "legacy marker");
  if (content === undefined) return false;
  try {
    const marker = JSON.parse(content) as {
      readonly version?: unknown;
      readonly sourceHomeIdentity?: unknown;
    };
    if (
      marker.version === 1 &&
      marker.sourceHomeIdentity === resolveCodexPathIdentity(sourceHomePath)
    ) {
      return true;
    }
  } catch {
    // Report the same fail-closed error for malformed and mismatched markers.
  }
  throw new Error(
    `Codex shared continuation legacy marker at ${markerPath} is malformed or belongs to another source home.`,
  );
}

function readSharedContinuationV2Marker(
  sourceHomePath: string,
): SharedContinuationGenerationMetadata | undefined {
  const markerPath = sharedContinuationMarkerPath(sourceHomePath);
  const content = readRegularSharedContinuationFile(markerPath, "v2 marker");
  if (content === undefined) return undefined;
  try {
    const marker = JSON.parse(content) as {
      readonly version?: unknown;
      readonly sourceHomeIdentity?: unknown;
      readonly generation?: unknown;
      readonly migratedFromVersion?: unknown;
    };
    if (
      marker.version === SYNARA_SHARED_CONTINUATION_MARKER_VERSION &&
      marker.sourceHomeIdentity === resolveCodexPathIdentity(sourceHomePath) &&
      typeof marker.generation === "string" &&
      SHARED_CONTINUATION_GENERATION_PATTERN.test(marker.generation) &&
      (marker.migratedFromVersion === undefined || marker.migratedFromVersion === 1)
    ) {
      return {
        generation: marker.generation.toLowerCase(),
        ...(marker.migratedFromVersion === 1 ? { migratedFromVersion: 1 as const } : {}),
      };
    }
  } catch {
    // Report the same fail-closed error for malformed and mismatched markers.
  }
  throw new Error(
    `Codex shared continuation v2 marker at ${markerPath} is malformed or belongs to another source home.`,
  );
}

function readSharedContinuationGenerationState(
  sourceHomePath: string,
): SharedContinuationGenerationState {
  const marker = readSharedContinuationV2Marker(sourceHomePath);
  if (marker) return { kind: "v2", ...marker };
  if (readLegacySharedContinuationMarker(sourceHomePath)) return { kind: "legacy" };
  // A concurrent migration writes v2 before retiring v1. Re-read v2 so a
  // validator that landed between those operations converges on the winner
  // instead of briefly misclassifying the source as unprepared.
  const migratedMarker = readSharedContinuationV2Marker(sourceHomePath);
  return migratedMarker ? { kind: "v2", ...migratedMarker } : { kind: "absent" };
}

function sharedContinuationMarkerContent(
  sourceHomePath: string,
  metadata: SharedContinuationGenerationMetadata,
): string {
  return `${JSON.stringify({
    version: SYNARA_SHARED_CONTINUATION_MARKER_VERSION,
    sourceHomeIdentity: resolveCodexPathIdentity(sourceHomePath),
    generation: metadata.generation,
    ...(metadata.migratedFromVersion === 1 ? { migratedFromVersion: 1 } : {}),
  })}\n`;
}

function writeSharedContinuationV2Marker(
  sourceHomePath: string,
  metadata: SharedContinuationGenerationMetadata,
): boolean {
  const markerPath = sharedContinuationMarkerPath(sourceHomePath);
  const temporaryPath = path.join(
    sourceHomePath,
    `.synara-shared-continuation-v2.${process.pid}.${randomUUID()}.tmp`,
  );
  const content = sharedContinuationMarkerContent(sourceHomePath, metadata);
  try {
    // Publish a fully written marker with an atomic no-clobber hard-link CAS.
    // Unlike opening the final path with `wx`, readers can never observe the
    // winner between file creation and its JSON write.
    writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      linkSync(temporaryPath, markerPath);
      return true;
    } catch (error) {
      if (errorCode(error) === "EEXIST") return false;
      throw error;
    }
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function ensureSharedContinuationGenerationMetadata(
  sourceHomePath: string,
): SharedContinuationGenerationMetadata {
  const existing = readSharedContinuationGenerationState(sourceHomePath);
  if (existing.kind === "v2") return existing;
  if (existing.kind === "legacy") {
    assertRequiredSharedContinuationEntriesPrepared(sourceHomePath);
  }

  const candidate: SharedContinuationGenerationMetadata = {
    generation: randomUUID().toLowerCase(),
    ...(existing.kind === "legacy" ? { migratedFromVersion: 1 as const } : {}),
  };
  if (!writeSharedContinuationV2Marker(sourceHomePath, candidate)) {
    const raced = readSharedContinuationGenerationState(sourceHomePath);
    if (raced.kind !== "v2") {
      throw new Error(
        `Codex shared continuation generation at ${sourceHomePath} did not converge after a concurrent writer.`,
      );
    }
    if (existing.kind === "legacy" && raced.migratedFromVersion !== 1) {
      throw new Error(
        `Codex shared continuation generation at ${sourceHomePath} raced with a non-migration marker.`,
      );
    }
    return raced;
  }
  const committed = readSharedContinuationGenerationState(sourceHomePath);
  if (committed.kind !== "v2") {
    throw new Error(
      `Codex shared continuation generation at ${sourceHomePath} was not committed safely.`,
    );
  }
  if (committed.migratedFromVersion === 1) {
    // The v2 marker carries the durable migration provenance. Retiring v1
    // prevents a later selective v2-marker deletion from being mistaken for
    // another trustworthy legacy migration.
    rmSync(legacySharedContinuationMarkerPath(sourceHomePath), { force: true });
  }
  return committed;
}

function sharedContinuationIdentityEntryNames(): readonly string[] {
  return [...REQUIRED_SHARED_CONTINUATION_DIRECTORIES, ...REQUIRED_SHARED_CONTINUATION_FILES];
}

function assertRequiredSharedContinuationEntriesPrepared(sourceHomePath: string): void {
  for (const entryName of sharedContinuationIdentityEntryNames()) {
    const entryPath = path.join(sourceHomePath, entryName);
    const stat = lstatIfExists(entryPath);
    if (!stat) {
      throw new Error(
        `Codex shared continuation source at ${sourceHomePath} is missing '${entryName}'; refusing to recreate persisted session state.`,
      );
    }
    assertSharedContinuationEntryType({
      entryName,
      entryPath,
      kind: sharedContinuationEntryKind(entryName),
      stat,
    });
  }
}

function requireSharedContinuationGenerationMetadata(
  sourceHomePath: string,
  requirements: SharedContinuationSourceRequirements = {},
): SharedContinuationGenerationMetadata {
  const expectedGeneration = requirements.expectedGeneration?.toLowerCase();
  if (
    expectedGeneration !== undefined &&
    !SHARED_CONTINUATION_GENERATION_PATTERN.test(expectedGeneration)
  ) {
    throw new Error(`Invalid expected Codex shared continuation generation.`);
  }

  let state = readSharedContinuationGenerationState(sourceHomePath);
  if (state.kind === "legacy") {
    if (!requirements.allowLegacyMigration) {
      throw new Error(
        `Codex shared continuation source at ${sourceHomePath} still uses a legacy marker and cannot satisfy a generation-pinned launch.`,
      );
    }
    assertRequiredSharedContinuationEntriesPrepared(sourceHomePath);
    state = { kind: "v2", ...ensureSharedContinuationGenerationMetadata(sourceHomePath) };
  }
  if (state.kind !== "v2") {
    throw new Error(
      `Codex shared continuation source at ${sourceHomePath} is missing or damaged; refusing to recreate persisted session state. Restore the original source home before resuming this thread.`,
    );
  }
  if (expectedGeneration !== undefined && state.generation !== expectedGeneration) {
    throw new Error(
      `Codex shared continuation source at ${sourceHomePath} has generation '${state.generation}', expected '${expectedGeneration}'; refusing to launch a persisted cursor against replacement state.`,
    );
  }
  if (
    requirements.allowLegacyMigration &&
    expectedGeneration === undefined &&
    state.migratedFromVersion !== 1
  ) {
    throw new Error(
      `Codex shared continuation source at ${sourceHomePath} is a new generation, not a verified migration of the persisted legacy identity.`,
    );
  }
  assertRequiredSharedContinuationEntriesPrepared(sourceHomePath);
  return state;
}

function assertSharedCodexContinuationGenerationPrepared(
  sourceHomePath: string,
  expectedGeneration: string,
): void {
  const state = readSharedContinuationGenerationState(sourceHomePath);
  if (state.kind !== "v2" || state.generation !== expectedGeneration.toLowerCase()) {
    throw new Error(
      `Codex shared continuation source at ${sourceHomePath} changed generations during preparation; refusing to launch persisted session state.`,
    );
  }
  assertRequiredSharedContinuationEntriesPrepared(sourceHomePath);
}

function readPreparedSharedCodexContinuationGeneration(sourceHomePath: string): string | undefined {
  try {
    const state = readSharedContinuationGenerationState(sourceHomePath);
    if (state.kind !== "v2") return undefined;
    assertRequiredSharedContinuationEntriesPrepared(sourceHomePath);
    return state.generation;
  } catch {
    return undefined;
  }
}

function selectedCodexOverlaySharesContinuationState(input: {
  readonly sourceHomePath: string;
  readonly overlayHomePath: string;
}): boolean {
  if (codexPathsReferenceSameLocation(input.sourceHomePath, input.overlayHomePath)) {
    return true;
  }
  return sharedContinuationIdentityEntryNames().every((entryName) => {
    const sourcePath = path.join(input.sourceHomePath, entryName);
    const targetPath = path.join(input.overlayHomePath, entryName);
    const kind = sharedContinuationEntryKind(entryName);
    const sourceStat = lstatIfExists(sourcePath);
    const targetStat = lstatIfExists(targetPath);
    if (!sourceStat || !targetStat?.isSymbolicLink()) {
      return false;
    }
    const sourceMatchesExpectedType =
      kind === "dir" ? sourceStat.isDirectory() : sourceStat.isFile();
    return (
      sourceMatchesExpectedType &&
      codexPathsReferenceSameLocation(resolvedSymlinkTarget(targetPath), sourcePath)
    );
  });
}

export function readCodexSharedContinuationGeneration(
  input: Pick<CodexProcessEnvInput, "env" | "homePath" | "shadowHomePath" | "accountId"> = {},
): string | undefined {
  const env = { ...(input.env ?? process.env) };
  const resolution = resolveCodexOverlayResolution({
    env,
    ...(input.homePath ? { homePath: input.homePath } : {}),
    ...(input.shadowHomePath ? { shadowHomePath: input.shadowHomePath } : {}),
    ...(input.accountId ? { accountId: input.accountId } : {}),
  });
  const { sourceHomePath, overlayHomePath } = resolution;
  try {
    const sourceConfigPath = path.join(sourceHomePath, "config.toml");
    const sourceConfig = existsSync(sourceConfigPath) ? readFileSync(sourceConfigPath, "utf8") : "";
    assertCodexSqliteHomeMatchesSource({ sourceConfig, sourceHomePath });
    const generation = readPreparedSharedCodexContinuationGeneration(sourceHomePath);
    return generation !== undefined &&
      selectedCodexOverlaySharesContinuationState({ sourceHomePath, overlayHomePath })
      ? generation
      : undefined;
  } catch {
    return undefined;
  }
}

export function isCodexSharedContinuationStatePrepared(
  input: Pick<CodexProcessEnvInput, "env" | "homePath" | "shadowHomePath" | "accountId"> = {},
): boolean {
  return readCodexSharedContinuationGeneration(input) !== undefined;
}

function uniqueResolvedPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of paths) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    result.push(candidate);
  }
  return result;
}

function resolveCodexAuthoritativeAuthHomePath(resolution: CodexOverlayResolution): string {
  return (
    resolution.shadowHomePath ??
    (resolution.accountSegment && !resolution.hasDedicatedAccountHome
      ? resolution.overlayHomePath
      : resolution.sourceHomePath)
  );
}

function resolveCodexAuthTrackingFromResolution(
  resolution: CodexOverlayResolution,
  accountId?: string,
  preparedSourceConfig?: string,
): CodexAuthTracking {
  const sourceConfigPath = path.join(resolution.sourceHomePath, "config.toml");
  const sourceConfig =
    preparedSourceConfig ??
    (existsSync(sourceConfigPath) ? readFileSync(sourceConfigPath, "utf8") : "");
  assertManagedCodexHomeUsesObservableAuth({
    sourceConfig,
    ...(accountId ? { accountId } : {}),
  });

  const authoritativeAuthHomePath = resolveCodexAuthoritativeAuthHomePath(resolution);
  const authoritativeAuthFilePath = path.join(authoritativeAuthHomePath, "auth.json");
  const [, effectiveAuthFilePath] = uniqueResolvedPaths([
    authoritativeAuthFilePath,
    path.join(resolution.overlayHomePath, "auth.json"),
  ]);
  return {
    sourceConfigPath,
    authoritativeAuthFilePath,
    ...(effectiveAuthFilePath ? { effectiveAuthFilePath } : {}),
  };
}

export function resolveCodexAuthTracking(
  input: Pick<CodexProcessEnvInput, "env" | "homePath" | "shadowHomePath" | "accountId"> = {},
): CodexAuthTracking {
  const env = { ...(input.env ?? process.env) };
  const resolution = resolveCodexOverlayResolution({
    env,
    ...(input.homePath ? { homePath: input.homePath } : {}),
    ...(input.shadowHomePath ? { shadowHomePath: input.shadowHomePath } : {}),
    ...(input.accountId ? { accountId: input.accountId } : {}),
  });
  return resolveCodexAuthTrackingFromResolution(resolution, input.accountId);
}

function readFileFingerprint(filePath: string): string {
  try {
    return `sha256:${createHash("sha256").update(readFileSync(filePath)).digest("hex")}`;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    return code === "ENOENT" ? "missing" : "unreadable";
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function secretSafeHash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function readJwtClaims(value: unknown): Record<string, unknown> | undefined {
  const token = nonEmptyString(value);
  const payload = token?.split(".")[1];
  if (!payload) {
    return undefined;
  }
  try {
    return asRecord(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    return undefined;
  }
}

function firstString(records: readonly (Record<string, unknown> | undefined)[], keys: string[]) {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = nonEmptyString(record[key]);
      if (value) return value;
    }
  }
  return undefined;
}

type CodexAuthFileIdentity =
  | { readonly state: "missing" | "unreadable" }
  | {
      readonly state: "present";
      readonly authMode: "api-key" | "chatgpt" | "unknown";
      readonly identity: string;
      readonly fallback?: true;
    };

function readCodexAuthFileIdentity(authFilePath: string): CodexAuthFileIdentity {
  let content: Buffer;
  try {
    content = readFileSync(authFilePath);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    return { state: code === "ENOENT" ? "missing" : "unreadable" };
  }

  const contentIdentity = secretSafeHash(content.toString("base64"));
  try {
    const auth = asRecord(JSON.parse(content.toString("utf8")));
    if (!auth) {
      return { state: "present", authMode: "unknown", identity: contentIdentity, fallback: true };
    }
    const tokens = asRecord(auth.tokens);
    const idTokenClaims = readJwtClaims(tokens?.id_token ?? tokens?.idToken);
    const rawMode = nonEmptyString(auth.auth_mode ?? auth.authMode)?.toLowerCase();
    const apiKey = nonEmptyString(auth.OPENAI_API_KEY ?? auth.openai_api_key ?? auth.apiKey);
    if (rawMode === "apikey" || rawMode === "api-key" || (apiKey && !tokens)) {
      return {
        state: "present",
        authMode: "api-key",
        identity: secretSafeHash(apiKey ?? content.toString("base64")),
        ...(apiKey ? {} : { fallback: true as const }),
      };
    }

    if (tokens || rawMode === "chatgpt" || rawMode === "chatgptauthtokens") {
      const workspaceId = firstString(
        [tokens, idTokenClaims, auth],
        [
          "account_id",
          "accountId",
          "chatgpt_account_id",
          "chatgptAccountId",
          "https://api.openai.com/auth/chatgpt_account_id",
        ],
      );
      const userId = firstString(
        [idTokenClaims, tokens, auth],
        [
          "chatgpt_user_id",
          "chatgptUserId",
          "user_id",
          "userId",
          "https://api.openai.com/auth/user_id",
          "sub",
        ],
      );
      if (workspaceId || userId) {
        return {
          state: "present",
          authMode: "chatgpt",
          identity: secretSafeHash(
            JSON.stringify({ workspaceId: workspaceId ?? null, userId: userId ?? null }),
          ),
        };
      }
      // Older/foreign auth payloads without a stable account claim fail
      // conservatively: any byte change invalidates the owning runtime.
      return { state: "present", authMode: "chatgpt", identity: contentIdentity, fallback: true };
    }
  } catch {
    // Malformed auth must still have a deterministic, secret-safe identity so
    // repairing or replacing it invalidates stale runtimes.
  }
  return { state: "present", authMode: "unknown", identity: contentIdentity, fallback: true };
}

export function readCodexAuthFileIdentityFingerprint(input: {
  readonly authFilePath: string;
  readonly configPath?: string;
}): string {
  let sourceConfig = "";
  if (input.configPath) {
    try {
      sourceConfig = readFileSync(input.configPath, "utf8");
    } catch {
      // Missing config uses Codex's file-backed default.
    }
  }
  return JSON.stringify({
    storeMode: readEffectiveCodexAuthCredentialsStoreMode(sourceConfig),
    auth: readCodexAuthFileIdentity(input.authFilePath),
  });
}

export function readCodexAuthTrackingFingerprint(tracking: CodexAuthTracking): string {
  let sourceConfig = "";
  try {
    sourceConfig = readFileSync(tracking.sourceConfigPath, "utf8");
  } catch {
    // Missing config uses Codex's file-backed default.
  }
  const storeMode = readEffectiveCodexAuthCredentialsStoreMode(sourceConfig);
  const authoritative = readCodexAuthFileIdentity(tracking.authoritativeAuthFilePath);
  const effective = tracking.effectiveAuthFilePath
    ? readCodexAuthFileIdentity(tracking.effectiveAuthFilePath)
    : undefined;
  // Before first launch the effective overlay may not exist yet. Once it is
  // linked/copied it normally has the same bytes as the authoritative source;
  // omit that redundant state. The authoritative role is never suppressed:
  // deleting/logging out of the source must invalidate a stale copied overlay.
  const normalizedEffective =
    effective === undefined ||
    JSON.stringify(effective) === JSON.stringify(authoritative) ||
    (authoritative.state === "present" && effective.state === "missing")
      ? undefined
      : effective;
  return JSON.stringify({
    storeMode,
    authoritative,
    ...(normalizedEffective !== undefined ? { effective: normalizedEffective } : {}),
  });
}

function writeSynaraConfigSuppressions(
  markerPath: string,
  sectionHeaders: readonly string[],
): void {
  const normalized = [...new Set(sectionHeaders.filter(isSafePluginSectionHeader))].slice(
    0,
    MAX_CONFIG_SUPPRESSION_SECTIONS,
  );
  const temporaryPath = `${markerPath}.${process.pid}.tmp`;
  writeFileSync(
    temporaryPath,
    `${JSON.stringify({ version: 1, sectionHeaders: normalized }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  renameSync(temporaryPath, markerPath);
}

export function linkOrCopyCodexOverlayEntry(
  input: {
    readonly entryName: string;
    readonly sourcePath: string;
    readonly targetPath: string;
    readonly type: "dir" | "file";
  },
  linker: CodexOverlayEntryLinker = {
    symlink: symlinkSync,
    copyFile: copyFileSync,
  },
): "symlink" | "copy" {
  try {
    linker.symlink(input.sourcePath, input.targetPath, input.type);
    return "symlink";
  } catch (error: unknown) {
    if (input.type === "file" && CODEX_OVERLAY_SHARED_STATE_FILES.has(input.entryName)) {
      linker.copyFile(input.sourcePath, input.targetPath);
      return "copy";
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

function authCopyMarkerPath(targetPath: string): string {
  return path.join(path.dirname(targetPath), SYNARA_AUTH_COPY_MARKER_FILE);
}

function writeAuthCopyMarker(sourcePath: string, targetPath: string): void {
  const markerPath = authCopyMarkerPath(targetPath);
  const temporaryPath = `${markerPath}.${process.pid}.tmp`;
  writeFileSync(
    temporaryPath,
    `${JSON.stringify({
      version: 1,
      sourcePath: path.resolve(sourcePath),
      copyFingerprint: readFileFingerprint(targetPath),
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  renameSync(temporaryPath, markerPath);
}

function readAuthCopyMarker(targetPath: string):
  | {
      readonly sourcePath: string;
      readonly copyFingerprint: string;
    }
  | undefined {
  try {
    const parsed = JSON.parse(readFileSync(authCopyMarkerPath(targetPath), "utf8")) as {
      version?: unknown;
      sourcePath?: unknown;
      copyFingerprint?: unknown;
    };
    return parsed.version === 1 &&
      typeof parsed.sourcePath === "string" &&
      typeof parsed.copyFingerprint === "string"
      ? { sourcePath: parsed.sourcePath, copyFingerprint: parsed.copyFingerprint }
      : undefined;
  } catch {
    return undefined;
  }
}

function ensureCodexOverlaySymlink(
  input: {
    readonly entryName: string;
    readonly sourcePath: string;
    readonly targetPath: string;
    readonly type: "dir" | "file";
    readonly force?: boolean;
  },
  linker?: CodexOverlayEntryLinker,
): void {
  let targetStat: ReturnType<typeof lstatSync> | undefined;
  try {
    targetStat = lstatSync(input.targetPath);
  } catch {
    targetStat = undefined;
  }

  if (targetStat) {
    if (targetStat.isSymbolicLink() && readlinkSync(input.targetPath) === input.sourcePath) {
      if (input.entryName === "auth.json") {
        rmSync(authCopyMarkerPath(input.targetPath), { force: true });
      }
      return;
    }

    if (
      input.force ||
      targetStat.isSymbolicLink() ||
      /^.+\.sqlite(?:-(?:wal|shm|journal))?$/.test(input.entryName) ||
      CODEX_OVERLAY_SHARED_STATE_FILES.has(input.entryName)
    ) {
      // SQLite files must stay generation-matched, and auth must mirror the
      // user's real Codex home so external `codex login` changes are visible.
      rmSync(input.targetPath, { recursive: true, force: true });
    } else {
      return;
    }
  }

  const result = linkOrCopyCodexOverlayEntry(input, linker);
  if (input.entryName === "auth.json") {
    if (result === "copy") {
      try {
        writeAuthCopyMarker(input.sourcePath, input.targetPath);
      } catch (error) {
        // An unmarked copy cannot be distinguished safely from independent
        // overlay auth during logout, so never leave it behind.
        rmSync(input.targetPath, { force: true });
        throw error;
      }
    } else {
      rmSync(authCopyMarkerPath(input.targetPath), { force: true });
    }
  }
}

function removeStaleMirroredAuthWhenSourceIsMissing(resolution: CodexOverlayResolution): void {
  // Shared-home account overlays own their auth file. It is not a mirror and
  // must survive even while the shared/default source account is logged out.
  if (
    resolution.accountSegment &&
    !resolution.shadowHomePath &&
    !resolution.hasDedicatedAccountHome
  ) {
    return;
  }

  const authoritativeHomePath = resolution.shadowHomePath ?? resolution.sourceHomePath;
  const sourceAuthPath = path.join(authoritativeHomePath, "auth.json");
  const targetAuthPath = path.join(resolution.overlayHomePath, "auth.json");
  if (codexPathsReferenceSameLocation(sourceAuthPath, targetAuthPath)) {
    return;
  }
  const sourceFingerprint = readFileFingerprint(sourceAuthPath);
  if (sourceFingerprint !== "missing") {
    return;
  }
  // Only a missing authoritative source allows stale mirror cleanup. An
  // unreadable source is preserved so a transient permission failure cannot
  // destroy the effective login.

  const markerPath = authCopyMarkerPath(targetAuthPath);
  let targetStat: ReturnType<typeof lstatSync> | undefined;
  try {
    targetStat = lstatSync(targetAuthPath);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    if (code === "ENOENT") {
      rmSync(markerPath, { force: true });
    }
    return;
  }

  if (targetStat.isSymbolicLink()) {
    const linkTarget = readlinkSync(targetAuthPath);
    const resolvedLinkTarget = path.isAbsolute(linkTarget)
      ? path.resolve(linkTarget)
      : path.resolve(path.dirname(targetAuthPath), linkTarget);
    if (codexPathsReferenceSameLocation(resolvedLinkTarget, sourceAuthPath)) {
      rmSync(targetAuthPath, { force: true });
    }
    rmSync(markerPath, { force: true });
    return;
  }

  const marker = readAuthCopyMarker(targetAuthPath);
  if (
    marker &&
    codexPathsReferenceSameLocation(marker.sourcePath, sourceAuthPath) &&
    marker.copyFingerprint === readFileFingerprint(targetAuthPath)
  ) {
    rmSync(targetAuthPath, { recursive: true, force: true });
  }
  // A changed target is now independent state; preserve it but drop obsolete
  // copy provenance so a later logout never mistakes it for the old mirror.
  rmSync(markerPath, { force: true });
}

// A symlinked private home (or one resolving to the source home) aliases
// another account's credentials through the directory itself.
function validateCodexPrivateHomePath(
  sourceHomePath: string,
  privateHomePath: string,
  label: "shadow home" | "overlay home",
): void {
  if (codexPathsReferenceSameLocation(sourceHomePath, privateHomePath)) {
    throw new Error(`Codex account ${label} must be different from CODEX_HOME.`);
  }
  let privateHomeStat: ReturnType<typeof lstatSync> | undefined;
  try {
    privateHomeStat = lstatSync(privateHomePath);
  } catch {
    privateHomeStat = undefined;
  }
  if (privateHomeStat?.isSymbolicLink()) {
    throw new Error(
      `Codex account ${label} at ${privateHomePath} is a symlink; it must be a real directory so accounts cannot alias each other's auth.`,
    );
  }
}

function validateCodexShadowHomePath(sourceHomePath: string, shadowHomePath: string): void {
  validateCodexPrivateHomePath(sourceHomePath, shadowHomePath, "shadow home");
}

// A symlinked auth.json can silently alias another account's credentials, so
// account-private state must always be a real file in the shadow home.
// Returns the entry's lstat, or undefined when it does not exist yet.
function lstatShadowPrivateState(
  shadowHomePath: string,
  entry: string,
): ReturnType<typeof lstatSync> | undefined {
  const sourcePath = path.join(shadowHomePath, entry);
  let sourceStat: ReturnType<typeof lstatSync>;
  try {
    sourceStat = lstatSync(sourcePath);
  } catch {
    // Missing shadow state should not prevent Codex from creating account
    // state lazily, but existing private files must never be read or logged.
    return undefined;
  }
  if (sourceStat.isSymbolicLink()) {
    throw new Error(
      `Codex account private state at ${sourcePath} is a symlink; it must be a real file so accounts cannot alias each other's auth.`,
    );
  }
  return sourceStat;
}

function filesystemErrorCode(cause: unknown): string | undefined {
  return typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { readonly code?: unknown }).code ?? "")
    : undefined;
}

function bindCodexPreparedHomeSource(
  homePath: string,
  options: {
    readonly label: string;
    readonly requireRealDirectory: boolean;
  },
): CodexPreparedHomeSource {
  let initialLogicalStat: BigIntStats;
  try {
    initialLogicalStat = lstatSync(homePath, { bigint: true });
  } catch (cause) {
    if (filesystemErrorCode(cause) === "ENOENT") return { kind: "missing" };
    throw cause;
  }

  if (options.requireRealDirectory && initialLogicalStat.isSymbolicLink()) {
    throw new Error(
      `${options.label} at ${homePath} is a symlink; it must remain bound to one account directory.`,
    );
  }
  if (!initialLogicalStat.isDirectory() && !initialLogicalStat.isSymbolicLink()) {
    throw new Error(`${options.label} at ${homePath} is not a directory.`);
  }

  try {
    const canonicalHomePath = realpathSync(homePath);
    const canonicalStat = lstatSync(canonicalHomePath, { bigint: true });
    const finalLogicalStat = lstatSync(homePath, { bigint: true });
    const finalTargetStat = statSync(homePath, { bigint: true });
    const logicalEntryIsStable =
      initialLogicalStat.dev === finalLogicalStat.dev &&
      initialLogicalStat.ino === finalLogicalStat.ino &&
      initialLogicalStat.mode === finalLogicalStat.mode;
    const canonicalDirectoryIsStable =
      canonicalStat.isDirectory() &&
      !canonicalStat.isSymbolicLink() &&
      canonicalStat.dev === finalTargetStat.dev &&
      canonicalStat.ino === finalTargetStat.ino;
    if (!logicalEntryIsStable || !canonicalDirectoryIsStable) {
      throw new Error(
        `${options.label} at ${homePath} changed while its identity was being bound; retry the request.`,
      );
    }
    return {
      kind: "bound",
      canonicalHomePath,
      device: canonicalStat.dev,
      inode: canonicalStat.ino,
    };
  } catch (cause) {
    if (cause instanceof Error && /changed while its identity/.test(cause.message)) throw cause;
    throw new Error(`${options.label} at ${homePath} could not be bound safely.`, { cause });
  }
}

function preparedHomeFileIdentityMatches(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function assertPreparedHomeIdentity(
  source: Extract<CodexPreparedHomeSource, { kind: "bound" }>,
  fileName: string,
): void {
  try {
    const current = lstatSync(source.canonicalHomePath, { bigint: true });
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== source.device ||
      current.ino !== source.inode
    ) {
      throw new CodexPreparedHomeFileSnapshotError(
        "home-changed",
        fileName,
        "The selected Codex home changed after its identity was bound; retry the request.",
      );
    }
  } catch (cause) {
    if (cause instanceof CodexPreparedHomeFileSnapshotError) throw cause;
    throw new CodexPreparedHomeFileSnapshotError(
      "home-unavailable",
      fileName,
      "The selected Codex home can no longer be verified safely; retry the request.",
      { cause },
    );
  }
}

function assertLogicalHomeMatchesPreparedSource(input: {
  readonly logicalHomePath: string;
  readonly source: CodexPreparedHomeSource;
  readonly label: string;
}): void {
  if (input.source.kind === "missing") {
    try {
      lstatSync(input.logicalHomePath, { bigint: true });
    } catch (cause) {
      if (filesystemErrorCode(cause) === "ENOENT") return;
      throw new Error(
        `${input.label} at ${input.logicalHomePath} could not be revalidated safely.`,
        {
          cause,
        },
      );
    }
    throw new Error(
      `${input.label} at ${input.logicalHomePath} appeared while account identities were being prepared; retry the request.`,
    );
  }

  assertPreparedHomeIdentity(input.source, path.basename(input.logicalHomePath));
  let logicalTarget: BigIntStats;
  try {
    logicalTarget = statSync(input.logicalHomePath, { bigint: true });
  } catch (cause) {
    throw new Error(`${input.label} at ${input.logicalHomePath} could not be revalidated safely.`, {
      cause,
    });
  }
  if (
    !logicalTarget.isDirectory() ||
    logicalTarget.dev !== input.source.device ||
    logicalTarget.ino !== input.source.inode
  ) {
    throw new Error(
      `${input.label} at ${input.logicalHomePath} changed while account identities were being prepared; retry the request.`,
    );
  }
}

function assertPreparedAuthAndSourceBindingsCurrent(input: {
  readonly sourceHomePath: string;
  readonly sourceHomeSource: CodexPreparedHomeSource;
  readonly authoritativeAuthHomePath: string;
  readonly authSource: CodexPreparedAuthSource;
}): void {
  assertLogicalHomeMatchesPreparedSource({
    logicalHomePath: input.sourceHomePath,
    source: input.sourceHomeSource,
    label: "Codex source home",
  });
  assertLogicalHomeMatchesPreparedSource({
    logicalHomePath: input.authoritativeAuthHomePath,
    source: input.authSource,
    label: "Codex account auth home",
  });
}

function preparedHomesShareIdentity(
  left: CodexPreparedHomeSource,
  right: CodexPreparedHomeSource,
): boolean {
  return (
    left.kind === "bound" &&
    right.kind === "bound" &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

/**
 * Reads one regular file from an already-bound Codex home without following a
 * mutable logical home path. Directory and file identities are checked before
 * and after the descriptor read so symlink, FIFO, and type-swap races fail
 * closed instead of mixing config or credentials from different accounts.
 */
export function readCodexPreparedHomeFileSnapshot(
  source: CodexPreparedHomeSource,
  fileName: string,
): Buffer | undefined {
  if (source.kind === "missing") return undefined;
  if (path.basename(fileName) !== fileName || fileName === "." || fileName === "..") {
    throw new CodexPreparedHomeFileSnapshotError(
      "file-check-failed",
      fileName,
      "A prepared Codex home snapshot must name one direct child file.",
    );
  }

  assertPreparedHomeIdentity(source, fileName);
  const filePath = path.join(source.canonicalHomePath, fileName);
  let initial: BigIntStats;
  try {
    initial = lstatSync(filePath, { bigint: true });
  } catch (cause) {
    assertPreparedHomeIdentity(source, fileName);
    if (filesystemErrorCode(cause) === "ENOENT") return undefined;
    throw new CodexPreparedHomeFileSnapshotError(
      "file-check-failed",
      fileName,
      `Codex ${fileName} could not be checked safely.`,
      { cause },
    );
  }
  if (initial.isSymbolicLink()) {
    throw new CodexPreparedHomeFileSnapshotError(
      "symbolic-link",
      fileName,
      `Codex ${fileName} must not be a symbolic link.`,
    );
  }
  if (!initial.isFile()) {
    throw new CodexPreparedHomeFileSnapshotError(
      "not-regular-file",
      fileName,
      `Codex ${fileName} must be a regular file.`,
    );
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || !preparedHomeFileIdentityMatches(initial, before)) {
      throw new CodexPreparedHomeFileSnapshotError(
        "file-changed",
        fileName,
        `Codex ${fileName} changed while its identity was being verified; retry the request.`,
      );
    }
    const content = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      !preparedHomeFileIdentityMatches(before, after) ||
      BigInt(content.byteLength) !== after.size
    ) {
      throw new CodexPreparedHomeFileSnapshotError(
        "file-changed",
        fileName,
        `Codex ${fileName} changed while its snapshot was being read; retry the request.`,
      );
    }
    assertPreparedHomeIdentity(source, fileName);
    return content;
  } catch (cause) {
    if (cause instanceof CodexPreparedHomeFileSnapshotError) throw cause;
    throw new CodexPreparedHomeFileSnapshotError(
      "file-read-failed",
      fileName,
      `Codex ${fileName} could not be snapshotted safely.`,
      { cause },
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function prepareSynaraCodexHomeOverlay(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homePath?: string;
  readonly shadowHomePath?: string;
  readonly accountId?: string;
  readonly overlayEntryLinker?: CodexOverlayEntryLinker;
  readonly continuationSourcePolicy?: SharedContinuationSourcePolicy;
  readonly continuationSourceRequirements?: SharedContinuationSourceRequirements;
}): string | undefined {
  const resolution = resolveCodexOverlayResolution(input);
  const {
    sourceHomePath,
    hasDedicatedAccountHome,
    shadowHomePath,
    accountSegment,
    overlayHomePath,
  } = resolution;
  if (shadowHomePath) {
    validateCodexShadowHomePath(sourceHomePath, shadowHomePath);
  }
  const sourceConfigPath = path.join(sourceHomePath, "config.toml");
  const sourceConfig = existsSync(sourceConfigPath) ? readFileSync(sourceConfigPath, "utf8") : "";
  assertCodexSqliteHomeMatchesSource({ sourceConfig, sourceHomePath });
  // Keyring-backed auth cannot be fingerprinted portably, so a long-lived
  // app-server could keep serving a previous account after an external login.
  // Reject it before creating or repairing any managed home.
  assertManagedCodexHomeUsesObservableAuth({
    sourceConfig,
    ...(input.accountId ? { accountId: input.accountId } : {}),
  });
  if (path.resolve(sourceHomePath) === path.resolve(overlayHomePath)) {
    if (input.continuationSourcePolicy === "require-prepared") {
      requireSharedContinuationGenerationMetadata(
        sourceHomePath,
        input.continuationSourceRequirements,
      );
    }
    return undefined;
  }

  let continuationMetadata: SharedContinuationGenerationMetadata;
  try {
    continuationMetadata = prepareSharedCodexContinuationState({
      sourceHomePath,
      overlayHomePath,
      ...(input.overlayEntryLinker ? { overlayEntryLinker: input.overlayEntryLinker } : {}),
      ...(input.continuationSourcePolicy ? { sourcePolicy: input.continuationSourcePolicy } : {}),
      ...(input.continuationSourceRequirements
        ? { sourceRequirements: input.continuationSourceRequirements }
        : {}),
    });
  } catch (error) {
    // Continuation preparation is all-or-nothing on every platform and for the
    // default overlay too. Windows hosts without symlink privileges therefore
    // fail closed instead of silently creating account-local session state.
    throw error;
  }

  try {
    // Auth must get a best-effort link/copy before optional entries whose
    // symlinks may fail on restricted Windows installs.
    for (const entry of prioritizeCodexOverlayEntries(readdirSync(sourceHomePath))) {
      if (
        entry === "config.toml" ||
        entry === LEGACY_SYNARA_SHARED_CONTINUATION_MARKER_FILE ||
        entry === SYNARA_SHARED_CONTINUATION_MARKER_FILE ||
        entry.startsWith(".synara-shared-continuation-") ||
        isCodexSqliteStateEntry(entry) ||
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
      const stat = lstatSync(sourcePath);
      ensureCodexOverlaySymlink(
        {
          entryName: entry,
          sourcePath,
          targetPath,
          type: stat.isDirectory() ? "dir" : "file",
        },
        input.overlayEntryLinker,
      );
    }
  } catch {
    // If the source home is partially missing, Codex can still start with the
    // overlay config and create any required state lazily.
  }

  if (accountSegment && !shadowHomePath && !hasDedicatedAccountHome) {
    dropStaleAccountPrivateStateSymlinks(overlayHomePath);
  }

  if (shadowHomePath) {
    for (const entry of CODEX_ACCOUNT_PRIVATE_STATE_FILES) {
      const sourceStat = lstatShadowPrivateState(shadowHomePath, entry);
      if (!sourceStat) {
        continue;
      }
      const targetPath = path.join(overlayHomePath, entry);
      ensureCodexOverlaySymlink(
        {
          entryName: entry,
          sourcePath: path.join(shadowHomePath, entry),
          targetPath,
          type: sourceStat.isDirectory() ? "dir" : "file",
          force: true,
        },
        input.overlayEntryLinker,
      );
    }
  }

  removeStaleMirroredAuthWhenSourceIsMissing(resolution);

  const suppressionMarkerPath = path.join(overlayHomePath, SYNARA_CONFIG_SUPPRESSIONS_FILE);
  const suppressedSections = [
    ...new Set([
      ...findConflictingLocalBrowserPluginSections(sourceConfig),
      ...readSynaraConfigSuppressions(suppressionMarkerPath),
    ]),
  ].slice(0, MAX_CONFIG_SUPPRESSION_SECTIONS);
  writeFileSync(
    path.join(overlayHomePath, "config.toml"),
    disableCodexConfigSections(sourceConfig, suppressedSections, true),
    "utf8",
  );
  writeSynaraConfigSuppressions(suppressionMarkerPath, suppressedSections);
  assertSharedCodexContinuationGenerationPrepared(sourceHomePath, continuationMetadata.generation);
  return overlayHomePath;
}

/**
 * Materializes and validates the same managed Codex home overlay used for a
 * real process launch. Continuation compatibility checks call this before
 * trusting a newly selected account to share the source session store.
 */
type CodexHomeOverlayPreparationInput = Pick<
  CodexProcessEnvInput,
  | "env"
  | "homePath"
  | "shadowHomePath"
  | "accountId"
  | "overlayEntryLinker"
  | "expectedSharedContinuationGeneration"
  | "allowLegacySharedContinuationMigration"
>;

function prepareCodexHomeOverlayWithSourcePolicy(
  input: CodexHomeOverlayPreparationInput,
  continuationSourcePolicy: SharedContinuationSourcePolicy,
): string | undefined {
  const env = { ...(input.env ?? process.env) };
  return prepareSynaraCodexHomeOverlay({
    env,
    ...(input.homePath ? { homePath: input.homePath } : {}),
    ...(input.shadowHomePath ? { shadowHomePath: input.shadowHomePath } : {}),
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.overlayEntryLinker ? { overlayEntryLinker: input.overlayEntryLinker } : {}),
    continuationSourcePolicy,
    ...(input.expectedSharedContinuationGeneration ||
    input.allowLegacySharedContinuationMigration === true
      ? {
          continuationSourceRequirements: {
            ...(input.expectedSharedContinuationGeneration
              ? { expectedGeneration: input.expectedSharedContinuationGeneration }
              : {}),
            ...(input.allowLegacySharedContinuationMigration === true
              ? { allowLegacyMigration: true }
              : {}),
          },
        }
      : {}),
  });
}

export function prepareCodexHomeOverlay(
  input: CodexHomeOverlayPreparationInput = {},
): string | undefined {
  return prepareCodexHomeOverlayWithSourcePolicy(input, "create-if-missing");
}

/**
 * Repairs only a target overlay for a persisted shared continuation. The
 * source marker and every required source entry must already be healthy. The
 * only source write this path permits is an explicit atomic v1 -> v2 marker
 * migration; it never creates or repairs provider continuation entries.
 */
export function prepareCodexHomeOverlayFromPreparedContinuationSource(
  input: CodexHomeOverlayPreparationInput = {},
): string | undefined {
  return prepareCodexHomeOverlayWithSourcePolicy(input, "require-prepared");
}

// Earlier builds symlinked shared private state (auth) into account homes;
// drop the stale alias so the account's own login (a real file) takes its
// place instead of silently aliasing the default account's credentials.
function dropStaleAccountPrivateStateSymlinks(accountHomePath: string): void {
  for (const entry of CODEX_ACCOUNT_PRIVATE_STATE_FILES) {
    const targetPath = path.join(accountHomePath, entry);
    try {
      if (lstatSync(targetPath).isSymbolicLink()) {
        rmSync(targetPath, { force: true });
      }
    } catch {
      // Missing private state is created lazily by the account's own login.
    }
  }
}

/**
 * Resolves the authoritative account auth file without preparing Codex
 * continuation storage. Auxiliary text generation uses this path because it
 * needs account credentials and provider routing, but must not create session
 * directories, SQLite state, or continuation-generation markers.
 */
export function prepareCodexAuthTracking(
  input: Pick<CodexProcessEnvInput, "env" | "homePath" | "shadowHomePath" | "accountId"> = {},
  hooks: CodexAuthTrackingPreparationHooks = {},
): PreparedCodexAuthTracking {
  const env = { ...(input.env ?? process.env) };
  const resolution = resolveCodexOverlayResolution({
    env,
    ...(input.homePath ? { homePath: input.homePath } : {}),
    ...(input.shadowHomePath ? { shadowHomePath: input.shadowHomePath } : {}),
    ...(input.accountId ? { accountId: input.accountId } : {}),
  });
  const authoritativeAuthHomePath = resolveCodexAuthoritativeAuthHomePath(resolution);
  const requiresRealPrivateHome = Boolean(
    resolution.shadowHomePath || (resolution.accountSegment && !resolution.hasDedicatedAccountHome),
  );
  const sourceHomeAlsoOwnsAuth =
    path.resolve(authoritativeAuthHomePath) === path.resolve(resolution.sourceHomePath);

  if (resolution.shadowHomePath) {
    validateCodexShadowHomePath(resolution.sourceHomePath, resolution.shadowHomePath);
  }
  if (
    resolution.accountSegment &&
    !resolution.shadowHomePath &&
    !resolution.hasDedicatedAccountHome
  ) {
    validateCodexPrivateHomePath(
      resolution.sourceHomePath,
      resolution.overlayHomePath,
      "overlay home",
    );
  }

  // Treat source config and account auth selection as one binding transaction.
  // No file is read until both canonical home identities are captured and both
  // logical paths are proven to still resolve to those captures.
  const sourceHomeSource = bindCodexPreparedHomeSource(resolution.sourceHomePath, {
    label: "Codex source home",
    requireRealDirectory: false,
  });
  hooks.afterSourceHomeBound?.();
  const authSource = sourceHomeAlsoOwnsAuth
    ? sourceHomeSource
    : bindCodexPreparedHomeSource(authoritativeAuthHomePath, {
        label: "Codex account auth home",
        requireRealDirectory: requiresRealPrivateHome,
      });
  if (!sourceHomeAlsoOwnsAuth && preparedHomesShareIdentity(sourceHomeSource, authSource)) {
    throw new Error("Codex account auth home must be different from CODEX_HOME.");
  }
  const bindingTransaction = {
    sourceHomePath: resolution.sourceHomePath,
    sourceHomeSource,
    authoritativeAuthHomePath,
    authSource,
  };
  assertPreparedAuthAndSourceBindingsCurrent(bindingTransaction);
  if (requiresRealPrivateHome && authSource.kind === "bound") {
    lstatShadowPrivateState(authSource.canonicalHomePath, "auth.json");
  }

  const sourceConfigSnapshot =
    readCodexPreparedHomeFileSnapshot(sourceHomeSource, "config.toml")?.toString("utf8") ?? "";
  const tracking = resolveCodexAuthTrackingFromResolution(
    resolution,
    input.accountId,
    sourceConfigSnapshot,
  );
  assertPreparedAuthAndSourceBindingsCurrent(bindingTransaction);
  return {
    ...tracking,
    sourceConfigSnapshot,
    authSource,
  };
}

export function buildCodexProcessLaunchContext(
  input: CodexProcessEnvInput = {},
): CodexProcessLaunchContext {
  const baseEnv = { ...(input.env ?? process.env) };
  const sourceHomePath = resolveBaseCodexHomePath(baseEnv, input.homePath);
  const authTracking = resolveCodexAuthTracking({
    env: baseEnv,
    ...(input.homePath ? { homePath: input.homePath } : {}),
    ...(input.shadowHomePath ? { shadowHomePath: input.shadowHomePath } : {}),
    ...(input.accountId ? { accountId: input.accountId } : {}),
  });
  const overlayPreparationInput: CodexHomeOverlayPreparationInput = {
    env: baseEnv,
    ...(input.homePath ? { homePath: input.homePath } : {}),
    ...(input.shadowHomePath ? { shadowHomePath: input.shadowHomePath } : {}),
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.overlayEntryLinker ? { overlayEntryLinker: input.overlayEntryLinker } : {}),
    ...(input.expectedSharedContinuationGeneration
      ? { expectedSharedContinuationGeneration: input.expectedSharedContinuationGeneration }
      : {}),
    ...(input.allowLegacySharedContinuationMigration
      ? { allowLegacySharedContinuationMigration: true }
      : {}),
  };
  const overlayHomePath =
    input.expectedSharedContinuationGeneration || input.allowLegacySharedContinuationMigration
      ? prepareCodexHomeOverlayFromPreparedContinuationSource(overlayPreparationInput)
      : prepareCodexHomeOverlay(overlayPreparationInput);
  const effectiveEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...(overlayHomePath || input.homePath ? { CODEX_HOME: overlayHomePath ?? sourceHomePath } : {}),
    // Keep the environment override as a compatibility backstop for ancillary
    // Codex commands. app-server itself also receives a highest-precedence CLI
    // override from appServerArgs below.
    [CODEX_SQLITE_HOME_ENV_NAME]: path.resolve(sourceHomePath),
  };
  const platform = input.platform ?? process.platform;

  if (platform === "darwin" || platform === "linux") {
    try {
      const shell = resolveLoginShell(platform, effectiveEnv.SHELL);
      const providerEnvKey = readActiveCodexProviderEnvKey(effectiveEnv);
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

  if (platform !== "win32") {
    const browserUsePipePath = resolveCodexBrowserUsePipePath({ env: effectiveEnv, platform });
    const allowedSockets =
      effectiveEnv[NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS]
        ?.split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0) ?? [];
    if (!allowedSockets.includes(browserUsePipePath)) {
      effectiveEnv[NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS] = [
        ...allowedSockets,
        browserUsePipePath,
      ].join(",");
    }
  }

  if (input.expectedSharedContinuationGeneration) {
    assertSharedCodexContinuationGenerationPrepared(
      sourceHomePath,
      input.expectedSharedContinuationGeneration,
    );
  }

  return {
    env: effectiveEnv,
    authTracking,
    appServerArgs: buildCodexAppServerArgs(sourceHomePath),
  };
}

export function buildCodexProcessEnv(input: CodexProcessEnvInput = {}): NodeJS.ProcessEnv {
  return buildCodexProcessLaunchContext(input).env;
}

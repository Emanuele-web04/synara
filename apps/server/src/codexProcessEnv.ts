// FILE: codexProcessEnv.ts
// Purpose: Builds the exact environment used when Synara launches Codex subprocesses.
// Layer: Server runtime utility
// Exports: Codex process env builder and browser-plugin overlay helpers.
// Depends on: Codex home path helpers, shared Codex config parsing, login-shell env reader.

import * as fs from "node:fs/promises";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  type BigIntStats,
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
import {
  buildProviderChildEnvironment,
  registerProviderCredentialKey,
} from "./providerChildEnvironment.ts";

const CODEX_PROCESS_SHELL_ENV_NAMES = ["PATH", "SSH_AUTH_SOCK"] as const;
const CODEX_SQLITE_HOME_ENV_NAME = "CODEX_SQLITE_HOME";
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
const LEGACY_SYNARA_SHARED_CONTINUATION_MARKER_FILE = "synara-shared-continuation-v1.json";
const SYNARA_SHARED_CONTINUATION_MARKER_FILE = "synara-shared-continuation-v2.json";
const SYNARA_SHARED_CONTINUATION_MARKER_VERSION = 2;
const SHARED_CONTINUATION_GENERATION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SYNARA_SHARED_CONTINUATION_LOCK_DIRECTORY = ".synara-shared-continuation-v1.lock";
const SYNARA_SHARED_CONTINUATION_LOCK_OWNER_FILE = "owner.json";
const SYNARA_SHARED_CONTINUATION_LOCK_QUARANTINE_INFIX = ".quarantine-";
const SYNARA_SHARED_CONTINUATION_LOCK_TIMEOUT_MS = 10_000;
const SYNARA_SHARED_CONTINUATION_LOCK_POLL_MS = 25;
const SYNARA_SHARED_CONTINUATION_ORPHAN_LOCK_GRACE_MS = 2_000;
const REQUIRED_SHARED_CONTINUATION_DIRECTORIES = ["sessions", "archived_sessions"] as const;
const REQUIRED_SHARED_CONTINUATION_FILES = ["history.jsonl", "session_index.jsonl"] as const;
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

export interface CodexProcessLaunchContext {
  readonly env: NodeJS.ProcessEnv;
  readonly appServerArgs: readonly string[];
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

export interface PreparedCodexAuthTracking {
  readonly sourceConfigPath: string;
  readonly authoritativeAuthFilePath: string;
  readonly sourceConfigSnapshot: string;
  readonly authSource: CodexPreparedAuthSource;
}

export interface CodexAuthTrackingPreparationHooks {
  readonly afterSourceHomeBound?: () => void;
}

export interface CodexProcessEnvInput {
  readonly env?: NodeJS.ProcessEnv;
  readonly homePath?: string;
  readonly shadowHomePath?: string;
  readonly accountId?: string;
  readonly platform?: NodeJS.Platform;
  readonly readEnvironment?: ShellEnvironmentReader;
  readonly appendConfigToml?: string;
  readonly skipHomeOverlay?: boolean;
  readonly overlayEntryLinker?: CodexOverlayEntryLinker;
  readonly expectedSharedContinuationGeneration?: string;
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

export function buildCodexAppServerArgs(sourceHomePath: string): readonly string[] {
  const absoluteSourceHomePath = path.resolve(sourceHomePath);
  // These are global clap options in the minimum supported Codex 0.105.0 and
  // remain valid after the app-server subcommand. Keeping them last gives the
  // managed values precedence over every user and project config layer.
  return [
    "app-server",
    "--config",
    `sqlite_home=${JSON.stringify(absoluteSourceHomePath)}`,
    "--config",
    'cli_auth_credentials_store="file"',
  ];
}

export interface CodexOverlayEntryLinker {
  readonly symlink: typeof fs.symlink;
  readonly copyFile: typeof fs.copyFile;
}

export interface CodexOverlayConfigPublicationHooks {
  /** Deterministic test seam. Production callers must omit this hook. */
  readonly beforeRename?: (temporaryPath: string, targetPath: string) => void | Promise<void>;
}

export async function writeCodexOverlayConfigAtomically(
  targetPath: string,
  contents: string,
  hooks: CodexOverlayConfigPublicationHooks = {},
): Promise<void> {
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await hooks.beforeRename?.(temporaryPath, targetPath);
    await fs.rename(temporaryPath, targetPath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

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

function assertCodexSqliteHomeMatchesSource(input: {
  readonly sourceConfig: string;
  readonly sourceHomePath: string;
}): void {
  // Codex 0.105+ defines sqlite_home only on the root Config schema. A
  // same-named profile key is ignored and cannot override this safety check.
  const configured = parseManagedCodexConfig(input.sourceConfig).root.sqlite_home;
  if (configured === undefined) {
    return;
  }
  if (
    typeof configured !== "string" ||
    !path.isAbsolute(configured) ||
    !codexPathsReferenceSameLocation(configured, input.sourceHomePath)
  ) {
    const displayPath = typeof configured === "string" && configured ? configured : "<invalid>";
    throw new Error(
      `Codex config sqlite_home at ${displayPath} must resolve to the source CODEX_HOME ${path.resolve(input.sourceHomePath)} so Synara account overlays share one continuation database.`,
    );
  }
}

type CodexAuthCredentialsStoreMode = "file" | "keyring" | "auto" | "ephemeral";

export function readEffectiveCodexAuthCredentialsStoreMode(
  config: string,
): CodexAuthCredentialsStoreMode {
  const mode = parseManagedCodexConfig(config).root.cli_auth_credentials_store;
  if (mode === undefined) return "file";
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
  if (mode !== "keyring" && mode !== "auto") return;
  const accountLabel = input.accountId?.trim() || "default";
  throw new Error(
    `Codex account '${accountLabel}' uses cli_auth_credentials_store = "${mode}". Synara-managed Codex homes require file-backed Codex auth so account changes can invalidate long-lived app-server sessions; set the root cli_auth_credentials_store = "file" before starting this account.`,
  );
}

function filesystemErrorCode(cause: unknown): string | undefined {
  return typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { readonly code?: unknown }).code ?? "")
    : undefined;
}

function validateCodexPrivateHomePath(
  sourceHomePath: string,
  privateHomePath: string,
  label: "shadow home" | "overlay home",
): void {
  if (codexPathsReferenceSameLocation(sourceHomePath, privateHomePath)) {
    throw new Error(`Codex account ${label} must be different from CODEX_HOME.`);
  }
  try {
    if (lstatSync(privateHomePath).isSymbolicLink()) {
      throw new Error(
        `Codex account ${label} at ${privateHomePath} is a symlink; it must be a real directory so accounts cannot alias each other's auth.`,
      );
    }
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("must be a real directory")) throw cause;
    if (filesystemErrorCode(cause) !== "ENOENT") throw cause;
  }
}

function assertCodexPrivateAuthIsNotSymlink(privateHomePath: string): void {
  const authPath = path.join(privateHomePath, "auth.json");
  try {
    if (lstatSync(authPath).isSymbolicLink()) {
      throw new Error(
        `Codex account private state at ${authPath} is a symlink; it must be a real file so accounts cannot alias each other's private state.`,
      );
    }
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("private state")) throw cause;
    if (filesystemErrorCode(cause) !== "ENOENT") throw cause;
  }
}

function bindCodexPreparedHomeSource(
  homePath: string,
  options: { readonly label: string; readonly requireRealDirectory: boolean },
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
      throw new Error(`${input.label} at ${input.logicalHomePath} could not be revalidated safely.`, {
        cause,
      });
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
    if (!preparedHomeFileIdentityMatches(before, after) || BigInt(content.byteLength) !== after.size) {
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

function codexAuthNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function codexAuthSecretSafeHash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function readCodexAuthJwtClaims(value: unknown): Record<string, unknown> | undefined {
  const token = codexAuthNonEmptyString(value);
  const payload = token?.split(".")[1];
  if (!payload) return undefined;
  try {
    return asRecord(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    return undefined;
  }
}

function firstCodexAuthString(
  records: readonly (Record<string, unknown> | undefined)[],
  keys: readonly string[],
): string | undefined {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = codexAuthNonEmptyString(record[key]);
      if (value) return value;
    }
  }
  return undefined;
}

type CodexPreparedAuthIdentity =
  | { readonly state: "missing" }
  | {
      readonly state: "present";
      readonly authMode: "api-key" | "chatgpt" | "unknown";
      readonly identity: string;
      readonly fallback?: true;
    };

function readCodexPreparedAuthIdentity(content: Buffer | undefined): CodexPreparedAuthIdentity {
  if (!content) return { state: "missing" };
  const contentIdentity = codexAuthSecretSafeHash(content.toString("base64"));
  try {
    const auth = asRecord(JSON.parse(content.toString("utf8")));
    if (!auth) {
      return { state: "present", authMode: "unknown", identity: contentIdentity, fallback: true };
    }
    const tokens = asRecord(auth.tokens);
    const idTokenClaims = readCodexAuthJwtClaims(tokens?.id_token ?? tokens?.idToken);
    const rawMode = codexAuthNonEmptyString(auth.auth_mode ?? auth.authMode)?.toLowerCase();
    const apiKey = codexAuthNonEmptyString(
      auth.OPENAI_API_KEY ?? auth.openai_api_key ?? auth.apiKey,
    );
    if (rawMode === "apikey" || rawMode === "api-key" || (apiKey && !tokens)) {
      return {
        state: "present",
        authMode: "api-key",
        identity: codexAuthSecretSafeHash(apiKey ?? content.toString("base64")),
        ...(apiKey ? {} : { fallback: true as const }),
      };
    }
    if (tokens || rawMode === "chatgpt" || rawMode === "chatgptauthtokens") {
      const workspaceId = firstCodexAuthString(
        [tokens, idTokenClaims, auth],
        [
          "account_id",
          "accountId",
          "chatgpt_account_id",
          "chatgptAccountId",
          "https://api.openai.com/auth/chatgpt_account_id",
        ],
      );
      const userId = firstCodexAuthString(
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
          identity: codexAuthSecretSafeHash(
            JSON.stringify({ workspaceId: workspaceId ?? null, userId: userId ?? null }),
          ),
        };
      }
      return { state: "present", authMode: "chatgpt", identity: contentIdentity, fallback: true };
    }
  } catch {
    // Malformed auth still receives a deterministic, secret-safe identity.
  }
  return { state: "present", authMode: "unknown", identity: contentIdentity, fallback: true };
}

export function readCodexPreparedAuthTrackingFingerprint(
  tracking: PreparedCodexAuthTracking,
): string {
  return JSON.stringify({
    storeMode: readEffectiveCodexAuthCredentialsStoreMode(tracking.sourceConfigSnapshot),
    auth: readCodexPreparedAuthIdentity(
      readCodexPreparedHomeFileSnapshot(tracking.authSource, "auth.json"),
    ),
  });
}

export function prepareCodexAuthTracking(
  input: Pick<CodexProcessEnvInput, "env" | "homePath" | "shadowHomePath" | "accountId"> = {},
  hooks: CodexAuthTrackingPreparationHooks = {},
): PreparedCodexAuthTracking {
  const env = { ...(input.env ?? process.env) };
  const sourceHomePath = resolveBaseCodexHomePath(env, input.homePath);
  const ambientHomePath = resolveBaseCodexHomePath(env);
  const hasDedicatedAccountHome =
    Boolean(input.homePath?.trim()) &&
    !codexPathsReferenceSameLocation(sourceHomePath, ambientHomePath);
  const shadowHomePath = input.shadowHomePath
    ? resolveBaseCodexHomePath(env, input.shadowHomePath)
    : undefined;
  const accountSegment = resolveCodexHomeOverlayAccountSegment({
    homePath: sourceHomePath,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(shadowHomePath ? { shadowHomePath } : {}),
  });
  const overlayHomePath = resolveSynaraCodexHomeOverlayPath(env, sourceHomePath, accountSegment);
  const authoritativeAuthHomePath =
    shadowHomePath ??
    (accountSegment && !hasDedicatedAccountHome ? overlayHomePath : sourceHomePath);
  const requiresRealPrivateHome = Boolean(
    shadowHomePath || (accountSegment && !hasDedicatedAccountHome),
  );
  const sourceHomeAlsoOwnsAuth =
    path.resolve(authoritativeAuthHomePath) === path.resolve(sourceHomePath);
  if (shadowHomePath) {
    validateCodexPrivateHomePath(sourceHomePath, shadowHomePath, "shadow home");
  }
  if (accountSegment && !shadowHomePath && !hasDedicatedAccountHome) {
    validateCodexPrivateHomePath(sourceHomePath, overlayHomePath, "overlay home");
  }

  const sourceHomeSource = bindCodexPreparedHomeSource(sourceHomePath, {
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
    sourceHomePath,
    sourceHomeSource,
    authoritativeAuthHomePath,
    authSource,
  };
  assertPreparedAuthAndSourceBindingsCurrent(bindingTransaction);
  if (requiresRealPrivateHome && authSource.kind === "bound") {
    assertCodexPrivateAuthIsNotSymlink(authSource.canonicalHomePath);
  }

  const sourceConfigSnapshot =
    readCodexPreparedHomeFileSnapshot(sourceHomeSource, "config.toml")?.toString("utf8") ?? "";
  const sourceConfigPath = path.join(sourceHomePath, "config.toml");
  assertManagedCodexHomeUsesObservableAuth({
    sourceConfig: sourceConfigSnapshot,
    ...(input.accountId ? { accountId: input.accountId } : {}),
  });
  const authoritativeAuthFilePath = path.join(authoritativeAuthHomePath, "auth.json");
  assertPreparedAuthAndSourceBindingsCurrent(bindingTransaction);
  return {
    sourceConfigPath,
    authoritativeAuthFilePath,
    sourceConfigSnapshot,
    authSource,
  };
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

function legacySharedContinuationMarkerPath(sourceHomePath: string): string {
  return path.join(sourceHomePath, LEGACY_SYNARA_SHARED_CONTINUATION_MARKER_FILE);
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

interface SharedContinuationLockSnapshot {
  readonly lockPath: string;
  readonly token?: string;
  readonly pid?: number;
  readonly createdAtMs: number;
  readonly device: string;
  readonly inode: string;
  readonly ownerDevice?: string;
  readonly ownerInode?: string;
}

async function readSharedContinuationLock(
  lockPath: string,
): Promise<SharedContinuationLockSnapshot | undefined> {
  try {
    const lockStat = await fs.lstat(lockPath);
    if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) {
      throw new Error(`Codex continuation lock at ${lockPath} must be a real directory.`);
    }
    const ownerPath = path.join(lockPath, SYNARA_SHARED_CONTINUATION_LOCK_OWNER_FILE);
    const ownerStat = await lstatIfExists(ownerPath);
    if (ownerStat && (!ownerStat.isFile() || ownerStat.isSymbolicLink())) {
      throw new Error(`Codex continuation lock owner at ${ownerPath} must be a regular file.`);
    }
    let parsed: {
      readonly token?: unknown;
      readonly pid?: unknown;
      readonly createdAtMs?: unknown;
    } = {};
    if (ownerStat) {
      try {
        parsed = JSON.parse(await fs.readFile(ownerPath, "utf8")) as typeof parsed;
      } catch (error) {
        if (!(error instanceof SyntaxError)) {
          throw error;
        }
      }
    }
    return {
      lockPath,
      ...(typeof parsed.token === "string" && parsed.token.length > 0
        ? { token: parsed.token }
        : {}),
      ...(typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0
        ? { pid: parsed.pid }
        : {}),
      createdAtMs:
        typeof parsed.createdAtMs === "number" && Number.isFinite(parsed.createdAtMs)
          ? parsed.createdAtMs
          : Number(ownerStat?.mtimeMs ?? lockStat.mtimeMs),
      device: String(lockStat.dev),
      inode: String(lockStat.ino),
      ...(ownerStat
        ? { ownerDevice: String(ownerStat.dev), ownerInode: String(ownerStat.ino) }
        : {}),
    };
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

function sameSharedContinuationLockDirectory(
  left: SharedContinuationLockSnapshot,
  right: SharedContinuationLockSnapshot,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function sameSharedContinuationLock(
  left: SharedContinuationLockSnapshot,
  right: SharedContinuationLockSnapshot,
): boolean {
  return (
    sameSharedContinuationLockDirectory(left, right) &&
    left.token === right.token &&
    left.ownerDevice === right.ownerDevice &&
    left.ownerInode === right.ownerInode
  );
}

async function quarantineObservedSharedContinuationLock(input: {
  readonly observed: SharedContinuationLockSnapshot;
}): Promise<boolean> {
  const quarantinePath = `${input.observed.lockPath}${SYNARA_SHARED_CONTINUATION_LOCK_QUARANTINE_INFIX}${randomUUID()}`;
  try {
    await fs.rename(input.observed.lockPath, quarantinePath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }

  const quarantined = await readSharedContinuationLock(quarantinePath);
  if (quarantined && sameSharedContinuationLock(input.observed, quarantined)) {
    await fs.rm(quarantinePath, { recursive: true, force: true });
    return true;
  }

  let restored = false;
  if (!(await lstatIfExists(input.observed.lockPath)) && (await lstatIfExists(quarantinePath))) {
    try {
      await fs.rename(quarantinePath, input.observed.lockPath);
      restored = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
    }
  }
  throw new Error(
    `Codex continuation lock changed while quarantining ${input.observed.lockPath}; the moved successor was not deleted${restored ? " and was restored" : ` and remains at ${quarantinePath}`}.`,
  );
}

function sharedContinuationLockIsStale(snapshot: SharedContinuationLockSnapshot): boolean {
  if (snapshot.pid !== undefined) {
    return !processIsAlive(snapshot.pid);
  }
  return Date.now() - snapshot.createdAtMs >= SYNARA_SHARED_CONTINUATION_ORPHAN_LOCK_GRACE_MS;
}

async function withSharedContinuationLock<T>(
  sourceHomePath: string,
  operation: () => Promise<T>,
  options: { readonly createSourceHome?: boolean } = {},
): Promise<T> {
  if (options.createSourceHome !== false) {
    await fs.mkdir(sourceHomePath, { recursive: true });
  }
  const lockPath = sharedContinuationLockPath(sourceHomePath);
  const startedAt = Date.now();
  const token = randomUUID();
  let ownership: SharedContinuationLockSnapshot | undefined;

  while (!ownership) {
    let created = false;
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
    }

    if (created) {
      const emptyOwnership = await readSharedContinuationLock(lockPath);
      if (!emptyOwnership) {
        throw new Error(`Codex continuation lock disappeared after creation at ${lockPath}.`);
      }
      try {
        await fs.writeFile(
          path.join(lockPath, SYNARA_SHARED_CONTINUATION_LOCK_OWNER_FILE),
          `${JSON.stringify({ token, pid: process.pid, createdAtMs: Date.now() })}\n`,
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        const current = await readSharedContinuationLock(lockPath);
        if (current && sameSharedContinuationLock(emptyOwnership, current)) {
          await quarantineObservedSharedContinuationLock({ observed: emptyOwnership });
        }
        throw error;
      }
      const claimed = await readSharedContinuationLock(lockPath);
      if (
        !claimed ||
        claimed.token !== token ||
        !sameSharedContinuationLockDirectory(emptyOwnership, claimed)
      ) {
        throw new Error(
          `Codex continuation lock ownership changed during acquisition at ${lockPath}; refusing to remove it.`,
        );
      }
      ownership = claimed;
      break;
    }

    const observed = await readSharedContinuationLock(lockPath);
    if (observed && sharedContinuationLockIsStale(observed)) {
      if (await quarantineObservedSharedContinuationLock({ observed })) {
        continue;
      }
    }
    if (Date.now() - startedAt >= SYNARA_SHARED_CONTINUATION_LOCK_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for Codex continuation-state lock at ${lockPath}.`);
    }
    await sleep(SYNARA_SHARED_CONTINUATION_LOCK_POLL_MS);
  }

  try {
    return await operation();
  } finally {
    const observed = await readSharedContinuationLock(lockPath);
    if (!observed || !sameSharedContinuationLock(ownership, observed)) {
      throw new Error(
        `Lost ownership of Codex continuation lock ${lockPath}; refusing to remove another owner.`,
      );
    }
    if (!(await quarantineObservedSharedContinuationLock({ observed }))) {
      throw new Error(
        `Lost ownership of Codex continuation lock ${lockPath} during release; no successor was removed.`,
      );
    }
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

function isSharedContinuationLockEntry(entryName: string): boolean {
  return (
    entryName === SYNARA_SHARED_CONTINUATION_LOCK_DIRECTORY ||
    entryName.startsWith(
      `${SYNARA_SHARED_CONTINUATION_LOCK_DIRECTORY}${SYNARA_SHARED_CONTINUATION_LOCK_QUARANTINE_INFIX}`,
    )
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
  readonly sourcePolicy?: SharedContinuationSourcePolicy;
  readonly sourceRequirements?: SharedContinuationSourceRequirements;
}): Promise<SharedContinuationGenerationMetadata> {
  const sourcePolicy = input.sourcePolicy ?? "create-if-missing";
  if (
    sourcePolicy === "require-prepared" &&
    readSharedContinuationGenerationState(input.sourceHomePath).kind === "absent"
  ) {
    throw new Error(
      `Codex shared continuation source at ${input.sourceHomePath} is missing or damaged; refusing to recreate persisted session state. Restore the original source home before resuming this thread.`,
    );
  }
  let preparedMetadata: SharedContinuationGenerationMetadata | undefined;
  await withSharedContinuationLock(input.sourceHomePath, async () => {
    const initialState = readSharedContinuationGenerationState(input.sourceHomePath);
    const mayCreateSourceEntries =
      sourcePolicy === "create-if-missing" && initialState.kind === "absent";
    if (!mayCreateSourceEntries) {
      assertRequiredSharedContinuationEntriesPrepared(input.sourceHomePath);
    }
    if (sourcePolicy === "require-prepared") {
      preparedMetadata = await requireSharedContinuationGenerationMetadata(
        input.sourceHomePath,
        input.sourceRequirements,
      );
    }
    await fs.mkdir(input.overlayHomePath, { recursive: true });
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
      if (!mayCreateSourceEntries && migration.action === "create-source") {
        throw new Error(
          `Codex shared continuation source at ${input.sourceHomePath} became incomplete while preparing '${migration.entryName}'; refusing to recreate persisted session state.`,
        );
      }
      await executeSharedContinuationMigration(migration, input.overlayEntryLinker);
    }
    assertRequiredSharedContinuationEntriesPrepared(input.sourceHomePath);
    preparedMetadata ??= await ensureSharedContinuationGenerationMetadata(input.sourceHomePath);
    assertSharedCodexContinuationGenerationPrepared(
      input.sourceHomePath,
      preparedMetadata.generation,
    );
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
  }, { createSourceHome: sourcePolicy === "create-if-missing" });
  if (!preparedMetadata) {
    throw new Error(`Codex shared continuation generation was not prepared safely.`);
  }
  return preparedMetadata;
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

function resolvedSymlinkTargetSync(linkPath: string): string {
  const target = readlinkSync(linkPath);
  return path.isAbsolute(target) ? target : path.resolve(path.dirname(linkPath), target);
}

function sharedContinuationIdentityEntryNames(): readonly string[] {
  return [...REQUIRED_SHARED_CONTINUATION_DIRECTORIES, ...REQUIRED_SHARED_CONTINUATION_FILES];
}

function readRegularSharedContinuationFile(filePath: string, label: string): string | undefined {
  const stat = lstatSyncIfExists(filePath);
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
    // Report one fail-closed error for malformed and mismatched markers.
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
    // Report one fail-closed error for malformed and mismatched markers.
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

async function writeSharedContinuationV2Marker(
  sourceHomePath: string,
  metadata: SharedContinuationGenerationMetadata,
): Promise<boolean> {
  const markerPath = sharedContinuationMarkerPath(sourceHomePath);
  const temporaryPath = path.join(
    sourceHomePath,
    `.synara-shared-continuation-v2.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporaryPath, sharedContinuationMarkerContent(sourceHomePath, metadata), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      await fs.link(temporaryPath, markerPath);
      return true;
    } catch (error) {
      if (errorCode(error) === "EEXIST") return false;
      throw error;
    }
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function ensureSharedContinuationGenerationMetadata(
  sourceHomePath: string,
): Promise<SharedContinuationGenerationMetadata> {
  const existing = readSharedContinuationGenerationState(sourceHomePath);
  if (existing.kind === "v2") return existing;
  if (existing.kind === "legacy") {
    assertRequiredSharedContinuationEntriesPrepared(sourceHomePath);
  }
  const candidate: SharedContinuationGenerationMetadata = {
    generation: randomUUID().toLowerCase(),
    ...(existing.kind === "legacy" ? { migratedFromVersion: 1 as const } : {}),
  };
  if (!(await writeSharedContinuationV2Marker(sourceHomePath, candidate))) {
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
    await fs.rm(legacySharedContinuationMarkerPath(sourceHomePath), { force: true });
  }
  return committed;
}

function assertRequiredSharedContinuationEntriesPrepared(sourceHomePath: string): void {
  for (const entryName of sharedContinuationIdentityEntryNames()) {
    const entryPath = path.join(sourceHomePath, entryName);
    const stat = lstatSyncIfExists(entryPath);
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

async function requireSharedContinuationGenerationMetadata(
  sourceHomePath: string,
  requirements: SharedContinuationSourceRequirements = {},
): Promise<SharedContinuationGenerationMetadata> {
  const expectedGeneration = requirements.expectedGeneration?.toLowerCase();
  if (
    expectedGeneration !== undefined &&
    !SHARED_CONTINUATION_GENERATION_PATTERN.test(expectedGeneration)
  ) {
    throw new Error("Invalid expected Codex shared continuation generation.");
  }
  let state = readSharedContinuationGenerationState(sourceHomePath);
  if (state.kind === "legacy") {
    if (!requirements.allowLegacyMigration) {
      throw new Error(
        `Codex shared continuation source at ${sourceHomePath} still uses a legacy marker and cannot satisfy a generation-pinned launch.`,
      );
    }
    assertRequiredSharedContinuationEntriesPrepared(sourceHomePath);
    state = { kind: "v2", ...(await ensureSharedContinuationGenerationMetadata(sourceHomePath)) };
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
    const sourceStat = lstatSyncIfExists(sourcePath);
    const targetStat = lstatSyncIfExists(targetPath);
    const sourceMatchesExpectedType =
      sourceStat !== undefined &&
      (kind === "dir" ? sourceStat.isDirectory() : sourceStat.isFile());
    if (!sourceMatchesExpectedType) {
      return false;
    }
    return (
      targetStat?.isSymbolicLink() === true &&
      codexPathsReferenceSameLocation(resolvedSymlinkTargetSync(targetPath), sourcePath)
    );
  });
}

export function readCodexSharedContinuationGeneration(input: {
  readonly env?: NodeJS.ProcessEnv;
  readonly homePath?: string;
  readonly shadowHomePath?: string;
  readonly accountId?: string;
} = {}): string | undefined {
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
    const sourceConfigPath = path.join(sourceHomePath, "config.toml");
    let sourceConfig = "";
    try {
      sourceConfig = readFileSync(sourceConfigPath, "utf8");
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
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

export function isCodexSharedContinuationStatePrepared(input: {
  readonly env?: NodeJS.ProcessEnv;
  readonly homePath?: string;
  readonly shadowHomePath?: string;
  readonly accountId?: string;
} = {}): boolean {
  return readCodexSharedContinuationGeneration(input) !== undefined;
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
  readonly continuationSourcePolicy?: SharedContinuationSourcePolicy;
  readonly continuationSourceRequirements?: SharedContinuationSourceRequirements;
}): Promise<string | undefined> {
  const sourceHomePath = resolveBaseCodexHomePath(input.env, input.homePath);
  const sourceConfigPath = path.join(sourceHomePath, "config.toml");
  const sourceConfig = await fs.readFile(sourceConfigPath, "utf8").catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw cause;
  });
  assertCodexSqliteHomeMatchesSource({ sourceConfig, sourceHomePath });
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
    if (input.continuationSourcePolicy === "require-prepared") {
      await withSharedContinuationLock(
        sourceHomePath,
        () =>
          requireSharedContinuationGenerationMetadata(
            sourceHomePath,
            input.continuationSourceRequirements,
          ),
        { createSourceHome: false },
      );
    }
    return undefined;
  }

  // Continuation preparation is all-or-nothing for default and account
  // overlays. A host that cannot create the required links fails closed.
  const continuationMetadata = await prepareSharedCodexContinuationState({
    sourceHomePath,
    overlayHomePath,
    ...(input.overlayEntryLinker ? { overlayEntryLinker: input.overlayEntryLinker } : {}),
    ...(input.continuationSourcePolicy
      ? { sourcePolicy: input.continuationSourcePolicy }
      : {}),
    ...(input.continuationSourceRequirements
      ? { sourceRequirements: input.continuationSourceRequirements }
      : {}),
  });
  await removeLegacyCodexOverlaySqliteLinks(overlayHomePath);

  try {
    // Auth must get a best-effort link/copy before optional entries whose
    // symlinks may fail on restricted Windows installs.
    for (const entry of prioritizeCodexOverlayEntries(await fs.readdir(sourceHomePath))) {
      if (
        entry === "config.toml" ||
        entry === LEGACY_SYNARA_SHARED_CONTINUATION_MARKER_FILE ||
        entry === SYNARA_SHARED_CONTINUATION_MARKER_FILE ||
        isSharedContinuationLockEntry(entry) ||
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
  await writeCodexOverlayConfigAtomically(overlayConfigPath, overlayConfig);
  await writeSynaraConfigSuppressions(suppressionMarkerPath, suppressedSections);

  assertSharedCodexContinuationGenerationPrepared(
    sourceHomePath,
    continuationMetadata.generation,
  );

  return overlayHomePath;
}

async function prepareSynaraCodexHomeOverlay(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homePath?: string;
  readonly shadowHomePath?: string;
  readonly accountId?: string;
  readonly appendConfigToml?: string;
  readonly overlayEntryLinker?: CodexOverlayEntryLinker;
  readonly continuationSourcePolicy?: SharedContinuationSourcePolicy;
  readonly continuationSourceRequirements?: SharedContinuationSourceRequirements;
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
    if (input.continuationSourcePolicy === "require-prepared") {
      await withSharedContinuationLock(
        sourceHomePath,
        () =>
          requireSharedContinuationGenerationMetadata(
            sourceHomePath,
            input.continuationSourceRequirements,
          ),
        { createSourceHome: false },
      );
    }
    return undefined;
  }
  return serializeCodexOverlayPreparation(overlayHomePath, () =>
    prepareSynaraCodexHomeOverlayUnlocked(input),
  );
}

type CodexHomeOverlayPreparationInput = Pick<
  CodexProcessEnvInput,
  | "env"
  | "homePath"
  | "shadowHomePath"
  | "accountId"
  | "appendConfigToml"
  | "overlayEntryLinker"
  | "expectedSharedContinuationGeneration"
  | "allowLegacySharedContinuationMigration"
>;

async function prepareCodexHomeOverlayWithSourcePolicy(
  input: CodexHomeOverlayPreparationInput,
  continuationSourcePolicy: SharedContinuationSourcePolicy,
): Promise<string | undefined> {
  const env = { ...(input.env ?? process.env) };
  return prepareSynaraCodexHomeOverlay({
    env,
    ...(input.homePath ? { homePath: input.homePath } : {}),
    ...(input.shadowHomePath ? { shadowHomePath: input.shadowHomePath } : {}),
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.appendConfigToml ? { appendConfigToml: input.appendConfigToml } : {}),
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

/** Materializes the same managed Codex overlay used by a real process launch. */
export async function prepareCodexHomeOverlay(
  input: CodexHomeOverlayPreparationInput = {},
): Promise<string | undefined> {
  return prepareCodexHomeOverlayWithSourcePolicy(input, "create-if-missing");
}

/**
 * Repairs only an overlay for persisted continuation state. The source marker
 * and required entries must already be healthy and are never recreated here.
 */
export async function prepareCodexHomeOverlayFromPreparedContinuationSource(
  input: CodexHomeOverlayPreparationInput = {},
): Promise<string | undefined> {
  return prepareCodexHomeOverlayWithSourcePolicy(input, "require-prepared");
}

export async function buildCodexProcessEnv(
  input: CodexProcessEnvInput = {},
): Promise<NodeJS.ProcessEnv> {
  const baseEnv = { ...(input.env ?? process.env) };
  const sourceHomePath = resolveBaseCodexHomePath(baseEnv, input.homePath);
  const overlayPreparationInput: CodexHomeOverlayPreparationInput = {
        env: baseEnv,
        ...(input.homePath ? { homePath: input.homePath } : {}),
        ...(input.shadowHomePath ? { shadowHomePath: input.shadowHomePath } : {}),
        ...(input.accountId ? { accountId: input.accountId } : {}),
        ...(input.appendConfigToml ? { appendConfigToml: input.appendConfigToml } : {}),
        ...(input.overlayEntryLinker
          ? { overlayEntryLinker: input.overlayEntryLinker }
          : {}),
        ...(input.expectedSharedContinuationGeneration
          ? { expectedSharedContinuationGeneration: input.expectedSharedContinuationGeneration }
          : {}),
        ...(input.allowLegacySharedContinuationMigration
          ? { allowLegacySharedContinuationMigration: true }
          : {}),
      };
  const overlayHomePath = input.skipHomeOverlay
    ? undefined
    : input.expectedSharedContinuationGeneration || input.allowLegacySharedContinuationMigration
      ? await prepareCodexHomeOverlayFromPreparedContinuationSource(overlayPreparationInput)
      : await prepareCodexHomeOverlay(overlayPreparationInput);
  const directAccountHomePath = input.shadowHomePath
    ? resolveBaseCodexHomePath(baseEnv, input.shadowHomePath)
    : input.homePath
      ? resolveBaseCodexHomePath(baseEnv, input.homePath)
      : undefined;
  const configuredEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...(overlayHomePath || directAccountHomePath
      ? { CODEX_HOME: overlayHomePath ?? directAccountHomePath }
      : {}),
    // Config sqlite_home has higher precedence and was validated before any
    // overlay mutation. Route all future DB names and sidecars to one source.
    [CODEX_SQLITE_HOME_ENV_NAME]: path.resolve(sourceHomePath),
  };
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

  if (input.expectedSharedContinuationGeneration) {
    assertSharedCodexContinuationGenerationPrepared(
      sourceHomePath,
      input.expectedSharedContinuationGeneration,
    );
  }

  return effectiveEnv;
}

export async function buildCodexProcessLaunchContext(
  input: CodexProcessEnvInput = {},
): Promise<CodexProcessLaunchContext> {
  const baseEnv = { ...(input.env ?? process.env) };
  const sourceHomePath = resolveBaseCodexHomePath(baseEnv, input.homePath);
  return {
    env: await buildCodexProcessEnv(input),
    appServerArgs: buildCodexAppServerArgs(sourceHomePath),
  };
}

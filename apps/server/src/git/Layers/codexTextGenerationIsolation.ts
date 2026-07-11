// FILE: codexTextGenerationIsolation.ts
// Purpose: Builds non-executable Codex config and safely mirrors account auth for text generation.
// Layer: Server text-generation isolation helpers.

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { Effect, FileSystem } from "effect";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

type UnknownRecord = Record<string, unknown>;

export class CodexTextGenerationConfigError extends Error {
  override readonly name = "CodexTextGenerationConfigError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class CodexTextGenerationAuthError extends Error {
  override readonly name = "CodexTextGenerationAuthError";
  readonly recoveryPath: string | undefined;
  readonly candidatePath: string | undefined;

  constructor(
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly recoveryPath?: string;
      readonly candidatePath?: string;
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.recoveryPath = options?.recoveryPath;
    this.candidatePath = options?.candidatePath;
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(record: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readOptionalString(
  record: UnknownRecord,
  key: string,
  context: string,
): string | undefined {
  if (!hasOwn(record, key)) return undefined;
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CodexTextGenerationConfigError(`${context}.${key} must be a non-empty string.`);
  }
  return value;
}

function readOptionalStringList(
  record: UnknownRecord,
  key: string,
  context: string,
): string | readonly string[] | undefined {
  if (!hasOwn(record, key)) return undefined;
  const value = record[key];
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string" && entry.trim().length > 0)
  ) {
    return value;
  }
  throw new CodexTextGenerationConfigError(
    `${context}.${key} must be a non-empty string or string array.`,
  );
}

// These fields describe transport and credential routing only. Everything
// else, especially command-backed provider auth, is absent from the child.
const SAFE_MODEL_PROVIDER_KEYS = [
  "name",
  "base_url",
  "env_key",
  "experimental_bearer_token",
  "wire_api",
  "query_params",
  "http_headers",
  "env_http_headers",
  "request_max_retries",
  "stream_max_retries",
  "stream_idle_timeout_ms",
  "websocket_connect_timeout_ms",
  "requires_openai_auth",
  "supports_websockets",
] as const;

function allowSelectedModelProvider(providerId: string, value: unknown): UnknownRecord {
  if (!isRecord(value)) {
    throw new CodexTextGenerationConfigError(`model_providers.${providerId} must be a TOML table.`);
  }
  if (hasOwn(value, "auth")) {
    throw new CodexTextGenerationConfigError(
      `model_providers.${providerId}.auth is command-backed and cannot run during isolated text generation.`,
    );
  }

  const provider: UnknownRecord = {};
  for (const key of SAFE_MODEL_PROVIDER_KEYS) {
    if (hasOwn(value, key)) provider[key] = value[key];
  }
  if (hasOwn(value, "aws")) {
    const rawAws = value.aws;
    if (!isRecord(rawAws)) {
      throw new CodexTextGenerationConfigError(
        `model_providers.${providerId}.aws must be a TOML table.`,
      );
    }
    const aws: UnknownRecord = {};
    const profile = readOptionalString(rawAws, "profile", `model_providers.${providerId}.aws`);
    const region = readOptionalString(rawAws, "region", `model_providers.${providerId}.aws`);
    if (profile !== undefined) aws.profile = profile;
    if (region !== undefined) aws.region = region;
    provider.aws = aws;
  }
  return provider;
}

export type CodexTextGenerationConfig = {
  readonly content: string;
  readonly selectedProviderId: string;
  readonly providerEnvKey?: string;
};

/**
 * Parses the complete TOML document, then constructs a new positive-allowlist
 * document. No source section is copied textually into the executable home.
 */
export function buildCodexTextGenerationConfig(source: string): CodexTextGenerationConfig {
  let root: UnknownRecord;
  try {
    const parsed = parseToml(source);
    if (!isRecord(parsed)) throw new Error("root is not a table");
    root = parsed;
  } catch (cause) {
    throw new CodexTextGenerationConfigError("Codex config.toml is malformed.", { cause });
  }

  const activeProfileName = readOptionalString(root, "profile", "config");
  let activeProfile: UnknownRecord | undefined;
  if (activeProfileName !== undefined) {
    if (
      !isRecord(root.profiles) ||
      !hasOwn(root.profiles, activeProfileName) ||
      !isRecord(root.profiles[activeProfileName])
    ) {
      throw new CodexTextGenerationConfigError(
        `config.profile selects missing profile '${activeProfileName}'.`,
      );
    }
    activeProfile = root.profiles[activeProfileName];
  }

  const rootModel = readOptionalString(root, "model", "config");
  const profileModel = activeProfile
    ? readOptionalString(activeProfile, "model", `profiles.${activeProfileName}`)
    : undefined;
  const rootProvider = readOptionalString(root, "model_provider", "config");
  const profileProvider = activeProfile
    ? readOptionalString(activeProfile, "model_provider", `profiles.${activeProfileName}`)
    : undefined;
  const selectedProviderId = profileProvider ?? rootProvider ?? "openai";
  const rootChatgptBaseUrl = readOptionalString(root, "chatgpt_base_url", "config");
  const profileChatgptBaseUrl = activeProfile
    ? readOptionalString(activeProfile, "chatgpt_base_url", `profiles.${activeProfileName}`)
    : undefined;
  const openaiBaseUrl = readOptionalString(root, "openai_base_url", "config");
  const forcedLoginMethod = readOptionalString(root, "forced_login_method", "config");
  const forcedWorkspace = readOptionalStringList(root, "forced_chatgpt_workspace_id", "config");

  let selectedProvider: UnknownRecord | undefined;
  if (hasOwn(root, "model_providers")) {
    if (!isRecord(root.model_providers)) {
      throw new CodexTextGenerationConfigError("config.model_providers must be a TOML table.");
    }
    if (hasOwn(root.model_providers, selectedProviderId)) {
      selectedProvider = allowSelectedModelProvider(
        selectedProviderId,
        root.model_providers[selectedProviderId],
      );
    }
  }
  if (selectedProviderId !== "openai" && selectedProvider === undefined) {
    throw new CodexTextGenerationConfigError(
      `config.model_provider selects missing provider '${selectedProviderId}'.`,
    );
  }

  const allowed: UnknownRecord = {
    model_provider: selectedProviderId,
    cli_auth_credentials_store: "file",
  };
  const selectedModel = profileModel ?? rootModel;
  if (selectedModel !== undefined) allowed.model = selectedModel;
  const chatgptBaseUrl = profileChatgptBaseUrl ?? rootChatgptBaseUrl;
  if (chatgptBaseUrl !== undefined) allowed.chatgpt_base_url = chatgptBaseUrl;
  if (openaiBaseUrl !== undefined) allowed.openai_base_url = openaiBaseUrl;
  if (forcedLoginMethod !== undefined) allowed.forced_login_method = forcedLoginMethod;
  if (forcedWorkspace !== undefined) allowed.forced_chatgpt_workspace_id = forcedWorkspace;
  if (selectedProvider !== undefined) {
    allowed.model_providers = { [selectedProviderId]: selectedProvider };
  }

  let content: string;
  try {
    content = stringifyToml(allowed);
  } catch (cause) {
    throw new CodexTextGenerationConfigError(
      "Selected Codex provider routing could not be serialized safely.",
      { cause },
    );
  }
  const providerEnvKey = selectedProvider
    ? readOptionalString(selectedProvider, "env_key", `model_providers.${selectedProviderId}`)
    : undefined;
  return {
    content,
    selectedProviderId,
    ...(providerEnvKey !== undefined ? { providerEnvKey } : {}),
  };
}

function fingerprintAuth(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readJwtClaims(value: unknown): UnknownRecord | undefined {
  const token = nonEmptyString(value);
  const payload = token?.split(".")[1];
  if (!payload) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function namespacedOpenAiClaims(claims: UnknownRecord | undefined): UnknownRecord | undefined {
  const nested = claims?.["https://api.openai.com/auth"];
  return isRecord(nested) ? nested : undefined;
}

function firstString(
  records: readonly (UnknownRecord | undefined)[],
  keys: readonly string[],
): string | undefined {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = nonEmptyString(record[key]);
      if (value) return value;
    }
  }
  return undefined;
}

type CodexAuthIdentity = {
  readonly mode: "api-key" | "chatgpt" | "unknown";
  readonly value: string;
};

function parseCodexAuthIdentity(content: Buffer): CodexAuthIdentity {
  let auth: UnknownRecord;
  try {
    const parsed = JSON.parse(content.toString("utf8"));
    if (!isRecord(parsed)) throw new Error("auth root is not an object");
    auth = parsed;
  } catch (cause) {
    throw new CodexTextGenerationAuthError("Codex auth.json is malformed.", { cause });
  }

  const contentIdentity = fingerprintAuth(content);
  const tokens = isRecord(auth.tokens) ? auth.tokens : undefined;
  const mode = nonEmptyString(auth.auth_mode ?? auth.authMode)?.toLowerCase();
  const apiKey = nonEmptyString(auth.OPENAI_API_KEY ?? auth.openai_api_key ?? auth.apiKey);
  if (mode === "apikey" || mode === "api-key" || (apiKey && !tokens)) {
    return {
      mode: "api-key",
      value: apiKey ? fingerprintAuth(Buffer.from(apiKey)) : contentIdentity,
    };
  }

  if (tokens || mode === "chatgpt" || mode === "chatgptauthtokens") {
    const idClaims = readJwtClaims(tokens?.id_token ?? tokens?.idToken);
    const accessClaims = readJwtClaims(tokens?.access_token ?? tokens?.accessToken);
    const namespacedIdClaims = namespacedOpenAiClaims(idClaims);
    const namespacedAccessClaims = namespacedOpenAiClaims(accessClaims);
    const workspaceId = firstString(
      [tokens, namespacedIdClaims, namespacedAccessClaims, idClaims, accessClaims, auth],
      [
        "account_id",
        "accountId",
        "chatgpt_account_id",
        "chatgptAccountId",
        "https://api.openai.com/auth/chatgpt_account_id",
      ],
    );
    const userId = firstString(
      [namespacedIdClaims, namespacedAccessClaims, idClaims, accessClaims, tokens, auth],
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
        mode: "chatgpt",
        value: fingerprintAuth(
          Buffer.from(JSON.stringify({ workspaceId: workspaceId ?? null, userId: userId ?? null })),
        ),
      };
    }
    // ChatGPT auth without stable claims deliberately fails closed on any
    // byte change rather than guessing that a rotation stayed on-account.
    return { mode: "chatgpt", value: contentIdentity };
  }
  return { mode: "unknown", value: contentIdentity };
}

export interface CodexTextGenerationAuthLinker {
  readonly symlink: typeof symlinkSync;
  readonly link: typeof linkSync;
}

export type CodexTextGenerationAuthMirror = {
  readonly mode: "symlink" | "hardlink";
  readonly authoritativeAuthFilePath: string;
  readonly effectiveAuthFilePath: string;
  readonly baselineContent: Buffer;
  readonly baselineFingerprint: string;
  readonly baselineIdentity: CodexAuthIdentity;
};

export function prepareCodexTextGenerationAuthMirror(
  authoritativeAuthFilePath: string,
  isolatedHomePath: string,
  linker: CodexTextGenerationAuthLinker = { symlink: symlinkSync, link: linkSync },
): CodexTextGenerationAuthMirror | undefined {
  if (!existsSync(authoritativeAuthFilePath)) return undefined;

  const baselineContent = readFileSync(authoritativeAuthFilePath);
  const baselineIdentity = parseCodexAuthIdentity(baselineContent);
  const effectiveAuthFilePath = join(isolatedHomePath, "auth.json");
  let mode: "symlink" | "hardlink";
  try {
    linker.symlink(authoritativeAuthFilePath, effectiveAuthFilePath, "file");
    mode = "symlink";
  } catch (symlinkCause) {
    try {
      linker.link(authoritativeAuthFilePath, effectiveAuthFilePath);
      mode = "hardlink";
    } catch (hardlinkCause) {
      throw new CodexTextGenerationAuthError(
        "Codex auth cannot be mirrored safely; symbolic-link and same-volume hard-link creation both failed.",
        { cause: new AggregateError([symlinkCause, hardlinkCause]) },
      );
    }
  }

  const effectiveLstat = lstatSync(effectiveAuthFilePath);
  const expectedType =
    mode === "symlink" ? effectiveLstat.isSymbolicLink() : effectiveLstat.isFile();
  const authoritativeStat = statSync(authoritativeAuthFilePath);
  const effectiveStat = statSync(effectiveAuthFilePath);
  if (
    !expectedType ||
    authoritativeStat.dev !== effectiveStat.dev ||
    authoritativeStat.ino !== effectiveStat.ino
  ) {
    throw new CodexTextGenerationAuthError(
      `Codex auth ${mode} verification failed; text generation was not started.`,
    );
  }

  return {
    mode,
    authoritativeAuthFilePath,
    effectiveAuthFilePath,
    baselineContent,
    baselineFingerprint: fingerprintAuth(baselineContent),
    baselineIdentity,
  };
}

function preserveAuthArtifact(
  mirror: CodexTextGenerationAuthMirror,
  kind: "recovery" | "detached-candidate",
  content: Buffer,
): string {
  const artifactPath = join(
    dirname(mirror.authoritativeAuthFilePath),
    `.auth.json.synara-${kind}-${Date.now()}-${randomUUID()}`,
  );
  try {
    writeFileSync(artifactPath, content, {
      flag: "wx",
      mode: PRIVATE_FILE_MODE,
    });
    chmodSync(artifactPath, PRIVATE_FILE_MODE);
    return artifactPath;
  } catch (cause) {
    throw new CodexTextGenerationAuthError(
      `Codex auth changed unsafely and its ${kind} file could not be created.`,
      { cause },
    );
  }
}

function preserveAuthRecovery(mirror: CodexTextGenerationAuthMirror): string {
  return preserveAuthArtifact(mirror, "recovery", mirror.baselineContent);
}

function inspectAuthMirrorBinding(mirror: CodexTextGenerationAuthMirror): {
  readonly detached: boolean;
  readonly candidateContent?: Buffer;
} {
  try {
    const effectiveLstat = lstatSync(mirror.effectiveAuthFilePath);
    const expectedType =
      mirror.mode === "symlink" ? effectiveLstat.isSymbolicLink() : effectiveLstat.isFile();
    const authoritativeStat = statSync(mirror.authoritativeAuthFilePath);
    const effectiveStat = statSync(mirror.effectiveAuthFilePath);
    if (
      expectedType &&
      authoritativeStat.dev === effectiveStat.dev &&
      authoritativeStat.ino === effectiveStat.ino
    ) {
      return { detached: false };
    }
  } catch {
    // The typed failure below retains a detached candidate when possible.
  }

  try {
    return { detached: true, candidateContent: readFileSync(mirror.effectiveAuthFilePath) };
  } catch {
    return { detached: true };
  }
}

export function validateCodexTextGenerationAuthAfterRun(
  mirror: CodexTextGenerationAuthMirror | undefined,
  childExecutionSucceeded: boolean,
): void {
  if (!mirror) return;

  const binding = inspectAuthMirrorBinding(mirror);
  if (binding.detached) {
    const recoveryPath = preserveAuthRecovery(mirror);
    let candidatePath: string | undefined;
    if (binding.candidateContent !== undefined) {
      try {
        candidatePath = preserveAuthArtifact(
          mirror,
          "detached-candidate",
          binding.candidateContent,
        );
      } catch (cause) {
        throw new CodexTextGenerationAuthError(
          `Codex replaced or detached its isolated auth link. The authoritative file was left untouched and the previous baseline was saved at ${recoveryPath}, but the detached candidate could not be preserved.`,
          { cause, recoveryPath },
        );
      }
    }
    throw new CodexTextGenerationAuthError(
      candidatePath
        ? `Codex replaced or detached its isolated auth link. The authoritative file was left untouched; the previous baseline was saved at ${recoveryPath} and the detached candidate was saved at ${candidatePath}. Inspect the candidate before changing authoritative auth.`
        : `Codex replaced or detached its isolated auth link. The authoritative file was left untouched; the previous baseline was saved at ${recoveryPath}, and no detached candidate could be read.`,
      { recoveryPath, ...(candidatePath ? { candidatePath } : {}) },
    );
  }

  let currentIdentity: CodexAuthIdentity | undefined;
  let validationDetail: string | undefined;
  try {
    const currentContent = readFileSync(mirror.authoritativeAuthFilePath);
    if (fingerprintAuth(currentContent) === mirror.baselineFingerprint) return;
    currentIdentity = parseCodexAuthIdentity(currentContent);
  } catch {
    validationDetail = "Codex auth became missing or malformed during text generation.";
  }

  if (!validationDetail && !childExecutionSucceeded) {
    validationDetail = "Codex auth changed during a failed or interrupted Codex child execution.";
  }
  if (
    !validationDetail &&
    currentIdentity &&
    (currentIdentity.mode !== mirror.baselineIdentity.mode ||
      currentIdentity.value !== mirror.baselineIdentity.value)
  ) {
    validationDetail = "Codex auth changed account identity during text generation.";
  }
  if (!validationDetail) return;

  const recoveryPath = preserveAuthRecovery(mirror);
  throw new CodexTextGenerationAuthError(
    `${validationDetail} The authoritative file was left untouched; the previous baseline was saved at ${recoveryPath}.`,
    { recoveryPath },
  );
}

export function acquireSecureTempFile(input: {
  readonly directory: string;
  readonly prefix: string;
  readonly content: string;
}) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const filePath = yield* fileSystem.makeTempFileScoped({
      directory: input.directory,
      prefix: input.prefix,
      suffix: ".tmp",
    });
    yield* writePrivateFileString(filePath, input.content);
    return filePath;
  });
}

export function writePrivateFileString(filePath: string, content: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, content, {
      mode: PRIVATE_FILE_MODE,
    });
    yield* fileSystem.chmod(filePath, PRIVATE_FILE_MODE);
  });
}

export function acquireSecureTempDirectory(input: {
  readonly directory: string;
  readonly prefix: string;
}) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directoryPath = yield* fileSystem.makeTempDirectoryScoped(input);
    yield* fileSystem.chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
    return directoryPath;
  });
}

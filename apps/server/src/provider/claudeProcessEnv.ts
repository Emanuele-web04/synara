// FILE: claudeProcessEnv.ts
// Purpose: Builds Claude subprocess environments that prefer valid local Claude CLI OAuth.
// Layer: Provider utility shared by Claude runtime sessions and provider health probes.
// Exports: Claude credentials parsing, path resolution, and env sanitization helpers.
import { readFileSync } from "node:fs";
import OS from "node:os";
import nodePath from "node:path";

const CLAUDE_DIRECT_CREDENTIAL_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

const CLAUDE_EXTERNAL_AUTH_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
] as const;

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function envFlagEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return Boolean(normalized && normalized !== "0" && normalized !== "false");
}

function hasClaudeExternalAuthEnv(env: NodeJS.ProcessEnv): boolean {
  return CLAUDE_EXTERNAL_AUTH_ENV_KEYS.some((key) => envFlagEnabled(env[key]));
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function tryParseJsonRecord(content: string): Record<string, unknown> | undefined {
  try {
    return readRecord(JSON.parse(content));
  } catch {
    return undefined;
  }
}

export function resolveClaudeCredentialsPaths(input?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}): ReadonlyArray<string> {
  const env = input?.env ?? process.env;
  const homeDir = trimToUndefined(input?.homeDir) ?? trimToUndefined(env.HOME) ?? OS.homedir();
  const paths: string[] = [];
  const configDir = trimToUndefined(env.CLAUDE_CONFIG_DIR);
  if (configDir) {
    paths.push(nodePath.join(configDir, ".credentials.json"));
  }
  paths.push(nodePath.join(homeDir, ".claude", ".credentials.json"));
  return [...new Set(paths)];
}

export function hasUsableClaudeCliCredentialsContent(content: string, nowMs = Date.now()): boolean {
  const root = tryParseJsonRecord(content);
  const oauth = readRecord(root?.claudeAiOauth);
  const accessToken = readNonEmptyString(oauth?.accessToken);
  const refreshToken = readNonEmptyString(oauth?.refreshToken);
  if (!accessToken && !refreshToken) {
    return false;
  }

  const expiresAtMs = typeof oauth?.expiresAt === "number" ? oauth.expiresAt : undefined;
  return expiresAtMs === undefined || expiresAtMs > nowMs || refreshToken !== undefined;
}

export function hasUsableClaudeCliCredentials(input?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly nowMs?: number;
  readonly readFile?: (path: string) => string;
}): boolean {
  const readFile = input?.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  return resolveClaudeCredentialsPaths(input).some((path) => {
    try {
      return hasUsableClaudeCliCredentialsContent(readFile(path), input?.nowMs);
    } catch {
      return false;
    }
  });
}

export function buildClaudeProcessEnv(input?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly hasClaudeCliCredentials?: boolean;
}): NodeJS.ProcessEnv {
  const env = { ...(input?.env ?? process.env) };
  const credentialInput = input?.homeDir ? { env, homeDir: input.homeDir } : { env };
  const hasLocalClaudeAuth =
    input?.hasClaudeCliCredentials ?? hasUsableClaudeCliCredentials(credentialInput);

  if (!hasLocalClaudeAuth || hasClaudeExternalAuthEnv(env)) {
    return env;
  }

  // Claude gives direct request credentials precedence over local OAuth. Drop stale
  // app-process keys when a real Claude CLI login can satisfy the subprocess.
  for (const key of CLAUDE_DIRECT_CREDENTIAL_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

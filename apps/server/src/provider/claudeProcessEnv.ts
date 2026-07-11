// FILE: claudeProcessEnv.ts
// Purpose: Detects usable local Claude CLI OAuth credentials for env sanitization decisions.
// Layer: Provider utility shared by Claude runtime sessions and provider health probes.
// Exports: Claude credentials parsing, path resolution, and credential env key sets.
import { readFileSync } from "node:fs";
import OS from "node:os";
import nodePath from "node:path";

export const CLAUDE_DIRECT_CREDENTIAL_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

export const CLAUDE_EXTERNAL_AUTH_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
] as const;

// Claude's provider-specific direct, AWS/Bedrock, Google/Vertex, and
// Azure/Foundry authentication and routing inputs. An explicit provider home
// is an account boundary, so none may fall through from the server account.
export const CLAUDE_ACCOUNT_ISOLATION_ENV_KEYS = [
  ...CLAUDE_DIRECT_CREDENTIAL_ENV_KEYS,
  ...CLAUDE_EXTERNAL_AUTH_ENV_KEYS,
  // Direct Anthropic and gateway identity.
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_WORKSPACE_ID",
  "CLAUDE_CODE_CLIENT_CERT",
  "CLAUDE_CODE_CLIENT_KEY",
  "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
  // Claude Platform on AWS, Bedrock, Mantle, and the AWS credential chain.
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_API_KEY",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_BEDROCK_SERVICE_TIER",
  "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_ACCOUNT_ID",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_AUTH_SCHEME_PREFERENCE",
  "AWS_EC2_METADATA_DISABLED",
  "AWS_EC2_METADATA_IPV4_ADDRESS",
  "AWS_EC2_METADATA_IPV6_ADDRESS",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE",
  "AWS_EC2_METADATA_V1_DISABLED",
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
  "AWS_SDK_LOAD_CONFIG",
  "AWS_SIGV4A_SIGNING_REGION_SET",
  "AWS_USE_DUALSTACK_ENDPOINT",
  "AWS_USE_FIPS_ENDPOINT",
  "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_MANTLE_AUTH",
  // Google Cloud Agent Platform (Vertex) and ADC.
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "CLOUDSDK_CONFIG",
  "GCLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_API_CERTIFICATE_CONFIG",
  "GOOGLE_API_USE_CLIENT_CERTIFICATE",
  "GOOGLE_API_USE_MTLS_ENDPOINT",
  "GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES",
  "GOOGLE_EXTERNAL_ACCOUNT_AUDIENCE",
  "GOOGLE_EXTERNAL_ACCOUNT_IMPERSONATED_EMAIL",
  "GOOGLE_EXTERNAL_ACCOUNT_INTERACTIVE",
  "GOOGLE_EXTERNAL_ACCOUNT_OUTPUT_FILE",
  "GOOGLE_EXTERNAL_ACCOUNT_TOKEN_TYPE",
  "GOOGLE_TOKEN_INFO_URL",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  // Microsoft Foundry and Azure DefaultAzureCredential inputs.
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "AZURE_ADDITIONALLY_ALLOWED_TENANTS",
  "AZURE_AUTHORITY_HOST",
  "AZURE_CLIENT_CERTIFICATE_PASSWORD",
  "AZURE_CLIENT_CERTIFICATE_PATH",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_CLIENT_SEND_CERTIFICATE_CHAIN",
  "AZURE_FEDERATED_TOKEN_FILE",
  "AZURE_IDENTITY_DISABLE_MULTITENANTAUTH",
  "AZURE_PASSWORD",
  "AZURE_POD_IDENTITY_AUTHORITY_HOST",
  "AZURE_REGIONAL_AUTHORITY_NAME",
  "AZURE_REGION_AUTO_DISCOVER_FLAG",
  "AZURE_TENANT_ID",
  "AZURE_TOKEN_CREDENTIALS",
  "AZURE_USERNAME",
  "IDENTITY_ENDPOINT",
  "IDENTITY_HEADER",
  "IDENTITY_SERVER_THUMBPRINT",
  "IMDS_ENDPOINT",
  "MSI_ENDPOINT",
  "MSI_SECRET",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
] as const;

const CLAUDE_ACCOUNT_ISOLATION_ENV_KEY_SET = new Set<string>(CLAUDE_ACCOUNT_ISOLATION_ENV_KEYS);

export function isClaudeAccountIsolationEnvKey(key: string): boolean {
  return (
    CLAUDE_ACCOUNT_ISOLATION_ENV_KEY_SET.has(key) ||
    key.startsWith("AWS_ENDPOINT_URL_") ||
    key.startsWith("VERTEX_REGION_CLAUDE_")
  );
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function envFlagEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return Boolean(normalized && normalized !== "0" && normalized !== "false");
}

export function hasClaudeExternalAuthEnv(env: NodeJS.ProcessEnv): boolean {
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

export interface ClaudeCliCredentialsSummary {
  readonly usable: boolean;
  readonly subscriptionType?: string;
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
  return readClaudeCliCredentialsContentSummary(content, nowMs).usable;
}

export function readClaudeCliCredentialsContentSummary(
  content: string,
  nowMs = Date.now(),
): ClaudeCliCredentialsSummary {
  const root = tryParseJsonRecord(content);
  const oauth = readRecord(root?.claudeAiOauth);
  const accessToken = readNonEmptyString(oauth?.accessToken);
  const refreshToken = readNonEmptyString(oauth?.refreshToken);
  if (!accessToken && !refreshToken) {
    return { usable: false };
  }

  const expiresAtMs = typeof oauth?.expiresAt === "number" ? oauth.expiresAt : undefined;
  const usable = expiresAtMs === undefined || expiresAtMs > nowMs || refreshToken !== undefined;
  const subscriptionType = readNonEmptyString(oauth?.subscriptionType);
  return {
    usable,
    ...(subscriptionType ? { subscriptionType } : {}),
  };
}

export function hasUsableClaudeCliCredentials(input?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly nowMs?: number;
  readonly readFile?: (path: string) => string;
}): boolean {
  return readClaudeCliCredentialsSummary(input).usable;
}

export function readClaudeCliCredentialsSummary(input?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly nowMs?: number;
  readonly readFile?: (path: string) => string;
}): ClaudeCliCredentialsSummary {
  const readFile = input?.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  for (const path of resolveClaudeCredentialsPaths(input)) {
    try {
      const summary = readClaudeCliCredentialsContentSummary(readFile(path), input?.nowMs);
      if (summary.usable) {
        return summary;
      }
    } catch {
      continue;
    }
  }
  return { usable: false };
}

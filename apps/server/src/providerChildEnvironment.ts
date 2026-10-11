// FILE: providerChildEnvironment.ts
// Purpose: Builds provider child environments without Synara control-plane authority.
// Layer: Server provider process security

import { MODEL_PROVIDER_API_KEY_ENV_NAMES } from "./provider/providerProcessEnv.ts";

export type ProviderChildKind =
  | "acp"
  | "antigravity"
  | "claude"
  | "codex"
  | "cursor"
  | "devin"
  | "droid"
  | "grok"
  | "opencode"
  | "opencode-server"
  | "pi"
  | "pi-shell"
  | "omp"
  | "kilo-server"
  | "worktree-setup";

const PROVIDER_CREDENTIAL_KEYS = new Set([
  ...MODEL_PROVIDER_API_KEY_ENV_NAMES,
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "OPENAI_API_KEY",
  "XAI_API_KEY",
  "GROK_CODE_XAI_API_KEY",
  "FACTORY_API_KEY",
  "CURSOR_API_KEY",
  "DEVIN_API_KEY",
  "WINDSURF_API_KEY",
  "DOCKER_AUTH_CONFIG",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
]);

const PROVIDER_CREDENTIAL_SUFFIXES = [
  "_ACCESS_TOKEN",
  "_API_KEY",
  "_API_TOKEN",
  "_AUTH_TOKEN",
  "_BEARER_TOKEN",
  "_CLIENT_SECRET",
] as const;

export function registerProviderCredentialKey(key: string): void {
  const normalized = key.trim().toUpperCase();
  if (/^[A-Z0-9_.-]+$/u.test(normalized)) {
    PROVIDER_CREDENTIAL_KEYS.add(normalized);
  }
}

export function isProviderCredentialKey(key: string): boolean {
  const normalized = key.trim().toUpperCase();
  return (
    PROVIDER_CREDENTIAL_KEYS.has(normalized) ||
    PROVIDER_CREDENTIAL_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

/** Removes ambient provider credentials while retaining ordinary process state. */
export function withoutProviderCredentialEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !isProviderCredentialKey(key)));
}

const PROVIDER_CREDENTIAL_GRANTS: Record<ProviderChildKind, "all" | ReadonlySet<string>> = {
  antigravity: new Set(["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"]),
  claude: new Set([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "GOOGLE_APPLICATION_CREDENTIALS",
  ]),
  cursor: new Set(["CURSOR_API_KEY"]),
  devin: new Set(["DEVIN_API_KEY", "WINDSURF_API_KEY"]),
  droid: new Set(["FACTORY_API_KEY"]),
  grok: new Set(["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"]),
  // Generic ACP startup receives only credentials explicitly granted by its caller.
  acp: new Set(),
  // Codex receives OpenAI or its active custom provider credential explicitly.
  codex: new Set(),
  // Server daemons discover arbitrary upstream providers; short-lived probes do not.
  opencode: new Set(),
  pi: new Set(),
  omp: "all",
  "opencode-server": "all",
  "kilo-server": "all",
  // Commands launched by model runtimes and repository setup are separate boundaries.
  "pi-shell": new Set(),
  "worktree-setup": new Set(),
};

export function providerCredentialKeysFor(provider: ProviderChildKind): readonly string[] {
  const grants = PROVIDER_CREDENTIAL_GRANTS[provider];
  return [...(grants === "all" ? PROVIDER_CREDENTIAL_KEYS : grants)];
}

const INHERITED_NATIVE_CAPABILITY_KEYS = new Set([
  "BUN_OPTIONS",
  "ELECTRON_RUN_AS_NODE",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS",
]);

export function buildProviderChildEnvironment(input: {
  readonly provider: ProviderChildKind;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly inheritedSynaraKeys?: ReadonlyArray<string>;
  readonly inheritedNativeCapabilityKeys?: ReadonlyArray<string>;
  readonly additionalCredentialKeys?: ReadonlyArray<string>;
  readonly overrides?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const baseEnv = {
    ...(input.baseEnv ?? process.env),
    ...input.overrides,
  };
  const allowedSynaraKeys = new Set(
    (input.inheritedSynaraKeys ?? []).map((key) => key.toUpperCase()),
  );
  const allowedNativeCapabilities = new Set(
    (input.inheritedNativeCapabilityKeys ?? []).map((key) => key.toUpperCase()),
  );
  const credentialGrants = PROVIDER_CREDENTIAL_GRANTS[input.provider];
  const additionalCredentialGrants = new Set(
    (input.additionalCredentialKeys ?? []).map((key) => key.trim().toUpperCase()),
  );
  const childEnv: NodeJS.ProcessEnv = {};
  const hasTruthyVitest = Boolean(
    Object.entries(baseEnv).find(([envKey]) => envKey.toUpperCase() === "VITEST")?.[1],
  );

  for (const [key, value] of Object.entries(baseEnv)) {
    const normalizedKey = key.toUpperCase();
    if (
      normalizedKey.startsWith("SYNARA_") &&
      !allowedSynaraKeys.has(normalizedKey) &&
      !(
        hasTruthyVitest &&
        (normalizedKey.startsWith("SYNARA_FAKE_") || normalizedKey.startsWith("SYNARA_ACP_"))
      )
    ) {
      continue;
    }
    if (
      INHERITED_NATIVE_CAPABILITY_KEYS.has(normalizedKey) &&
      !allowedNativeCapabilities.has(normalizedKey)
    ) {
      continue;
    }
    if (
      isProviderCredentialKey(key) &&
      credentialGrants !== "all" &&
      !credentialGrants.has(normalizedKey) &&
      !additionalCredentialGrants.has(normalizedKey)
    ) {
      continue;
    }
    childEnv[key] = value;
  }

  return childEnv;
}

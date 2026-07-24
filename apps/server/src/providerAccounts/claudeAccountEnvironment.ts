// FILE: claudeAccountEnvironment.ts
// Purpose: Claude managed-account environment builder (plan section 8.2).
// Layer: Server service internals
// Exports: buildClaudeAccountEnvironment (also self-registers for "claudeAgent").

import {
  ACCOUNT_ENV_UNSET,
  registerAccountEnvironmentBuilder,
  type AccountEnvironmentBuildInput,
  type AccountLaunchEnvironment,
} from "./accountEnvironment";

// Inherited auth overrides that would leak the native account (or reroute
// requests through Bedrock/Vertex/custom gateways) into a managed launch.
// Stripped before account-specific values are applied.
const CLAUDE_CONFLICTING_ENV_VARS = [
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
] as const;

export function buildClaudeAccountEnvironment(
  input: AccountEnvironmentBuildInput,
): AccountLaunchEnvironment {
  const environment: Record<string, string> = {};
  for (const name of CLAUDE_CONFLICTING_ENV_VARS) {
    environment[name] = ACCOUNT_ENV_UNSET;
  }
  environment.CLAUDE_CONFIG_DIR = input.agentHome;
  if (input.authMethod === "apiKey" && input.apiKey !== undefined) {
    environment.ANTHROPIC_API_KEY = input.apiKey;
  }
  // OAuth accounts authenticate through CLAUDE_CONFIG_DIR/.credentials.json
  // (the file credential store inside the account agent home). The Claude
  // desktop app binding is OAuth/browser-based and separate from this agent
  // environment; the app launch path ships with the desktop app work (PR7).
  return { environment, profilePath: input.agentHome };
}

registerAccountEnvironmentBuilder("claudeAgent", buildClaudeAccountEnvironment);

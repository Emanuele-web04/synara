import {
  ACCOUNT_ENV_UNSET,
  type AccountEnvironmentBuildInput,
  type AccountLaunchEnvironment,
} from "./accountEnvironment";

import { CLAUDE_ACCOUNT_ISOLATION_ENV_KEYS } from "../claudeAccountIsolation";

export function buildClaudeAccountEnvironment(
  input: AccountEnvironmentBuildInput,
): AccountLaunchEnvironment {
  const environment: Record<string, string> = {};
  for (const name of CLAUDE_ACCOUNT_ISOLATION_ENV_KEYS) {
    environment[name] = ACCOUNT_ENV_UNSET;
  }
  // Managed desktop launch is capability-gated; this path only defines its
  // storage layout. Agent launches also isolate fallback home/keychain paths.
  const configDir = input.surface === "app" ? input.appDataDir : input.agentHome;
  environment.HOME = configDir;
  environment.CLAUDE_CONFIG_DIR = configDir;
  environment.CLAUDE_SECURESTORAGE_CONFIG_DIR = configDir;
  if (input.surface === "agent" && input.authMethod === "apiKey" && input.apiKey !== undefined) {
    environment.ANTHROPIC_API_KEY = input.apiKey;
  }
  // OAuth accounts authenticate through CLAUDE_CONFIG_DIR/.credentials.json
  // (the file credential store inside the isolated config dir).
  return { environment, profilePath: configDir };
}

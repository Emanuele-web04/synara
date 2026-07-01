// FILE: claudeEnvironment.ts
// Purpose: Builds Claude CLI environments for account-isolated provider instances while
//          preferring valid local Claude CLI OAuth over inherited request credentials.
// Layer: Provider runtime utility
// Exports: claudeHomeEnvironment, buildClaudeProcessEnv

import * as NodePath from "node:path";

import {
  CLAUDE_DIRECT_CREDENTIAL_ENV_KEYS,
  hasClaudeExternalAuthEnv,
  hasUsableClaudeCliCredentials,
} from "./claudeProcessEnv.ts";

export function claudeHomeEnvironment(
  homePath: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const homeEnvironment: NodeJS.ProcessEnv = { HOME: homePath };
  if (platform !== "win32") {
    return homeEnvironment;
  }

  // Claude can read Windows profile directories outside HOME, so mirror the
  // selected provider-instance home across the profile environment variables.
  const appDataRoot = NodePath.win32.join(homePath, "AppData");
  const parsed = NodePath.win32.parse(homePath);
  return {
    ...homeEnvironment,
    USERPROFILE: homePath,
    APPDATA: NodePath.win32.join(appDataRoot, "Roaming"),
    LOCALAPPDATA: NodePath.win32.join(appDataRoot, "Local"),
    ...(parsed.root.match(/^[A-Za-z]:\\$/)
      ? {
          HOMEDRIVE: parsed.root.slice(0, 2),
          HOMEPATH: homePath.slice(2) || "\\",
        }
      : {}),
  };
}

export function buildClaudeProcessEnv(input?: {
  readonly homePath?: string | null | undefined;
  readonly environment?: Readonly<Record<string, string>> | undefined;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string | undefined;
  readonly hasClaudeCliCredentials?: boolean;
}): NodeJS.ProcessEnv {
  const trimmedHomePath = input?.homePath?.trim();
  const env: NodeJS.ProcessEnv = { ...(input?.env ?? process.env) };
  if (input?.environment) {
    Object.assign(env, input.environment);
  }
  if (trimmedHomePath) {
    Object.assign(env, claudeHomeEnvironment(trimmedHomePath));
  }

  // Credentials live in the selected instance home when one is configured;
  // otherwise fall back to the caller-provided server home / env HOME.
  const credentialsHomeDir = trimmedHomePath ?? input?.homeDir;
  const hasLocalClaudeAuth =
    input?.hasClaudeCliCredentials ??
    hasUsableClaudeCliCredentials(
      credentialsHomeDir ? { env, homeDir: credentialsHomeDir } : { env },
    );

  if (!hasLocalClaudeAuth || hasClaudeExternalAuthEnv(env)) {
    return env;
  }

  // Claude gives direct request credentials precedence over local OAuth. Drop stale
  // inherited keys when a real Claude CLI login can satisfy the subprocess, but keep
  // credentials the provider instance sets explicitly.
  for (const key of CLAUDE_DIRECT_CREDENTIAL_ENV_KEYS) {
    if (input?.environment && key in input.environment) {
      continue;
    }
    delete env[key];
  }
  return env;
}

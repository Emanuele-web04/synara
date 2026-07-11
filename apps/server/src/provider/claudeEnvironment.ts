// FILE: claudeEnvironment.ts
// Purpose: Builds Claude CLI environments for account-isolated provider instances while
//          preferring valid local Claude CLI OAuth over inherited request credentials.
// Layer: Provider runtime utility
// Exports: claudeHomeEnvironment, buildClaudeProcessEnv

import * as NodePath from "node:path";
import { homedir } from "node:os";

import {
  CLAUDE_DIRECT_CREDENTIAL_ENV_KEYS,
  hasClaudeExternalAuthEnv,
  hasUsableClaudeCliCredentials,
  isClaudeAccountIsolationEnvKey,
} from "./claudeProcessEnv.ts";
import { expandProviderAccountHomePath } from "../providerAccountHomePath.ts";

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
  const resolvedHomePath = trimmedHomePath
    ? expandProviderAccountHomePath(trimmedHomePath, input?.homeDir ?? homedir())
    : undefined;
  const env: NodeJS.ProcessEnv = { ...(input?.env ?? process.env) };
  // Align the subprocess HOME with the credential home being checked so Claude
  // reads the same login state the health/session gate validated. Instance
  // environment overrides and instance homes still win below.
  if (input?.homeDir) {
    env.HOME = input.homeDir;
  }

  // An explicit provider home or environment selects a distinct account
  // boundary. Remove account-scoped ambient values first, then overlay only
  // values deliberately supplied by the selected instance below.
  if (resolvedHomePath || input?.environment !== undefined) {
    for (const key of Object.keys(env)) {
      if (isClaudeAccountIsolationEnvKey(key)) {
        delete env[key];
      }
    }
  }
  if (input?.environment) {
    Object.assign(env, input.environment);
  }
  if (resolvedHomePath) {
    Object.assign(env, claudeHomeEnvironment(resolvedHomePath));
    // An inherited config directory takes precedence over HOME in Claude's
    // credential lookup. Do not let the server account leak into an instance
    // with an explicit home unless that instance deliberately configured it.
    if (!input?.environment || !("CLAUDE_CONFIG_DIR" in input.environment)) {
      delete env.CLAUDE_CONFIG_DIR;
    }
  }

  // Credentials live in the selected instance home when one is configured;
  // otherwise use the final overlaid HOME before the caller's server home.
  const credentialsHomeDir = resolvedHomePath ?? env.HOME ?? input?.homeDir;
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

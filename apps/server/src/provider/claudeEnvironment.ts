// FILE: claudeEnvironment.ts
// Purpose: Builds Claude CLI environments for account-isolated provider instances while
//          preferring valid local Claude CLI OAuth over inherited request credentials.
// Layer: Provider runtime utility
// Exports: claudeIsolatedHomePath, claudeHomeEnvironment, buildClaudeProcessEnv

import * as NodePath from "node:path";
import { homedir } from "node:os";

import { defaultInstanceIdForDriver } from "@synara/contracts";

import {
  CLAUDE_DIRECT_CREDENTIAL_ENV_KEYS,
  hasClaudeExternalAuthEnv,
  hasUsableClaudeCliCredentials,
  isClaudeAccountIsolationEnvKey,
} from "./claudeProcessEnv.ts";
import { expandProviderAccountHomePath } from "../providerAccountHomePath.ts";

const DEFAULT_CLAUDE_INSTANCE_ID = defaultInstanceIdForDriver("claudeAgent");
const FALLBACK_CLAUDE_INSTANCE_SCOPE = "environment-only";
const WINDOWS_PROFILE_ENV_KEYS = [
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
] as const;

function normalizeEnvironmentKeys(
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  if (platform !== "win32") {
    return { ...environment };
  }

  // A plain object loses process.env's Windows case-insensitive lookup. Collapse
  // every spelling to one canonical key before inspecting or overlaying it so a
  // later selected-instance value wins deterministically and no ambient alias is
  // passed to child_process beside the canonical entry.
  const normalized: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    normalized[name.toUpperCase()] = value;
  }
  return normalized;
}

function claudeInstanceHomeScope(providerInstanceId: string | undefined): string {
  const normalizedInstanceId = providerInstanceId?.trim();
  return normalizedInstanceId
    ? `instance-${Buffer.from(normalizedInstanceId, "utf8").toString("hex")}`
    : FALLBACK_CLAUDE_INSTANCE_SCOPE;
}

export function claudeIsolatedHomePath(input: {
  readonly isolationRootDir?: string | undefined;
  readonly homeDir?: string | undefined;
  readonly providerInstanceId?: string | undefined;
}): string {
  // Production callers provide Synara's stateDir. The fallback keeps direct or
  // legacy callers fail-closed under a deterministic, non-secret path instead
  // of silently sending Claude back to the ambient account home.
  const isolationRoot =
    input.isolationRootDir?.trim() ||
    NodePath.join(input.homeDir?.trim() || homedir(), ".synara", "userdata");
  return NodePath.resolve(
    isolationRoot,
    "provider-homes",
    "claude",
    claudeInstanceHomeScope(input.providerInstanceId),
  );
}

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
  readonly isolationRootDir?: string | undefined;
  readonly providerInstanceId?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly hasClaudeCliCredentials?: boolean;
}): NodeJS.ProcessEnv {
  const platform = input?.platform ?? process.platform;
  const selectedEnvironment =
    input?.environment === undefined
      ? undefined
      : normalizeEnvironmentKeys(input.environment, platform);
  const env = normalizeEnvironmentKeys(input?.env ?? process.env, platform);
  const trimmedHomePath = input?.homePath?.trim();
  const resolvedHomePath = trimmedHomePath
    ? expandProviderAccountHomePath(trimmedHomePath, input?.homeDir ?? homedir())
    : undefined;
  const explicitEnvironmentHome =
    selectedEnvironment?.HOME?.trim() ||
    (platform === "win32" ? selectedEnvironment?.USERPROFILE?.trim() : undefined);
  const resolvedEnvironmentHomePath = explicitEnvironmentHome
    ? expandProviderAccountHomePath(explicitEnvironmentHome, input?.homeDir ?? homedir())
    : undefined;
  const providerInstanceId = input?.providerInstanceId?.trim();
  const needsIsolatedInstanceHome =
    resolvedHomePath === undefined &&
    resolvedEnvironmentHomePath === undefined &&
    (selectedEnvironment !== undefined ||
      (providerInstanceId !== undefined && providerInstanceId !== DEFAULT_CLAUDE_INSTANCE_ID));
  const effectiveHomePath =
    resolvedHomePath ??
    resolvedEnvironmentHomePath ??
    (needsIsolatedInstanceHome
      ? claudeIsolatedHomePath({
          isolationRootDir: input?.isolationRootDir,
          homeDir: input?.homeDir,
          providerInstanceId,
        })
      : undefined);
  // Align the subprocess HOME with the credential home being checked so Claude
  // reads the same login state the health/session gate validated. Instance
  // environment overrides and instance homes still win below.
  if (input?.homeDir) {
    env.HOME = input.homeDir;
  }

  // An explicit provider home, environment, or non-default instance selects a
  // distinct account boundary. Remove ambient account values first, then
  // overlay only values deliberately supplied by the selected instance below.
  if (effectiveHomePath || selectedEnvironment !== undefined) {
    for (const key of Object.keys(env)) {
      if (isClaudeAccountIsolationEnvKey(key)) {
        delete env[key];
      }
    }
  }
  if (selectedEnvironment) {
    Object.assign(env, selectedEnvironment);
  }
  if (effectiveHomePath) {
    Object.assign(env, claudeHomeEnvironment(effectiveHomePath, platform));
    if (!resolvedHomePath && selectedEnvironment) {
      // HOME/USERPROFILE can themselves be the deliberate external account
      // boundary. Normalize the selected root, while retaining any other
      // explicitly supplied Windows profile routes instead of replacing them
      // with generated defaults for the synthetic home.
      if (selectedEnvironment.HOME?.trim()) {
        env.HOME = resolvedEnvironmentHomePath;
      }
      if (platform === "win32") {
        for (const key of WINDOWS_PROFILE_ENV_KEYS) {
          if (!(key in selectedEnvironment)) {
            continue;
          }
          const profileValue = selectedEnvironment[key];
          if (key === "USERPROFILE" && profileValue?.trim()) {
            env[key] = expandProviderAccountHomePath(profileValue, input?.homeDir ?? homedir());
            continue;
          }
          env[key] = profileValue;
        }
      }
    }
    // An inherited config directory takes precedence over HOME in Claude's
    // credential lookup. Do not let the server account leak into an instance
    // with an explicit home unless that instance deliberately configured it.
    if (!selectedEnvironment || !("CLAUDE_CONFIG_DIR" in selectedEnvironment)) {
      delete env.CLAUDE_CONFIG_DIR;
    }
  }

  // Credentials live in the selected instance home when one is configured;
  // otherwise use the final overlaid HOME before the caller's server home.
  const credentialsHomeDir = effectiveHomePath ?? env.HOME ?? input?.homeDir;
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
    if (selectedEnvironment && key in selectedEnvironment) {
      continue;
    }
    delete env[key];
  }
  return env;
}

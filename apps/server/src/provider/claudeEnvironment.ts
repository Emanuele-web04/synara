// FILE: claudeEnvironment.ts
// Purpose: Builds Claude CLI environments for account-isolated provider instances.
// Layer: Provider runtime utility
// Exports: claudeHomeEnvironment, buildClaudeInstanceProcessEnv

import * as NodePath from "node:path";
import { homedir } from "node:os";

import { defaultInstanceIdForDriver } from "@synara/contracts";

import { expandProviderAccountHomePath } from "../providerAccountHomePath.ts";
import {
  buildClaudeProcessEnv,
  isClaudeAccountIsolationEnvKey,
} from "./claudeProcessEnv.ts";

const DEFAULT_CLAUDE_INSTANCE_ID = defaultInstanceIdForDriver("claudeAgent");
const FALLBACK_CLAUDE_INSTANCE_SCOPE = "environment-only";
const WINDOWS_PROFILE_ENV_KEYS = [
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
] as const;

function claudeInstanceHomeScope(providerInstanceId: string | undefined): string {
  const normalizedInstanceId = providerInstanceId?.trim();
  return normalizedInstanceId
    ? `instance-${Buffer.from(normalizedInstanceId, "utf8").toString("hex")}`
    : FALLBACK_CLAUDE_INSTANCE_SCOPE;
}

export function claudeIsolatedHomePath(input: {
  readonly isolationRootDir?: string;
  readonly homeDir?: string;
  readonly providerInstanceId?: string;
}): string {
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

export function buildClaudeInstanceProcessEnv(
  homePath: string | null | undefined,
  environment?: Readonly<Record<string, string>> | undefined,
  options?: {
    readonly homeDir?: string;
    readonly isolationRootDir?: string;
    readonly providerInstanceId?: string;
    readonly platform?: NodeJS.Platform;
  },
): NodeJS.ProcessEnv {
  const platform = options?.platform ?? process.platform;
  const trimmedHomePath = homePath?.trim();
  const resolvedHomePath = trimmedHomePath
    ? expandProviderAccountHomePath(trimmedHomePath, options?.homeDir ?? homedir())
    : undefined;
  const explicitEnvironmentHome =
    environment?.HOME?.trim() ||
    (platform === "win32" ? environment?.USERPROFILE?.trim() : undefined);
  const resolvedEnvironmentHomePath = explicitEnvironmentHome
    ? expandProviderAccountHomePath(explicitEnvironmentHome, options?.homeDir ?? homedir())
    : undefined;
  const providerInstanceId = options?.providerInstanceId?.trim();
  const needsIsolatedInstanceHome =
    resolvedHomePath === undefined &&
    resolvedEnvironmentHomePath === undefined &&
    (environment !== undefined ||
      (providerInstanceId !== undefined && providerInstanceId !== DEFAULT_CLAUDE_INSTANCE_ID));
  const effectiveHomePath =
    resolvedHomePath ??
    resolvedEnvironmentHomePath ??
    (needsIsolatedInstanceHome
      ? claudeIsolatedHomePath({
          ...(options?.isolationRootDir ? { isolationRootDir: options.isolationRootDir } : {}),
          ...(options?.homeDir ? { homeDir: options.homeDir } : {}),
          ...(providerInstanceId ? { providerInstanceId } : {}),
        })
      : undefined);
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!effectiveHomePath && options?.homeDir) {
    env.HOME = options.homeDir;
  }
  // An explicit provider home or environment selects a distinct account
  // boundary. Remove account-scoped ambient values first, then overlay only
  // values deliberately supplied by the selected instance.
  if (effectiveHomePath || environment !== undefined) {
    for (const key of Object.keys(env)) {
      if (isClaudeAccountIsolationEnvKey(key)) {
        delete env[key];
      }
    }
  }
  if (environment) {
    Object.assign(env, environment);
  }
  if (effectiveHomePath) {
    Object.assign(env, claudeHomeEnvironment(effectiveHomePath, platform));
    if (!resolvedHomePath && environment) {
      if (environment.HOME?.trim()) {
        env.HOME = resolvedEnvironmentHomePath;
      }
      if (platform === "win32") {
        for (const key of WINDOWS_PROFILE_ENV_KEYS) {
          if (!(key in environment)) continue;
          if (key === "USERPROFILE" && environment[key]?.trim()) {
            env[key] = expandProviderAccountHomePath(
              environment[key],
              options?.homeDir ?? homedir(),
            );
          } else {
            env[key] = environment[key];
          }
        }
      }
    }
  }
  if (effectiveHomePath) {
    if (!environment || !("CLAUDE_CONFIG_DIR" in environment)) {
      delete env.CLAUDE_CONFIG_DIR;
    }
  }
  return buildClaudeProcessEnv({
    env,
    ...(effectiveHomePath
      ? { homeDir: effectiveHomePath }
      : options?.homeDir
        ? { homeDir: options.homeDir }
        : {}),
    preserveDirectCredentialKeys: new Set(Object.keys(environment ?? {})),
  });
}

// FILE: claudeEnvironment.ts
// Purpose: Builds Claude CLI environments for account-isolated provider instances.
// Layer: Provider runtime utility
// Exports: claudeHomeEnvironment, buildClaudeInstanceProcessEnv

import * as NodePath from "node:path";

import { expandProviderAccountHomePath } from "../providerAccountHomePath.ts";
import {
  buildClaudeProcessEnv,
  isClaudeAccountIsolationEnvKey,
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

export function buildClaudeInstanceProcessEnv(
  homePath: string | null | undefined,
  environment?: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const trimmedHomePath = homePath?.trim();
  const resolvedHomePath = trimmedHomePath
    ? expandProviderAccountHomePath(trimmedHomePath)
    : undefined;
  const env: NodeJS.ProcessEnv = { ...process.env };
  // An explicit provider home or environment selects a distinct account
  // boundary. Remove account-scoped ambient values first, then overlay only
  // values deliberately supplied by the selected instance.
  if (resolvedHomePath || environment !== undefined) {
    for (const key of Object.keys(env)) {
      if (isClaudeAccountIsolationEnvKey(key)) {
        delete env[key];
      }
    }
  }
  if (environment) {
    Object.assign(env, environment);
  }
  if (resolvedHomePath) {
    Object.assign(env, claudeHomeEnvironment(resolvedHomePath));
  }
  if (resolvedHomePath) {
    if (!environment || !("CLAUDE_CONFIG_DIR" in environment)) {
      delete env.CLAUDE_CONFIG_DIR;
    }
  }
  return buildClaudeProcessEnv({
    env,
    ...(resolvedHomePath ? { homeDir: resolvedHomePath } : {}),
    preserveDirectCredentialKeys: new Set(Object.keys(environment ?? {})),
  });
}

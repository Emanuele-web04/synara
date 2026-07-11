// FILE: claudeEnvironment.ts
// Purpose: Builds Claude CLI environments for account-isolated provider instances.
// Layer: Provider runtime utility
// Exports: claudeHomeEnvironment, buildClaudeInstanceProcessEnv

import * as NodePath from "node:path";

import { expandProviderAccountHomePath } from "../providerAccountHomePath.ts";
import {
  buildClaudeProcessEnv,
  CLAUDE_DIRECT_CREDENTIAL_ENV_KEYS,
  CLAUDE_EXTERNAL_AUTH_ENV_KEYS,
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
  const env = {
    ...process.env,
    ...(environment ?? {}),
    ...(resolvedHomePath ? claudeHomeEnvironment(resolvedHomePath) : {}),
  };
  if (resolvedHomePath) {
    if (!environment || !("CLAUDE_CONFIG_DIR" in environment)) {
      delete env.CLAUDE_CONFIG_DIR;
    }
    // An explicit provider home selects a distinct account boundary. Ambient
    // credentials and backend-routing flags belong to the server account and
    // must never select it instead. Instance-provided values remain authoritative.
    for (const key of [...CLAUDE_DIRECT_CREDENTIAL_ENV_KEYS, ...CLAUDE_EXTERNAL_AUTH_ENV_KEYS]) {
      if (!environment || !(key in environment)) {
        delete env[key];
      }
    }
  }
  return buildClaudeProcessEnv({
    env,
    ...(resolvedHomePath ? { homeDir: resolvedHomePath } : {}),
    preserveDirectCredentialKeys: new Set(Object.keys(environment ?? {})),
  });
}

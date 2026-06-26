// FILE: claudeEnvironment.ts
// Purpose: Builds Claude CLI environments for account-isolated provider instances.
// Layer: Provider runtime utility
// Exports: claudeHomeEnvironment, buildClaudeProcessEnv

import * as NodePath from "node:path";

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

export function buildClaudeProcessEnv(
  homePath: string | null | undefined,
  environment?: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const trimmedHomePath = homePath?.trim();
  const env = { ...process.env };
  if (environment) {
    Object.assign(env, environment);
  }
  if (trimmedHomePath) {
    Object.assign(env, claudeHomeEnvironment(trimmedHomePath));
  }
  return env;
}

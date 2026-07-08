// FILE: desktopUserDataProfile.ts
// Purpose: Resolves Synara's Electron userData profile paths.

import * as OS from "node:os";
import * as Path from "node:path";

const DEV_USER_DATA_DIR_NAME = "synara-dev";
const PROD_USER_DATA_DIR_NAME = "synara";

export function resolveDesktopAppDataBase(input?: {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}): string {
  const platform = input?.platform ?? process.platform;
  const env = input?.env ?? process.env;
  const homeDir = input?.homeDir ?? OS.homedir();

  if (platform === "win32") {
    return env.APPDATA || Path.join(homeDir, "AppData", "Roaming");
  }
  if (platform === "darwin") {
    return Path.join(homeDir, "Library", "Application Support");
  }
  return env.XDG_CONFIG_HOME || Path.join(homeDir, ".config");
}

export function resolveDesktopUserDataPath(input: {
  readonly appDataBase: string;
  readonly isDevelopment: boolean;
}): string {
  return Path.join(
    input.appDataBase,
    input.isDevelopment ? DEV_USER_DATA_DIR_NAME : PROD_USER_DATA_DIR_NAME,
  );
}

import * as OS from "node:os";
import * as Path from "node:path";

export const SYNARA_HOME_ENV_NAME = "SYNARA_HOME";
export const DEFAULT_SYNARA_HOME_DIRECTORY_NAME = ".synara";

export function expandHomePath(input: string, homeDirectory: string = OS.homedir()): string {
  if (input === "~") {
    return homeDirectory;
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return Path.join(homeDirectory, input.slice(2));
  }
  return input;
}

/** deliberately plain Node — the Electron main process needs this before Effect/app.whenReady, and the env cache must land in the same place whichever process wrote it first */
export function resolveSynaraHomeDirectory(
  options: {
    readonly configuredHome?: string | undefined;
    readonly env?: NodeJS.ProcessEnv;
    readonly homeDirectory?: string;
    /** flavor-specific default (.synara-canary), used only when nothing is configured */
    readonly directoryName?: string;
  } = {},
): string {
  const homeDirectory = options.homeDirectory ?? OS.homedir();
  const configured = (
    options.configuredHome ?? (options.env ?? process.env)[SYNARA_HOME_ENV_NAME]
  )?.trim();
  if (!configured) {
    return Path.join(homeDirectory, options.directoryName ?? DEFAULT_SYNARA_HOME_DIRECTORY_NAME);
  }
  return Path.resolve(expandHomePath(configured, homeDirectory));
}

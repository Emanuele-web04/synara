/** Seatbelt confinement for the helper — it dlopens private frameworks and injects HID with no need for user files or network; single place applying the profile so the RPC process and --probe run confined identically; parameters resolved at spawn because they move per machine */
import { access, realpath } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";

/** set to skip confinement entirely; logged loudly wherever honoured */
export const SANDBOX_OPT_OUT_ENV = "SYNARA_DEVICE_HELPER_NO_SANDBOX";

export const SANDBOX_PROFILE_NAME = "device-helper.sb";

export interface HelperSandboxContext {
  /** the helper binary about to be run */
  readonly binaryPath: string;
  /** absolute path to `apps/server/native/device-helper` */
  readonly helperSourceDir: string;
  /** `DEVELOPER_DIR` resolved the way the helper resolves it */
  readonly developerDir: string | null;
  readonly env?: NodeJS.ProcessEnv;
}

export interface HelperSandboxCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** null when unconfined, for the message that says so */
  readonly profilePath: string | null;
}

/** `DEVELOPER_DIR` points at `Xcode.app/Contents/Developer` but the helper mmaps frameworks across the bundle — the profile must cover the `.app`; CLT has no enclosing bundle so `/Library/Developer` in the profile covers it */
export function xcodeAppRoot(developerDir: string): string {
  const marker = `${path.sep}Contents${path.sep}Developer`;
  const index = developerDir.indexOf(marker);
  return index === -1 ? developerDir : developerDir.slice(0, index);
}

/** Seatbelt matches the real path and these are routinely symlinks ($TMPDIR → /private/var/folders/...) — unresolved parameters match nothing and deny silently; missing paths returned as-is */
async function resolved(target: string): Promise<string> {
  return await realpath(target).catch(() => target);
}

/** whether the opt-out is set in the environment governing this run */
export function sandboxDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[SANDBOX_OPT_OUT_ENV]?.trim();
  return value !== undefined && value.length > 0 && value !== "0" && value !== "false";
}

/** falls back to unconfined when the profile is missing rather than refusing to start — a packaging mistake costs the confinement, not the feature; `profilePath` null so a later timeout can tell the two apart */
export async function sandboxedHelperCommand(
  argv: readonly string[],
  context: HelperSandboxContext,
): Promise<HelperSandboxCommand> {
  const [command, ...args] = argv;
  if (command === undefined) throw new Error("sandboxedHelperCommand needs a command");
  const plain: HelperSandboxCommand = { command, args, profilePath: null };

  if (process.platform !== "darwin") return plain;
  if (sandboxDisabled(context.env ?? process.env)) return plain;

  const profilePath = path.join(context.helperSourceDir, SANDBOX_PROFILE_NAME);
  const readable = await access(profilePath, fsConstants.R_OK).then(
    () => true,
    () => false,
  );
  if (!readable) return plain;

  const home = homedir();
  const [helperBundle, userHome, coreSimHome, coreSimLogs, darwinTmp, xcodeApp] = await Promise.all(
    [
      resolved(path.dirname(context.binaryPath)),
      resolved(home),
      resolved(path.join(home, "Library", "Developer", "CoreSimulator")),
      resolved(path.join(home, "Library", "Logs", "CoreSimulator")),
      resolved(tmpdir()),
      // no developer dir yet still needs a syntactically valid parameter — the run fails on its own terms rather than on the profile
      resolved(xcodeAppRoot(context.developerDir ?? "/Applications/Xcode.app")),
    ],
  );

  return {
    command: "/usr/bin/sandbox-exec",
    args: [
      "-f",
      profilePath,
      "-D",
      `HELPER_BUNDLE=${helperBundle}`,
      "-D",
      `USER_HOME=${userHome}`,
      "-D",
      `CORESIM_HOME=${coreSimHome}`,
      "-D",
      `CORESIM_LOGS=${coreSimLogs}`,
      "-D",
      `DARWIN_TMP=${darwinTmp}`,
      "-D",
      `XCODE_APP=${xcodeApp}`,
      command,
      ...args,
    ],
    profilePath,
  };
}

/** a denied rule does not raise — CoreSimulator swallows it and the helper never answers, looking exactly like a hang; a timeout under confinement must name the sandbox and the way out */
export function describeSandboxSuspicion(profilePath: string | null): string {
  if (profilePath === null) return "";
  return (
    ` The helper runs under the Seatbelt profile at ${profilePath}, and a missing rule there` +
    ` stalls it instead of erroring. Set ${SANDBOX_OPT_OUT_ENV}=1 to run it unconfined and` +
    ` confirm whether the profile is the cause.`
  );
}

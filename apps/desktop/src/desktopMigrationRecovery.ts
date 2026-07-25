// FILE: desktopMigrationRecovery.ts
// Purpose: Detects pending desktop migration recovery and invokes the server-owned restore CLI.
// Layer: Desktop startup utility

import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";
import { promisify } from "node:util";
import {
  migrationRecoveryMarkerPath,
  parseMigrationRecoveryResumeState,
} from "@synara/shared/migrationRecovery";

const execFile = promisify(ChildProcess.execFile);
const RECOVERY_OUTPUT_LIMIT_BYTES = 64 * 1024;

export interface DesktopMigrationRecoveryPaths {
  readonly dbPath: string;
  readonly markerPath: string;
  readonly restoreEntryPath: string;
}

export function resolveDesktopMigrationRecoveryPaths(input: {
  readonly baseDir: string;
  readonly appRoot: string;
  readonly isDevelopment: boolean;
}): DesktopMigrationRecoveryPaths {
  const stateDir = Path.join(input.baseDir, input.isDevelopment ? "dev" : "userdata");
  const dbPath = Path.join(stateDir, "state.sqlite");
  return {
    dbPath,
    markerPath: migrationRecoveryMarkerPath(dbPath),
    restoreEntryPath: Path.join(input.appRoot, "apps/server/dist/restoreMigrationBackup.mjs"),
  };
}

export type DesktopMigrationRecoveryOutcome =
  | "continue"
  | "restart-requested"
  | "quit-requested"
  | "update-requested";

export type DesktopMigrationRecoveryDecision =
  | "restore"
  | "quit"
  | "install-update"
  | "open-release-page";

/**
 * Which recovery action failed, so the prompt can say what actually went wrong
 * instead of blaming the restore for an update that could not be installed.
 */
export interface DesktopMigrationRecoveryFailure {
  readonly attempt: "restore" | "update";
  readonly message: string;
}

export async function recoverDesktopMigrationIfRequired(input: {
  /**
   * Whether startup must stop and prompt. Broader than "a marker exists": a
   * marker the backend can still retry by itself must not open this dialog.
   */
  readonly requiresRecovery: () => boolean;
  /**
   * Whether the marker is still on disk, which is the only proof a restore did
   * what it claimed. Deliberately not `requiresRecovery`: that one answers false
   * for a marker with retries left, which would pass this verification for
   * exactly the database it was written to catch.
   */
  readonly markerRemains: () => boolean;
  readonly choose: (state: {
    readonly previousFailure: DesktopMigrationRecoveryFailure | null;
  }) => Promise<DesktopMigrationRecoveryDecision>;
  readonly restore: () => Promise<unknown>;
  /**
   * Repairs the install rather than the database: when a newer build already
   * carries the fix, updating in place is the only option here that needs
   * nothing from the user afterwards. Resolves to a failure message to show in
   * the next prompt, or to null once the updater owns the quit.
   */
  readonly installUpdate: () => Promise<string | null>;
  /**
   * Escape hatch for a database this build cannot repair. The blocked user has
   * no working UI to reach the in-app updater from, so recovery has to hand
   * them the download itself.
   */
  readonly openReleasePage: () => void;
  readonly requestRestart: () => void;
  readonly requestQuit: (reason: string) => void;
  readonly formatError: (error: unknown) => string;
  readonly log: (message: string) => void;
}): Promise<DesktopMigrationRecoveryOutcome> {
  if (!input.requiresRecovery()) {
    return "continue";
  }

  let previousFailure: DesktopMigrationRecoveryFailure | null = null;
  for (;;) {
    const decision = await input.choose({ previousFailure });
    if (decision === "open-release-page") {
      input.log("migration recovery: opening the release download page");
      input.openReleasePage();
      continue;
    }
    if (decision === "install-update") {
      input.log("migration recovery: installing the newest release in place");
      const failure = await input.installUpdate();
      if (failure === null) {
        // The updater owns the quit from here; startup must not continue, and
        // must not race it with a quit of its own.
        input.log("migration recovery: update install handoff started");
        return "update-requested";
      }
      previousFailure = { attempt: "update", message: failure };
      input.log(`migration recovery update attempt failed message=${failure}`);
      continue;
    }
    if (decision === "quit") {
      input.log("migration recovery declined; quitting without opening the database");
      input.requestQuit("migration recovery declined");
      return "quit-requested";
    }

    try {
      await input.restore();
      if (input.markerRemains()) {
        throw new Error("Migration recovery completed without clearing its recovery marker.");
      }
      input.log("migration recovery completed; requesting a clean desktop restart");
      input.requestRestart();
      input.requestQuit("migration recovery restart");
      return "restart-requested";
    } catch (error) {
      const message = input.formatError(error);
      previousFailure = { attempt: "restore", message };
      input.log(`migration recovery attempt failed message=${message}`);
    }
  }
}

export function hasPendingDesktopMigrationRecovery(paths: DesktopMigrationRecoveryPaths): boolean {
  return FS.existsSync(paths.markerPath);
}

/**
 * Whether startup must stop and ask the user to restore.
 *
 * A marker alone is not enough: the backend re-runs an interrupted migration a
 * bounded number of times, and blocking here on the first marker would hide
 * that self-heal behind a dialog the user cannot answer usefully. Only a spent
 * budget — or a marker too damaged to read — earns the prompt.
 */
export function requiresDesktopMigrationRecovery(paths: DesktopMigrationRecoveryPaths): boolean {
  let markerText: string;
  try {
    markerText = FS.readFileSync(paths.markerPath, "utf8");
  } catch (cause) {
    // A marker that vanished between checks is not a recovery condition; any
    // other read failure is, because it means the marker cannot be trusted.
    return (cause as NodeJS.ErrnoException).code !== "ENOENT";
  }
  return parseMigrationRecoveryResumeState(markerText)?.exhausted ?? true;
}

export async function restoreDesktopMigrationBackup(input: {
  readonly executablePath: string;
  readonly nodeArgs: ReadonlyArray<string>;
  readonly paths: DesktopMigrationRecoveryPaths;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<string> {
  if (!FS.existsSync(input.paths.restoreEntryPath)) {
    throw new Error(`Migration recovery command is missing: ${input.paths.restoreEntryPath}`);
  }

  const { stdout, stderr } = await execFile(
    input.executablePath,
    [...input.nodeArgs, input.paths.restoreEntryPath, input.paths.dbPath],
    {
      cwd: input.cwd,
      env: {
        ...input.env,
        ELECTRON_RUN_AS_NODE: "1",
      },
      encoding: "utf8",
      maxBuffer: RECOVERY_OUTPUT_LIMIT_BYTES,
      windowsHide: true,
    },
  );

  // Exit zero is not sufficient: the server-owned command must have cleared
  // the durable marker before desktop startup is allowed to continue.
  if (hasPendingDesktopMigrationRecovery(input.paths)) {
    throw new Error("Migration recovery completed without clearing its recovery marker.");
  }

  return [stdout, stderr]
    .map(String)
    .filter((value) => value.trim().length > 0)
    .join("\n")
    .trim();
}

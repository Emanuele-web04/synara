// FILE: desktopMigrationRecovery.ts
// Purpose: Detects pending desktop migration recovery and invokes the server-owned restore CLI.
// Layer: Desktop startup utility

import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";
import { promisify } from "node:util";
import { migrationRecoveryMarkerPath } from "@synara/shared/migrationRecovery";

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
    restoreEntryPath: Path.join(
      input.appRoot,
      "apps/server/dist/restoreMigrationBackup.mjs",
    ),
  };
}

export type DesktopMigrationRecoveryOutcome =
  | "continue"
  | "restart-requested"
  | "quit-requested";

export async function recoverDesktopMigrationIfRequired(input: {
  readonly markerExists: () => boolean;
  readonly choose: (state: {
    readonly previousFailure: string | null;
  }) => Promise<"restore" | "quit">;
  readonly restore: () => Promise<unknown>;
  readonly requestRestart: () => void;
  readonly requestQuit: (reason: string) => void;
  readonly formatError: (error: unknown) => string;
  readonly log: (message: string) => void;
}): Promise<DesktopMigrationRecoveryOutcome> {
  if (!input.markerExists()) {
    return "continue";
  }

  let previousFailure: string | null = null;
  for (;;) {
    const decision = await input.choose({ previousFailure });
    if (decision === "quit") {
      input.log("migration recovery declined; quitting without opening the database");
      input.requestQuit("migration recovery declined");
      return "quit-requested";
    }

    try {
      await input.restore();
      if (input.markerExists()) {
        throw new Error("Migration recovery completed without clearing its recovery marker.");
      }
      input.log("migration recovery completed; requesting a clean desktop restart");
      input.requestRestart();
      input.requestQuit("migration recovery restart");
      return "restart-requested";
    } catch (error) {
      previousFailure = input.formatError(error);
      input.log(`migration recovery attempt failed message=${previousFailure}`);
    }
  }
}

export function hasPendingDesktopMigrationRecovery(
  paths: DesktopMigrationRecoveryPaths,
): boolean {
  return FS.existsSync(paths.markerPath);
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

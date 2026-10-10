import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";
import { promisify } from "node:util";
import {
  migrationBackupProvenancePath,
  migrationRecoveryMarkerPath,
  parseMigrationRecoveryResumeState,
  type MigrationSchemaTooNewStartupBlock,
} from "@synara/shared/migrationRecovery";

const execFile = promisify(ChildProcess.execFile);
const RECOVERY_OUTPUT_LIMIT_BYTES = 64 * 1024;

export interface DesktopMigrationRecoveryPaths {
  readonly dbPath: string;
  readonly markerPath: string;
  readonly provenancePath: string;
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
    provenancePath: migrationBackupProvenancePath(dbPath),
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
  | "open-release-page"
  | "open-logs";

export interface DesktopMigrationRecoveryChoice {
  readonly label: string;
  readonly decision: DesktopMigrationRecoveryDecision;
}

export function invalidMigrationStartupRecoveryChoices(input: {
  readonly canInstallUpdate: boolean;
  readonly canOpenReleasePage: boolean;
}): ReadonlyArray<DesktopMigrationRecoveryChoice> {
  const choices: Array<DesktopMigrationRecoveryChoice> = [];
  if (input.canInstallUpdate) {
    choices.push({ label: "Update Synara and restart", decision: "install-update" });
  }
  if (input.canOpenReleasePage) {
    choices.push({ label: "Download latest release", decision: "open-release-page" });
  }
  choices.push({ label: "Open logs", decision: "open-logs" }, { label: "Quit", decision: "quit" });
  return choices;
}

// which recovery action failed, so the prompt says what went wrong instead of blaming restore for an update that couldn't install
export interface DesktopMigrationRecoveryFailure {
  readonly attempt: "restore" | "update";
  readonly message: string;
}

export async function recoverDesktopMigrationIfRequired(input: {
  // broader than "a marker exists": a marker the backend can still retry itself must not open this dialog
  readonly requiresRecovery: () => boolean;
  // the marker on disk is the only proof a restore did what it claimed — deliberately not requiresRecovery, which answers false for retriable markers and would pass verification for the exact database it was written to catch
  readonly markerRemains: () => boolean;
  readonly choose: (state: {
    readonly previousFailure: DesktopMigrationRecoveryFailure | null;
  }) => Promise<DesktopMigrationRecoveryDecision>;
  readonly restore: () => Promise<unknown>;
  // a newer build already carrying the fix is the only option needing nothing from the user afterwards; resolves to a failure message or null once the updater owns the quit
  readonly installUpdate: () => Promise<string | null>;
  // a user blocked by the database can't reach the in-app updater — recovery has to hand them the download itself
  readonly openReleasePage: () => void;
  readonly openLogs?: (() => Promise<void>) | undefined;
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
    if (decision === "open-logs") {
      input.log("migration recovery: opening logs");
      await input.openLogs?.();
      continue;
    }
    if (decision === "install-update") {
      input.log("migration recovery: installing the newest release in place");
      const failure = await input.installUpdate();
      if (failure === null) {
        // The updater owns the quit from here; startup must not continue, and must not race it with a quit of its own.
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

export function hasVerifiedDesktopMigrationRestore(
  paths: DesktopMigrationRecoveryPaths,
  expectedBackupPath: string,
): boolean {
  let provenanceText: string;
  try {
    provenanceText = FS.readFileSync(paths.provenancePath, "utf8");
  } catch {
    return false;
  }

  try {
    const provenance = JSON.parse(provenanceText) as Record<string, unknown>;
    return (
      provenance.databasePath === paths.dbPath &&
      provenance.backupPath === expectedBackupPath &&
      provenance.phase === "migration-restored" &&
      typeof provenance.restoredAt === "string" &&
      provenance.restoredAt.length > 0
    );
  } catch {
    return false;
  }
}

type DesktopMigrationRestoreCandidate = Extract<
  MigrationSchemaTooNewStartupBlock["recovery"],
  { readonly kind: "restore-available" }
>;

export function resolveDesktopMigrationRestoreCandidate(
  paths: DesktopMigrationRecoveryPaths,
  block: MigrationSchemaTooNewStartupBlock,
): DesktopMigrationRestoreCandidate | null {
  const recovery = block.recovery;
  return block.databasePath === paths.dbPath &&
    recovery.kind === "restore-available" &&
    recovery.provenancePath === paths.provenancePath
    ? recovery
    : null;
}

// a marker alone isn't enough — the backend re-runs an interrupted migration a bounded number of times; only a spent budget or unreadable marker earns the prompt
export function requiresDesktopMigrationRecovery(paths: DesktopMigrationRecoveryPaths): boolean {
  let markerText: string;
  try {
    markerText = FS.readFileSync(paths.markerPath, "utf8");
  } catch (cause) {
    // a vanished marker isn't a recovery condition; any other read failure is, because the marker can't be trusted
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
  readonly expectedBackupPath?: string | undefined;
  readonly expectedProvenancePath?: string | undefined;
  readonly verifyRestore?: (() => boolean) | undefined;
  readonly restoreVerificationFailure?: string | undefined;
}): Promise<string> {
  if (!FS.existsSync(input.paths.restoreEntryPath)) {
    throw new Error(`Migration recovery command is missing: ${input.paths.restoreEntryPath}`);
  }

  if ((input.expectedBackupPath === undefined) !== (input.expectedProvenancePath === undefined)) {
    throw new Error("Both expected migration backup and provenance paths are required.");
  }
  const restoreSelection =
    input.expectedBackupPath && input.expectedProvenancePath
      ? [
          "--backup-path",
          input.expectedBackupPath,
          "--provenance-path",
          input.expectedProvenancePath,
        ]
      : [];
  const { stdout, stderr } = await execFile(
    input.executablePath,
    [...input.nodeArgs, input.paths.restoreEntryPath, input.paths.dbPath, ...restoreSelection],
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

  // exit zero isn't sufficient — the server-owned command must have cleared the durable marker before startup continues
  const restoreVerified = input.verifyRestore
    ? input.verifyRestore()
    : !hasPendingDesktopMigrationRecovery(input.paths);
  if (!restoreVerified) {
    throw new Error(
      input.restoreVerificationFailure ??
        "Migration recovery completed without clearing its recovery marker.",
    );
  }

  return [stdout, stderr]
    .map(String)
    .filter((value) => value.trim().length > 0)
    .join("\n")
    .trim();
}

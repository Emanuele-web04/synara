import * as path from "node:path";

import { Effect } from "effect";

import { restoreMarkedMigrationBackup } from "./persistence/MigrationBackup.ts";

const USAGE = "Usage: synara-restore-migration-backup <absolute-database-path>";
const STOP_PROCESSES_WARNING =
  "WARNING: Stop every Synara process before restoring a migration backup.";

type RestoreMigrationBackupOutput = Pick<Console, "error" | "log" | "warn">;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export async function runRestoreMigrationBackupCli(
  args: ReadonlyArray<string>,
  output: RestoreMigrationBackupOutput = console,
): Promise<number> {
  output.warn(STOP_PROCESSES_WARNING);

  const dbPath = args[0];
  if (!dbPath) {
    output.error(USAGE);
    return 2;
  }
  if (!path.isAbsolute(dbPath)) {
    output.error(`Database path must be absolute: ${dbPath}\n${USAGE}`);
    return 2;
  }

  try {
    await Effect.runPromise(restoreMarkedMigrationBackup(dbPath));
    output.log(`Restored migration backup for ${dbPath}`);
    return 0;
  } catch (cause) {
    output.error(`Failed to restore migration backup for ${dbPath}: ${errorMessage(cause)}`);
    return 1;
  }
}

const entryPointNames = new Set([
  "restoreMigrationBackup.ts",
  "restoreMigrationBackup.mjs",
  "restoreMigrationBackup.cjs",
  "synara-restore-migration-backup",
]);

if (process.argv[1] && entryPointNames.has(path.basename(process.argv[1]))) {
  void runRestoreMigrationBackupCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}

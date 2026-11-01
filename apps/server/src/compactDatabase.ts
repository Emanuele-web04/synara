import * as path from "node:path";

import { Effect } from "effect";

import { compactSqliteDatabase } from "./persistence/SqliteCompaction.ts";

const USAGE = "Usage: synara-compact-database <absolute-database-path>";

export async function runCompactDatabaseCli(
  args: ReadonlyArray<string>,
  output: Pick<Console, "error" | "log" | "warn"> = console,
  signal?: AbortSignal,
): Promise<number> {
  output.warn("WARNING: Stop every Synara process and other database client before compacting.");
  if (args.length !== 1 || !args[0] || !path.isAbsolute(args[0])) {
    output.error(USAGE);
    return 2;
  }
  try {
    const result = await Effect.runPromise(compactSqliteDatabase(args[0], signal));
    output.log(`Compacted ${args[0]}: ${result.beforeBytes} → ${result.afterBytes} bytes.`);
    return 0;
  } catch (cause) {
    output.error(
      `Database compaction failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return 1;
  }
}

const entryPointNames = new Set([
  "compactDatabase.ts",
  "compactDatabase.mjs",
  "compactDatabase.cjs",
  "synara-compact-database",
]);

if (process.argv[1] && entryPointNames.has(path.basename(process.argv[1]))) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  void runCompactDatabaseCli(process.argv.slice(2), console, controller.signal).then((code) => {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    process.exitCode = code;
  });
}

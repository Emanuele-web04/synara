import * as fs from "node:fs";

import { Effect } from "effect";

import { consumeDesktopParentInput, withDesktopParentLifetime } from "../desktopParentLifetime.ts";
import { withDatabaseLifecycleLock } from "../persistence/DatabaseLifecycleLock.ts";

const [dbPath, statePath, mode] = process.argv.slice(2) as [string, string, string];
const input = consumeDesktopParentInput(process.env, () => process.stdin);
const keepAlive = setInterval(() => undefined, 1_000);
const program = withDatabaseLifecycleLock(
  dbPath,
  Effect.sync(() => {
    fs.writeFileSync(
      statePath,
      JSON.stringify({ pid: process.pid, marker: process.env.SYNARA_DESKTOP_PARENT_STDIN ?? null }),
    );
  }).pipe(
    Effect.andThen(Effect.never),
    Effect.ensuring(mode === "stubborn" ? Effect.never : Effect.void),
  ),
);
await Effect.runPromise(withDesktopParentLifetime(program, input, 500));
clearInterval(keepAlive);
fs.writeFileSync(`${statePath}.stopped`, "cleaned up");

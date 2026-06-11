// Purpose: Cursor model discovery — spawns `cursor-agent models`, parses CLI stdout, applies timeout.
// Layer: a self-contained discovery Effect parameterized on its spawner + binary/endpoint deps — no session context.
// Exports: discoverCursorModels.

import { type ProviderListModelsResult } from "@t3tools/contracts";
import { Effect, Option } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ProviderAdapterRequestError } from "../Errors.ts";
import { parseCursorCliModelList } from "../acp/CursorAcpSupport.ts";

import {
  CURSOR_MODEL_DISCOVERY_TIMEOUT_MS,
  PROVIDER,
  collectStreamAsString,
} from "./CursorAdapter.types.ts";

export function discoverCursorModels(input: {
  readonly binaryPath: string;
  readonly apiEndpoint: string | undefined;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}): Effect.Effect<ProviderListModelsResult, ProviderAdapterRequestError> {
  const { binaryPath, apiEndpoint, childProcessSpawner } = input;
  const runCursorModelListCommand = Effect.gen(function* () {
    const child = yield* childProcessSpawner.spawn(
      ChildProcess.make(
        binaryPath,
        [...(apiEndpoint ? (["-e", apiEndpoint] as const) : []), "models"],
        {
          shell: process.platform === "win32",
          env: process.env,
        },
      ),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "model/list",
        detail:
          stderr.trim() ||
          `Cursor model discovery failed because '${binaryPath} models' exited with code ${exitCode}.`,
      });
    }
    const models = parseCursorCliModelList(stdout);
    if (models.length === 0) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "model/list",
        detail: "Cursor model discovery returned no CLI models.",
      });
    }
    return models;
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(CURSOR_MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "model/list",
              detail: "Timed out while discovering Cursor models via CLI.",
            }),
          ),
        onSome: (models) => Effect.succeed(models),
      }),
    ),
  );

  const discovery = Effect.gen(function* () {
    const cliModels = yield* runCursorModelListCommand;
    return {
      models: cliModels,
      source: "cursor.cli",
      cached: false,
    } satisfies ProviderListModelsResult;
  });

  return discovery.pipe(
    Effect.mapError((cause) =>
      cause instanceof ProviderAdapterRequestError
        ? cause
        : new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "model/list",
            detail: "Failed to discover Cursor models via CLI.",
            cause,
          }),
    ),
  );
}

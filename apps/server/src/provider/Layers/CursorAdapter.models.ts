// Purpose: Cursor model discovery — spawns `cursor-agent models`, parses CLI stdout, applies timeout.
// Layer: a self-contained discovery Effect parameterized on its spawner + binary/endpoint deps — no session context.
// Exports: discoverCursorModels.

import { type ProviderListModelsResult } from "@t3tools/contracts";
import { Effect, Option } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ProviderAdapterRequestError } from "../Errors.ts";
import {
  fetchCursorAcpModelDescriptors,
  makeCursorAcpRuntime,
  parseCursorCliModelList,
  type CursorAcpRuntimeCursorSettings,
} from "../acp/CursorAcpSupport.ts";

import {
  CURSOR_MODEL_DISCOVERY_TIMEOUT_MS,
  PROVIDER,
  collectStreamAsString,
} from "./CursorAdapter.types.ts";

function mergeCursorModelDescriptors(
  preferredModels: ReadonlyArray<ProviderListModelsResult["models"][number]>,
  additionalModels: ReadonlyArray<ProviderListModelsResult["models"][number]>,
): ProviderListModelsResult["models"] {
  const seen = new Set<string>();
  const merged: Array<ProviderListModelsResult["models"][number]> = [];
  for (const model of [...preferredModels, ...additionalModels]) {
    const key = model.slug.trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(model);
  }
  return merged;
}

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

  const effectiveAcpSettings: CursorAcpRuntimeCursorSettings = {
    binaryPath,
    ...(apiEndpoint ? { apiEndpoint } : {}),
  };
  const runCursorAcpModelDiscovery = Effect.gen(function* () {
    const runtime = yield* makeCursorAcpRuntime({
      cursorSettings: effectiveAcpSettings,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "Synara", version: "0.0.0" },
    });
    const started = yield* runtime.start();
    const models = yield* fetchCursorAcpModelDescriptors(runtime, started.sessionId);
    if (models.length === 0) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "model/list",
        detail: "Cursor ACP model discovery returned no models.",
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
              detail: "Timed out while discovering Cursor models via ACP.",
            }),
          ),
        onSome: (models) => Effect.succeed(models),
      }),
    ),
  );

  const discovery = runCursorAcpModelDiscovery.pipe(
    Effect.flatMap((acpModels) =>
      runCursorModelListCommand.pipe(
        Effect.map((cliModels) => mergeCursorModelDescriptors(acpModels, cliModels)),
        Effect.catch(() => Effect.succeed(acpModels)),
      ),
    ),
    Effect.map(
      (models) =>
        ({
          models,
          source: "cursor.acp",
          cached: false,
        }) satisfies ProviderListModelsResult,
    ),
    Effect.catch(() =>
      runCursorModelListCommand.pipe(
        Effect.map(
          (cliModels) =>
            ({
              models: cliModels,
              source: "cursor.cli",
              cached: false,
            }) satisfies ProviderListModelsResult,
        ),
      ),
    ),
  );

  return discovery.pipe(
    Effect.mapError((cause) =>
      cause instanceof ProviderAdapterRequestError
        ? cause
        : new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "model/list",
            detail: "Failed to discover Cursor models.",
            cause,
          }),
    ),
  );
}

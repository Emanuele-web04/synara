import {
  ProviderDriverKind,
  defaultInstanceIdForDriver,
  type ProviderInstanceId,
  type ThreadId,
} from "@synara/contracts";
import { Effect, Layer, Option, Schema } from "effect";

import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ProviderSessionDirectoryPersistenceError, ProviderValidationError } from "../Errors.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
  type ProviderSessionDirectoryShape,
} from "../Services/ProviderSessionDirectory.ts";

function toPersistenceError(operation: string) {
  return (cause: unknown) =>
    new ProviderSessionDirectoryPersistenceError({
      operation,
      detail: `Failed to execute ${operation}.`,
      cause,
    });
}

function decodeProviderDriverKind(
  providerName: string,
  operation: string,
): Effect.Effect<ProviderDriverKind, ProviderSessionDirectoryPersistenceError> {
  if (Schema.is(ProviderDriverKind)(providerName)) {
    return Effect.succeed(providerName);
  }
  return Effect.fail(
    new ProviderSessionDirectoryPersistenceError({
      operation,
      detail: `Invalid persisted provider driver '${providerName}'.`,
    }),
  );
}

function materializeProviderInstanceId(
  driver: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId | null,
): ProviderInstanceId {
  return providerInstanceId ?? defaultInstanceIdForDriver(driver);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const CLEARABLE_RUNTIME_PAYLOAD_KEYS = new Set([
  "continuationIdentity",
  "continuationResetRequested",
  "providerOptions",
  "providerOptionsCredentialsFingerprint",
]);

function mergeRuntimePayload(
  existing: unknown | null,
  next: unknown | null | undefined,
): unknown | null {
  if (next === undefined) {
    return existing ?? null;
  }
  if (isRecord(existing) && isRecord(next)) {
    const merged: Record<string, unknown> = { ...existing };
    for (const [key, value] of Object.entries(next)) {
      if (value === null && CLEARABLE_RUNTIME_PAYLOAD_KEYS.has(key)) {
        delete merged[key];
        continue;
      }
      merged[key] = value;
    }
    return merged;
  }
  return next;
}

const makeProviderSessionDirectory = Effect.gen(function* () {
  const repository = yield* ProviderSessionRuntimeRepository;

  const getBinding = (threadId: ThreadId) =>
    repository.getByThreadId({ threadId }).pipe(
      Effect.mapError(toPersistenceError("ProviderSessionDirectory.getBinding:getByThreadId")),
      Effect.flatMap((runtime) =>
        Option.match(runtime, {
          onNone: () => Effect.succeed(Option.none<ProviderRuntimeBinding>()),
          onSome: (value) =>
            decodeProviderDriverKind(
              value.providerName,
              "ProviderSessionDirectory.getBinding",
            ).pipe(
              Effect.map((driver) =>
                Option.some({
                  threadId: value.threadId,
                  provider: driver,
                  providerInstanceId: materializeProviderInstanceId(
                    driver,
                    value.providerInstanceId,
                  ),
                  adapterKey: value.adapterKey,
                  runtimeMode: value.runtimeMode,
                  status: value.status,
                  lastSeenAt: value.lastSeenAt,
                  resumeCursor: value.resumeCursor,
                  runtimePayload: value.runtimePayload,
                }),
              ),
            ),
        }),
      ),
    );

  const upsert: ProviderSessionDirectoryShape["upsert"] = Effect.fn(function* (binding) {
    const existing = yield* repository
      .getByThreadId({ threadId: binding.threadId })
      .pipe(Effect.mapError(toPersistenceError("ProviderSessionDirectory.upsert:getByThreadId")));

    const existingRuntime = Option.getOrUndefined(existing);
    const resolvedThreadId = binding.threadId ?? existingRuntime?.threadId;
    if (!resolvedThreadId) {
      return yield* new ProviderValidationError({
        operation: "ProviderSessionDirectory.upsert",
        issue: "threadId must be a non-empty string.",
      });
    }

    const now = new Date().toISOString();
    const providerChanged =
      existingRuntime !== undefined && existingRuntime.providerName !== binding.provider;
    const providerInstanceId =
      binding.providerInstanceId ?? existingRuntime?.providerInstanceId ?? undefined;
    if (!providerInstanceId) {
      return yield* new ProviderValidationError({
        operation: "ProviderSessionDirectory.upsert",
        issue: "providerInstanceId must be a non-empty string.",
      });
    }
    const previousProviderInstanceId = existingRuntime?.providerInstanceId ?? providerInstanceId;
    const providerInstanceChanged =
      existingRuntime !== undefined && previousProviderInstanceId !== providerInstanceId;
    yield* repository
      .upsert({
        threadId: resolvedThreadId,
        providerName: binding.provider,
        providerInstanceId,
        adapterKey:
          binding.adapterKey ??
          (providerChanged ? binding.provider : (existingRuntime?.adapterKey ?? binding.provider)),
        runtimeMode: binding.runtimeMode ?? existingRuntime?.runtimeMode ?? "full-access",
        status: binding.status ?? existingRuntime?.status ?? "running",
        lastSeenAt: now,
        resumeCursor:
          binding.resumeCursor !== undefined
            ? binding.resumeCursor
            : providerChanged || providerInstanceChanged
              ? null
              : (existingRuntime?.resumeCursor ?? null),
        runtimePayload: mergeRuntimePayload(
          existingRuntime?.runtimePayload ?? null,
          mergeRuntimePayload(binding.runtimePayload ?? null, { providerInstanceId }),
        ),
      })
      .pipe(Effect.mapError(toPersistenceError("ProviderSessionDirectory.upsert:upsert")));
  });

  const getProvider: ProviderSessionDirectoryShape["getProvider"] = (threadId) =>
    getBinding(threadId).pipe(
      Effect.flatMap((binding) =>
        Option.match(binding, {
          onSome: (value) => Effect.succeed(value.provider),
          onNone: () =>
            Effect.fail(
              new ProviderSessionDirectoryPersistenceError({
                operation: "ProviderSessionDirectory.getProvider",
                detail: `No persisted provider binding found for thread '${threadId}'.`,
              }),
            ),
        }),
      ),
    );

  const remove: ProviderSessionDirectoryShape["remove"] = (threadId) =>
    repository
      .deleteByThreadId({ threadId })
      .pipe(
        Effect.mapError(toPersistenceError("ProviderSessionDirectory.remove:deleteByThreadId")),
      );

  const listThreadIds: ProviderSessionDirectoryShape["listThreadIds"] = () =>
    repository.list().pipe(
      Effect.mapError(toPersistenceError("ProviderSessionDirectory.listThreadIds:list")),
      Effect.map((rows) => rows.map((row) => row.threadId)),
    );

  const listBindings: ProviderSessionDirectoryShape["listBindings"] = () =>
    repository.list().pipe(
      Effect.mapError(toPersistenceError("ProviderSessionDirectory.listBindings:list")),
      Effect.flatMap(
        Effect.forEach((row) =>
          decodeProviderDriverKind(row.providerName, "ProviderSessionDirectory.listBindings").pipe(
            Effect.map((driver) =>
              Option.some({
                threadId: row.threadId,
                provider: driver,
                providerInstanceId: materializeProviderInstanceId(driver, row.providerInstanceId),
                adapterKey: row.adapterKey,
                runtimeMode: row.runtimeMode,
                status: row.status,
                lastSeenAt: row.lastSeenAt,
                resumeCursor: row.resumeCursor,
                runtimePayload: row.runtimePayload,
              }),
            ),
            Effect.catchTag("ProviderSessionDirectoryPersistenceError", (error) =>
              Effect.logDebug(
                "provider session directory skipped invalid persisted provider driver",
                {
                  threadId: row.threadId,
                  providerName: row.providerName,
                  detail: error.detail,
                },
              ).pipe(Effect.as(Option.none<ProviderRuntimeBinding>())),
            ),
          ),
        ),
      ),
      Effect.map((bindings) => bindings.filter(Option.isSome).map((binding) => binding.value)),
    );

  return {
    upsert,
    getProvider,
    getBinding,
    remove,
    listThreadIds,
    listBindings,
  } satisfies ProviderSessionDirectoryShape;
});

export const ProviderSessionDirectoryLive = Layer.effect(
  ProviderSessionDirectory,
  makeProviderSessionDirectory,
);

export function makeProviderSessionDirectoryLive() {
  return Layer.effect(ProviderSessionDirectory, makeProviderSessionDirectory);
}

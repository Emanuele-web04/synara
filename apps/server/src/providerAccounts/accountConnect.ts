// FILE: accountConnect.ts
// Purpose: Account connect/disconnect lifecycle operations (plan section 10).
// Layer: Server service internals
// Exports: makeAccountConnect, ProviderAccountConnectError.

import { randomUUID } from "node:crypto";

import type {
  AccountSurface,
  AgentAuthMethod,
  ProviderAccountsBeginConnectInput,
  ProviderAccountsConnectStatus,
  ProviderAccountRecord,
  SupportedAccountProvider,
} from "@synara/contracts";
import { supportLevelFor } from "@synara/shared/providerAccounts/capabilities";
import { Data, Effect } from "effect";

import type { AccountStorageShape, ProviderAccountStorageError } from "./accountStorage";

export class ProviderAccountConnectError extends Data.TaggedError("ProviderAccountConnectError")<{
  readonly operation: string;
  readonly detail: string;
}> {}

type ConnectOperation = {
  readonly operationId: string;
  readonly provider: SupportedAccountProvider;
  readonly surface: AccountSurface;
  readonly authMethod: AgentAuthMethod;
  readonly reconnectOrdinal?: number;
  // Held in memory only until finalization; never echoed back to clients.
  apiKey?: string;
  state: ProviderAccountsConnectStatus["state"];
  ordinal?: number;
  error?: string;
};

const toStatus = (operation: ConnectOperation): ProviderAccountsConnectStatus => ({
  operationId: operation.operationId,
  state: operation.state,
  provider: operation.provider,
  surface: operation.surface,
  ...(operation.ordinal !== undefined ? { ordinal: operation.ordinal } : {}),
  ...(operation.error !== undefined ? { error: operation.error } : {}),
});

export interface AccountConnectInput {
  readonly storage: AccountStorageShape;
  readonly now?: () => string;
}

export type AccountConnectShape = ReturnType<typeof makeAccountConnect>;

export function makeAccountConnect(input: AccountConnectInput) {
  const { storage } = input;
  const now = input.now ?? (() => new Date().toISOString());
  const operations = new Map<string, ConnectOperation>();

  const requireOperation = (
    operation: string,
    operationId: string,
  ): Effect.Effect<ConnectOperation, ProviderAccountConnectError> => {
    const found = operations.get(operationId);
    return found === undefined
      ? Effect.fail(
          new ProviderAccountConnectError({
            operation,
            detail: `Unknown connect operation '${operationId}'.`,
          }),
        )
      : Effect.succeed(found);
  };

  const beginConnect = (connectInput: ProviderAccountsBeginConnectInput) =>
    Effect.gen(function* () {
      if (connectInput.authMethod === "apiKey" && connectInput.apiKey === undefined) {
        return yield* new ProviderAccountConnectError({
          operation: "accountConnect.beginConnect",
          detail: "API-key connect requires an apiKey.",
        });
      }
      const operation: ConnectOperation = {
        operationId: randomUUID(),
        provider: connectInput.provider,
        surface: connectInput.surface,
        authMethod: connectInput.authMethod,
        ...(connectInput.ordinal !== undefined ? { reconnectOrdinal: connectInput.ordinal } : {}),
        ...(connectInput.apiKey !== undefined ? { apiKey: connectInput.apiKey } : {}),
        state: connectInput.authMethod === "oauth" ? "waiting-for-user" : "pending",
      };
      operations.set(operation.operationId, operation);
      if (connectInput.authMethod === "oauth" && connectInput.ordinal === undefined) {
        yield* storage.createPendingDirectory(connectInput.provider, operation.operationId);
      }
      if (connectInput.authMethod === "apiKey") {
        // API-key connects need no external login step; finalize immediately.
        yield* finalizeConnect(operation.operationId);
      }
      return { operationId: operation.operationId };
    });

  const getConnectStatus = (operationId: string) =>
    requireOperation("accountConnect.getConnectStatus", operationId).pipe(Effect.map(toStatus));

  const cancelConnect = (operationId: string) =>
    requireOperation("accountConnect.cancelConnect", operationId).pipe(
      Effect.flatMap((operation) =>
        Effect.gen(function* () {
          if (operation.state === "waiting-for-user" || operation.state === "pending") {
            yield* storage.cancelPendingDirectory(operation.provider, operation.operationId);
            operation.state = "cancelled";
            delete operation.apiKey;
          }
          return toStatus(operation);
        }),
      ),
    );

  const finalizeConnect = (
    operationId: string,
    identity?: { readonly hint?: string; readonly fingerprint?: string },
  ): Effect.Effect<
    ProviderAccountsConnectStatus,
    ProviderAccountConnectError | ProviderAccountStorageError
  > =>
    Effect.gen(function* () {
      const operation = yield* requireOperation("accountConnect.finalizeConnect", operationId);
      if (operation.state !== "pending" && operation.state !== "waiting-for-user") {
        return yield* new ProviderAccountConnectError({
          operation: "accountConnect.finalizeConnect",
          detail: `Connect operation '${operationId}' is already ${operation.state}.`,
        });
      }
      const { provider, surface, authMethod } = operation;

      const ordinal =
        operation.reconnectOrdinal ??
        (authMethod === "oauth"
          ? yield* storage.finalizePendingDirectory(provider, operationId)
          : yield* storage.withProviderLock(provider, storage.nextOrdinal(provider)));

      const existing = yield* storage.readAccount(provider, ordinal);
      const previous = surface === "agent" ? existing?.agent : existing?.app;
      const generation = (previous?.generation ?? 0) + 1;
      const record: ProviderAccountRecord = {
        schemaVersion: 1,
        provider,
        ordinal,
        createdAt: existing?.createdAt ?? now(),
        ...(identity?.hint !== undefined
          ? { identity: { hint: identity.hint, verification: "provider-verified" as const } }
          : existing?.identity !== undefined
            ? { identity: existing.identity }
            : {}),
        ...(surface === "agent"
          ? {
              agent: {
                generation,
                state: "connected" as const,
                authMethod,
                ...(identity?.fingerprint !== undefined
                  ? { identityFingerprint: identity.fingerprint }
                  : {}),
              },
              ...(existing?.app !== undefined ? { app: existing.app } : {}),
            }
          : {
              app: {
                generation,
                state: "connected" as const,
                authMethod: "oauth" as const,
                supportLevel: supportLevelFor(provider, "app", "oauth"),
                ...(identity?.fingerprint !== undefined
                  ? { identityFingerprint: identity.fingerprint }
                  : {}),
              },
              ...(existing?.agent !== undefined ? { agent: existing.agent } : {}),
            }),
      };
      yield* storage.writeAccount(record);

      if (authMethod === "apiKey" && operation.apiKey !== undefined) {
        yield* storage.writeSecret(provider, ordinal, "agent", operation.apiKey);
        delete operation.apiKey;
      }

      // First connected account becomes active so new threads use it.
      if ((yield* storage.readActiveOrdinal(provider)) === null) {
        yield* storage.writeActiveOrdinal(provider, ordinal);
      }

      operation.state = "succeeded";
      operation.ordinal = ordinal;
      return toStatus(operation);
    });

  const setActive = (provider: SupportedAccountProvider, ordinal: number) =>
    Effect.gen(function* () {
      if (ordinal !== 0 && (yield* storage.readAccount(provider, ordinal)) === null) {
        return yield* new ProviderAccountConnectError({
          operation: "accountConnect.setActive",
          detail: `Cannot activate missing account '${provider}' ordinal ${ordinal}.`,
        });
      }
      yield* storage.writeActiveOrdinal(provider, ordinal);
    });

  const disconnectBinding = (
    provider: SupportedAccountProvider,
    ordinal: number,
    surface: AccountSurface,
  ) =>
    Effect.gen(function* () {
      const existing = yield* storage.readAccount(provider, ordinal);
      if (existing === null) {
        return yield* new ProviderAccountConnectError({
          operation: "accountConnect.disconnectBinding",
          detail: `Cannot disconnect missing account '${provider}' ordinal ${ordinal}.`,
        });
      }
      const binding = surface === "agent" ? existing.agent : existing.app;
      if (binding === undefined) return;
      // Bumping the generation invalidates existing thread bindings so they
      // fail closed instead of reusing stale credentials.
      const disconnected = {
        ...binding,
        state: "needs-auth" as const,
        generation: binding.generation + 1,
      };
      yield* storage.writeAccount(
        surface === "agent"
          ? { ...existing, agent: disconnected as typeof existing.agent }
          : { ...existing, app: disconnected as typeof existing.app },
      );
      if (surface === "agent") {
        yield* storage.deleteSecret(provider, ordinal, "agent");
      }
    });

  const hide = (provider: SupportedAccountProvider, ordinal: number) =>
    Effect.gen(function* () {
      yield* storage.hideAccount(provider, ordinal);
      if ((yield* storage.readActiveOrdinal(provider)) === ordinal) {
        yield* storage.writeActiveOrdinal(provider, 0);
      }
    });

  return {
    beginConnect,
    getConnectStatus,
    cancelConnect,
    finalizeConnect,
    setActive,
    disconnectBinding,
    hide,
  };
}

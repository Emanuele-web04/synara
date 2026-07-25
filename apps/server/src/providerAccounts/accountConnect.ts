// FILE: accountConnect.ts
// Purpose: Account connect/disconnect lifecycle operations (plan section 10).
// Layer: Server service internals
// Exports: makeAccountConnect, ProviderAccountConnectError.

import { randomUUID } from "node:crypto";
import * as path from "node:path";

import {
  SupportedAccountProvider,
  type AccountSurface,
  type AgentAuthMethod,
  type ProviderAccountsBeginConnectInput,
  type ProviderAccountsConnectStatus,
  type ProviderAccountRecord,
} from "@synara/contracts";
import { isConnectSupported, supportLevelFor } from "@synara/shared/providerAccounts/capabilities";
import { accountAgentHome, pendingPath } from "@synara/shared/providerAccounts/accountPaths";
import { Data, Effect } from "effect";

import type { AccountStorageShape, ProviderAccountStorageError } from "./accountStorage";
import {
  defaultOauthLoginRunners,
  type OAuthLoginHandle,
  type OAuthLoginRunner,
} from "./oauthLogin";

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
  verificationUrl?: string;
  userCode?: string;
  error?: string;
  loginHandle?: OAuthLoginHandle;
};

const toStatus = (operation: ConnectOperation): ProviderAccountsConnectStatus => ({
  operationId: operation.operationId,
  state: operation.state,
  provider: operation.provider,
  surface: operation.surface,
  ...(operation.ordinal !== undefined ? { ordinal: operation.ordinal } : {}),
  ...(operation.verificationUrl !== undefined
    ? { verificationUrl: operation.verificationUrl }
    : {}),
  ...(operation.userCode !== undefined ? { userCode: operation.userCode } : {}),
  ...(operation.error !== undefined ? { error: operation.error } : {}),
});

export interface AccountConnectInput {
  readonly storage: AccountStorageShape;
  readonly now?: () => string;
  readonly oauthLoginRunners?: Partial<Record<SupportedAccountProvider, OAuthLoginRunner>>;
}

export type AccountConnectShape = ReturnType<typeof makeAccountConnect>;

export function makeAccountConnect(input: AccountConnectInput) {
  const { storage } = input;
  const now = input.now ?? (() => new Date().toISOString());
  const oauthLoginRunners = input.oauthLoginRunners ?? defaultOauthLoginRunners;
  const operations = new Map<string, ConnectOperation>();

  const connectError = (operation: string, detail: string) =>
    new ProviderAccountConnectError({ operation, detail });

  const requireOperation = (
    operation: string,
    operationId: string,
  ): Effect.Effect<ConnectOperation, ProviderAccountConnectError> => {
    const found = operations.get(operationId);
    return found === undefined
      ? Effect.fail(connectError(operation, `Unknown connect operation '${operationId}'.`))
      : Effect.succeed(found);
  };

  const buildConnectedRecord = (
    operation: ConnectOperation,
    existing: ProviderAccountRecord | null,
    ordinal: number,
    identity?: {
      readonly hint?: string;
      readonly fingerprint?: string;
      readonly verification?: "provider-verified" | "user-confirmed" | "unknown";
    },
  ): ProviderAccountRecord => {
    const { provider, surface, authMethod } = operation;
    const previous = surface === "agent" ? existing?.agent : existing?.app;
    const generation = (previous?.generation ?? 0) + 1;
    return {
      schemaVersion: 1,
      provider,
      ordinal,
      createdAt: existing?.createdAt ?? now(),
      ...(identity?.hint !== undefined
        ? {
            identity: {
              hint: identity.hint,
              verification: identity.verification ?? ("provider-verified" as const),
            },
          }
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
  };

  const activateIfFirst = (provider: SupportedAccountProvider, ordinal: number) =>
    Effect.gen(function* () {
      // First connected account becomes active so new threads use it.
      if ((yield* storage.readActiveOrdinal(provider)) === null) {
        yield* storage.writeActiveOrdinal(provider, ordinal);
      }
    }).pipe(
      // A corrupted pointer must not fail the connect itself; the doctor
      // report and pointer repair handle it.
      Effect.ignore,
    );

  // API-key connects are transactional: the ordinal directory is reserved
  // atomically under the provider lock, the secret is written before the
  // record is marked connected, and any failure rolls the reservation back.
  const finalizeApiKeyConnect = (
    operation: ConnectOperation,
  ): Effect.Effect<
    ProviderAccountsConnectStatus,
    ProviderAccountConnectError | ProviderAccountStorageError
  > =>
    storage.withProviderLock(
      operation.provider,
      Effect.gen(function* () {
        const { provider } = operation;
        const apiKey = operation.apiKey;
        if (apiKey === undefined) {
          return yield* connectError(
            "accountConnect.finalizeApiKeyConnect",
            "API-key connect requires an apiKey.",
          );
        }
        const reservedOrdinal =
          operation.reconnectOrdinal === undefined
            ? yield* storage.reserveOrdinalDirectory(provider)
            : undefined;
        const ordinal = operation.reconnectOrdinal ?? reservedOrdinal!;

        const writeAll = Effect.gen(function* () {
          const existing = yield* storage.readAccount(provider, ordinal);
          yield* storage.writeSecret(provider, ordinal, "agent", apiKey);
          const identityHint = `API key ending ${apiKey.slice(-4)}`;
          yield* storage.writeAccount(
            buildConnectedRecord(operation, existing, ordinal, {
              hint: identityHint,
              verification: "unknown",
            }),
          );
        });

        yield* writeAll.pipe(
          Effect.tapError(() =>
            reservedOrdinal !== undefined
              ? storage.releaseOrdinalDirectory(provider, reservedOrdinal).pipe(Effect.ignore)
              : Effect.void,
          ),
        );

        delete operation.apiKey;
        yield* activateIfFirst(provider, ordinal);
        operation.state = "succeeded";
        operation.ordinal = ordinal;
        return toStatus(operation);
      }),
    );

  const finalizeOauthConnect = (
    operationId: string,
    identity?: { readonly hint?: string; readonly fingerprint?: string },
  ): Effect.Effect<
    ProviderAccountsConnectStatus,
    ProviderAccountConnectError | ProviderAccountStorageError
  > =>
    Effect.gen(function* () {
      const operation = yield* requireOperation("accountConnect.finalizeOauthConnect", operationId);
      if (operation.state !== "pending" && operation.state !== "waiting-for-user") {
        return yield* connectError(
          "accountConnect.finalizeOauthConnect",
          `Connect operation '${operationId}' is already ${operation.state}.`,
        );
      }
      const { provider } = operation;
      const ordinal =
        operation.reconnectOrdinal ??
        (yield* storage.finalizePendingDirectory(provider, operationId));
      const existing = yield* storage.readAccount(provider, ordinal);
      yield* storage.writeAccount(buildConnectedRecord(operation, existing, ordinal, identity));
      yield* activateIfFirst(provider, ordinal);
      operation.state = "succeeded";
      operation.ordinal = ordinal;
      return toStatus(operation);
    });

  const failOperation = (operation: ConnectOperation, detail: string) => {
    if (operation.state === "pending" || operation.state === "waiting-for-user") {
      operation.state = "failed";
      operation.error = detail;
    }
  };

  const startOauthLogin = (operation: ConnectOperation, profileHome: string) => {
    const runner = oauthLoginRunners[operation.provider];
    if (runner === undefined) {
      failOperation(
        operation,
        `Managed OAuth login is not implemented for provider '${operation.provider}'.`,
      );
      return;
    }
    const handle = runner({
      provider: operation.provider,
      profileHome,
      onVerification: (info) => {
        if (info.verificationUrl !== undefined) operation.verificationUrl = info.verificationUrl;
        if (info.userCode !== undefined) operation.userCode = info.userCode;
        if (operation.state === "pending") operation.state = "waiting-for-user";
      },
    });
    operation.loginHandle = handle;
    void handle.done.then(async (outcome) => {
      if (operation.state !== "pending" && operation.state !== "waiting-for-user") return;
      if (!outcome.ok) {
        failOperation(operation, outcome.error);
        await Effect.runPromise(
          storage
            .cancelPendingDirectory(operation.provider, operation.operationId)
            .pipe(Effect.ignore),
        );
        return;
      }
      await Effect.runPromise(
        finalizeOauthConnect(
          operation.operationId,
          outcome.identityHint !== undefined ? { hint: outcome.identityHint } : undefined,
        ).pipe(Effect.ignore),
      ).catch(() => undefined);
      const finalState = operations.get(operation.operationId)?.state;
      if (finalState !== "succeeded") {
        failOperation(operation, "Failed to finalize the OAuth connection.");
      }
    });
  };

  const beginConnect = (connectInput: ProviderAccountsBeginConnectInput) =>
    Effect.gen(function* () {
      const surface: AccountSurface = connectInput.kind === "app-oauth" ? "app" : "agent";
      const authMethod: AgentAuthMethod =
        connectInput.kind === "agent-api-key" ? "apiKey" : "oauth";
      const { provider } = connectInput;

      // Capability validation happens before any operation or filesystem
      // state exists: unsupported combinations are rejected outright.
      if (!isConnectSupported(provider, surface, authMethod)) {
        return yield* connectError(
          "accountConnect.beginConnect",
          `Connecting a managed '${provider}' account via ${surface} ${authMethod === "apiKey" ? "API key" : "OAuth"} is not supported.`,
        );
      }
      if (connectInput.ordinal !== undefined) {
        if (connectInput.ordinal === 0) {
          return yield* connectError(
            "accountConnect.beginConnect",
            "The native account 0 is not managed by Synara and cannot be reconnected.",
          );
        }
        if ((yield* storage.readAccount(provider, connectInput.ordinal)) === null) {
          return yield* connectError(
            "accountConnect.beginConnect",
            `Cannot reconnect missing account '${provider}' ordinal ${connectInput.ordinal}.`,
          );
        }
      }

      const operation: ConnectOperation = {
        operationId: randomUUID(),
        provider,
        surface,
        authMethod,
        ...(connectInput.ordinal !== undefined ? { reconnectOrdinal: connectInput.ordinal } : {}),
        ...(connectInput.kind === "agent-api-key" ? { apiKey: connectInput.apiKey } : {}),
        state: "pending",
      };
      operations.set(operation.operationId, operation);

      if (connectInput.kind === "agent-api-key") {
        // API-key connects need no external login step; finalize immediately.
        yield* finalizeApiKeyConnect(operation);
        return { operationId: operation.operationId };
      }

      // OAuth: new accounts log in inside a pending directory that only
      // becomes a numbered slot on success; reconnects log in directly into
      // the existing slot's profile home.
      let profileHome: string;
      if (connectInput.ordinal === undefined) {
        yield* storage.createPendingDirectory(provider, operation.operationId);
        // Persist non-secret metadata so a restart can surface the interrupted
        // operation as a truthful terminal state instead of "unknown".
        yield* storage.writePendingOperation(
          provider,
          operation.operationId,
          JSON.stringify({
            operationId: operation.operationId,
            provider,
            surface,
            authMethod,
            startedAt: now(),
          }),
        );
        profileHome = path.join(
          pendingPath(storage.root, provider, operation.operationId),
          "agent",
          "home",
        );
      } else {
        profileHome = accountAgentHome(storage.root, provider, connectInput.ordinal);
      }
      startOauthLogin(operation, profileHome);
      return { operationId: operation.operationId };
    });

  const getConnectStatus = (operationId: string) =>
    requireOperation("accountConnect.getConnectStatus", operationId).pipe(Effect.map(toStatus));

  const cancelConnect = (operationId: string) =>
    requireOperation("accountConnect.cancelConnect", operationId).pipe(
      Effect.flatMap((operation) =>
        Effect.gen(function* () {
          if (operation.state === "waiting-for-user" || operation.state === "pending") {
            operation.state = "cancelled";
            operation.loginHandle?.cancel();
            if (operation.reconnectOrdinal === undefined && operation.authMethod === "oauth") {
              yield* storage.cancelPendingDirectory(operation.provider, operation.operationId);
            }
            delete operation.apiKey;
          }
          return toStatus(operation);
        }),
      ),
    );

  const setActive = (provider: SupportedAccountProvider, ordinal: number) =>
    Effect.gen(function* () {
      if (ordinal !== 0) {
        const record = yield* storage.readAccount(provider, ordinal);
        if (record === null) {
          return yield* connectError(
            "accountConnect.setActive",
            `Cannot activate missing account '${provider}' ordinal ${ordinal}.`,
          );
        }
        // Activating an account without a usable agent binding would make
        // every new session fail; require a connected agent binding.
        if (record.agent === undefined || record.agent.state !== "connected") {
          return yield* connectError(
            "accountConnect.setActive",
            `Cannot activate account '${provider}' ordinal ${ordinal}: its agent binding is ${record.agent === undefined ? "not configured" : `'${record.agent.state}'`}. Reconnect it first.`,
          );
        }
      }
      yield* storage.writeActiveOrdinal(provider, ordinal);
    });

  const disconnectBinding = (
    provider: SupportedAccountProvider,
    ordinal: number,
    surface: AccountSurface,
  ) =>
    Effect.gen(function* () {
      if (ordinal === 0) {
        return yield* connectError(
          "accountConnect.disconnectBinding",
          "The native account 0 is not managed by Synara and cannot be disconnected.",
        );
      }
      const existing = yield* storage.readAccount(provider, ordinal);
      if (existing === null) {
        return yield* connectError(
          "accountConnect.disconnectBinding",
          `Cannot disconnect missing account '${provider}' ordinal ${ordinal}.`,
        );
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
      if (ordinal === 0) {
        return yield* connectError("accountConnect.hide", "The native account 0 cannot be hidden.");
      }
      yield* storage.hideAccount(provider, ordinal);
      if ((yield* storage.readActiveOrdinal(provider)) === ordinal) {
        yield* storage.writeActiveOrdinal(provider, 0);
      }
    });

  // Startup recovery: pending directories left behind by a previous process
  // are interrupted OAuth connects. Register each as a failed operation so
  // status queries return a truthful terminal state, then remove the
  // directories so no ordinal or disk state leaks.
  const recoverInterruptedOperations = Effect.gen(function* () {
    for (const provider of SupportedAccountProvider.literals) {
      const pendingIds = yield* storage
        .listPendingOperations(provider)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
      for (const operationId of pendingIds) {
        const raw = yield* storage
          .readPendingOperation(provider, operationId)
          .pipe(Effect.orElseSucceed(() => null));
        let surface: AccountSurface = "agent";
        let authMethod: AgentAuthMethod = "oauth";
        if (raw !== null) {
          try {
            const parsed = JSON.parse(raw) as {
              surface?: AccountSurface;
              authMethod?: AgentAuthMethod;
            };
            if (parsed.surface === "agent" || parsed.surface === "app") surface = parsed.surface;
            if (parsed.authMethod === "oauth" || parsed.authMethod === "apiKey") {
              authMethod = parsed.authMethod;
            }
          } catch {
            // Corrupted metadata still yields a terminal failed status.
          }
        }
        operations.set(operationId, {
          operationId,
          provider,
          surface,
          authMethod,
          state: "failed",
          error: "The connect operation was interrupted by a server restart. Start a new connect.",
        });
      }
      yield* storage.cleanupPendingDirectories(provider);
    }
  });

  return {
    beginConnect,
    recoverInterruptedOperations,
    getConnectStatus,
    cancelConnect,
    setActive,
    disconnectBinding,
    hide,
  };
}

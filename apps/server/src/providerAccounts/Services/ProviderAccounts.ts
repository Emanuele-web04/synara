// FILE: ProviderAccounts.ts
// Purpose: Provider account management service contract (plan sections 9-13, 38).
// Layer: Server service contract
// Exports: ProviderAccounts, ProviderAccountsShape, ProviderAccountsError.

import type {
  ProviderAccountsBeginConnectInput,
  ProviderAccountsBeginConnectResult,
  ProviderAccountsConnectStatus,
  ProviderAccountsDisconnectBindingInput,
  ProviderAccountsDoctorReport,
  ProviderAccountsGetThreadBindingInput,
  ProviderAccountsHideInput,
  ProviderAccountsIntegrationStatus,
  ProviderAccountsLaunchInput,
  ProviderAccountsLaunchResult,
  ProviderAccountsOperationInput,
  ProviderAccountsSetActiveInput,
  ProviderAccountsSnapshot,
  ProviderAccountsThreadBinding,
  ProviderAccountsUpdateCliIntegrationInput,
  ResolveAccountLaunchInput,
  ResolvedAccountLaunch,
} from "@synara/contracts";
import { Data, ServiceMap } from "effect";
import type { Effect } from "effect";

export class ProviderAccountsError extends Data.TaggedError("ProviderAccountsError")<{
  readonly operation: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export interface ProviderAccountsShape {
  readonly getSnapshot: Effect.Effect<ProviderAccountsSnapshot, ProviderAccountsError>;
  readonly beginConnect: (
    input: ProviderAccountsBeginConnectInput,
  ) => Effect.Effect<ProviderAccountsBeginConnectResult, ProviderAccountsError>;
  readonly getConnectStatus: (
    input: ProviderAccountsOperationInput,
  ) => Effect.Effect<ProviderAccountsConnectStatus, ProviderAccountsError>;
  readonly cancelConnect: (
    input: ProviderAccountsOperationInput,
  ) => Effect.Effect<ProviderAccountsConnectStatus, ProviderAccountsError>;
  readonly setActive: (
    input: ProviderAccountsSetActiveInput,
  ) => Effect.Effect<void, ProviderAccountsError>;
  readonly disconnectBinding: (
    input: ProviderAccountsDisconnectBindingInput,
  ) => Effect.Effect<void, ProviderAccountsError>;
  readonly hide: (input: ProviderAccountsHideInput) => Effect.Effect<void, ProviderAccountsError>;
  readonly launch: (
    input: ProviderAccountsLaunchInput,
  ) => Effect.Effect<ProviderAccountsLaunchResult, ProviderAccountsError>;
  readonly getIntegrationStatus: Effect.Effect<
    ProviderAccountsIntegrationStatus,
    ProviderAccountsError
  >;
  readonly updateCliIntegration: (
    input: ProviderAccountsUpdateCliIntegrationInput,
  ) => Effect.Effect<ProviderAccountsIntegrationStatus, ProviderAccountsError>;
  readonly getDoctorReport: Effect.Effect<ProviderAccountsDoctorReport, ProviderAccountsError>;
  readonly getThreadBinding: (
    input: ProviderAccountsGetThreadBindingInput,
  ) => Effect.Effect<ProviderAccountsThreadBinding, ProviderAccountsError>;

  /**
   * Server-private launch resolution: the returned environment and profile
   * path must never be sent over public RPC surfaces.
   */
  readonly resolveLaunch: (
    input: ResolveAccountLaunchInput,
  ) => Effect.Effect<ResolvedAccountLaunch, ProviderAccountsError>;
}

export class ProviderAccounts extends ServiceMap.Service<ProviderAccounts, ProviderAccountsShape>()(
  "synara/providerAccounts/Services/ProviderAccounts",
) {}

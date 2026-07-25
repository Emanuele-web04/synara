// FILE: ProviderAccounts.ts
// Purpose: Live provider account management service (plan sections 9-13, 38).
// Layer: Server service implementation
// Exports: ProviderAccountsLive, makeProviderAccounts.

import "../claudeAppLaunch";

import {
  ProviderAccountsSnapshot,
  SupportedAccountProvider,
  type ProviderAccountRecord,
  type ProviderAccountView,
} from "@synara/contracts";
import { authCapabilities } from "@synara/shared/providerAccounts/capabilities";
import { resolveAccountRoot } from "@synara/shared/providerAccounts/accountPaths";
import { Effect, Layer, Option, Schema } from "effect";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory";
import { readAccountBindingFromRuntimePayload } from "../../provider/accountBindingPayload";
import { makeAccountConnect } from "../accountConnect";
import { makeAccountResolver } from "../accountResolver";
import { makeAppLaunch } from "../appLaunch";
import { makeAccountStorage } from "../accountStorage";
import {
  ProviderAccounts,
  ProviderAccountsError,
  type ProviderAccountsShape,
} from "../Services/ProviderAccounts";

const SUPPORTED_PROVIDERS = SupportedAccountProvider.literals;

const toView = (record: ProviderAccountRecord): ProviderAccountView => ({
  provider: record.provider,
  ordinal: record.ordinal,
  createdAt: record.createdAt,
  ...(record.identity !== undefined
    ? {
        identity: {
          ...(record.identity.hint !== undefined ? { hint: record.identity.hint } : {}),
          ...(record.identity.plan !== undefined ? { plan: record.identity.plan } : {}),
        },
      }
    : {}),
  ...(record.agent !== undefined
    ? {
        agent: {
          generation: record.agent.generation,
          state: record.agent.state,
          authMethod: record.agent.authMethod,
        },
      }
    : {}),
  ...(record.app !== undefined
    ? {
        app: {
          generation: record.app.generation,
          state: record.app.state,
          supportLevel: record.app.supportLevel,
          ...(record.app.lastVerifiedAppVersion !== undefined
            ? { lastVerifiedAppVersion: record.app.lastVerifiedAppVersion }
            : {}),
          ...(record.app.lastVerifiedAt !== undefined
            ? { lastVerifiedAt: record.app.lastVerifiedAt }
            : {}),
        },
      }
    : {}),
});

export const makeProviderAccounts = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore;
  const directory = yield* ProviderSessionDirectory;
  const storage = makeAccountStorage({
    root: resolveAccountRoot({ env: process.env }),
    secretStore,
  });
  const connect = makeAccountConnect({ storage });
  const resolver = makeAccountResolver({ storage });
  const appLaunch = makeAppLaunch({ storage, resolver });

  yield* storage.ensureRoot.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("providerAccounts.account_root_init_failed", { cause }),
    ),
  );

  const fail = (operation: string) => (cause: unknown) =>
    new ProviderAccountsError({
      operation,
      detail:
        typeof cause === "object" && cause !== null && "detail" in cause
          ? String((cause as { detail: unknown }).detail)
          : "Provider account operation failed.",
      cause,
    });

  const getSnapshot: ProviderAccountsShape["getSnapshot"] = Effect.gen(function* () {
    const providers = yield* Effect.forEach(SUPPORTED_PROVIDERS, (provider) =>
      Effect.gen(function* () {
        const records = yield* storage.listAccounts(provider);
        const visible: Array<ProviderAccountView> = [];
        for (const record of records) {
          if (!(yield* storage.isAccountHidden(provider, record.ordinal))) {
            visible.push(toView(record));
          }
        }
        return {
          provider,
          activeOrdinal: (yield* storage.readActiveOrdinal(provider)) ?? 0,
          accounts: visible,
          capabilities: authCapabilities(provider),
        };
      }),
    );
    return { providers } satisfies ProviderAccountsSnapshot;
  }).pipe(Effect.mapError(fail("providerAccounts.getSnapshot")));

  const service: ProviderAccountsShape = {
    getSnapshot,
    beginConnect: (input) =>
      connect.beginConnect(input).pipe(Effect.mapError(fail("providerAccounts.beginConnect"))),
    getConnectStatus: (input) =>
      connect
        .getConnectStatus(input.operationId)
        .pipe(Effect.mapError(fail("providerAccounts.getConnectStatus"))),
    cancelConnect: (input) =>
      connect
        .cancelConnect(input.operationId)
        .pipe(Effect.mapError(fail("providerAccounts.cancelConnect"))),
    setActive: (input) =>
      connect
        .setActive(input.provider, input.ordinal)
        .pipe(Effect.mapError(fail("providerAccounts.setActive"))),
    disconnectBinding: (input) =>
      connect
        .disconnectBinding(input.provider, input.ordinal, input.surface)
        .pipe(Effect.mapError(fail("providerAccounts.disconnectBinding"))),
    hide: (input) =>
      connect
        .hide(input.provider, input.ordinal)
        .pipe(Effect.mapError(fail("providerAccounts.hide"))),
    launch: (input) =>
      input.surface === "app"
        ? appLaunch
            .planAppLaunch({
              provider: input.provider,
              ...(input.ordinal !== undefined ? { explicitOrdinal: input.ordinal } : {}),
            })
            .pipe(
              Effect.flatMap((plan) =>
                appLaunch.launchApp(plan).pipe(
                  Effect.map(() => ({
                    launched: true,
                    ordinal: plan.ordinal,
                    supportLevel: plan.supportLevel,
                  })),
                ),
              ),
              Effect.mapError(fail("providerAccounts.launch")),
            )
        : // Standalone agent CLI launching ships with the launcher work; resolve only.
          resolver
            .resolveAccountLaunch({
              provider: input.provider,
              surface: input.surface,
              ...(input.ordinal !== undefined ? { explicitOrdinal: input.ordinal } : {}),
            })
            .pipe(
              Effect.map((resolved) => ({
                launched: false,
                ordinal: resolved.ordinal,
                supportLevel: resolved.supportLevel,
              })),
              Effect.mapError(fail("providerAccounts.launch")),
            ),
    getIntegrationStatus: Effect.succeed({
      cliIntegrationEnabled: false,
      launcherInstalled: false,
    }),
    updateCliIntegration: () =>
      Effect.fail(
        new ProviderAccountsError({
          operation: "providerAccounts.updateCliIntegration",
          detail: "CLI integration is not available yet.",
        }),
      ),
    getDoctorReport: Effect.gen(function* () {
      const version = yield* storage.readVersion;
      return {
        generatedAt: new Date().toISOString(),
        checks: [
          {
            id: "account-root",
            label: "Account root",
            status: version === null ? ("warning" as const) : ("ok" as const),
            ...(version === null
              ? { detail: "Account root is not initialized yet." }
              : { detail: `Schema version ${version}.` }),
          },
        ],
      };
    }).pipe(Effect.mapError(fail("providerAccounts.getDoctorReport"))),
    getThreadBinding: (input) =>
      Effect.gen(function* () {
        const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
        const accountBinding =
          binding === undefined
            ? undefined
            : readAccountBindingFromRuntimePayload(binding.runtimePayload);
        if (
          binding === undefined ||
          accountBinding === undefined ||
          !Schema.is(SupportedAccountProvider)(binding.provider)
        ) {
          return {};
        }
        return {
          binding: {
            provider: binding.provider,
            ordinal: accountBinding.ordinal,
            agentGeneration: accountBinding.agentGeneration,
          },
        };
      }).pipe(Effect.mapError(fail("providerAccounts.getThreadBinding"))),
    resolveLaunch: (input) =>
      resolver
        .resolveAccountLaunch(input)
        .pipe(Effect.mapError(fail("providerAccounts.resolveLaunch"))),
    planAppLaunch: (input) =>
      appLaunch.planAppLaunch(input).pipe(Effect.mapError(fail("providerAccounts.planAppLaunch"))),
  };

  return service;
});

export const ProviderAccountsLive = Layer.effect(ProviderAccounts, makeProviderAccounts);

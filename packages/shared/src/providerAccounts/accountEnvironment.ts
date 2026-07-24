// FILE: accountEnvironment.ts
// Purpose: Provider environment builder registry for managed account launches.
// Layer: Cross-package pure utility (plan section 13); used by the server
//        resolver and the standalone account launcher.
// Exports: registerAccountEnvironmentBuilder, resolveAccountEnvironmentBuilder,
//          applyAccountEnvironmentOverrides, ACCOUNT_ENV_UNSET.

import type {
  AgentAuthMethod,
  ProcessEnvRecord,
  SupportedAccountProvider,
} from "@synara/contracts";

/**
 * Sentinel value inside an account environment record meaning "remove this
 * variable from the child environment". `ProcessEnvRecord` cannot carry
 * undefined values, so conflicting inherited auth overrides are stripped by
 * mapping them to this empty-string marker.
 */
export const ACCOUNT_ENV_UNSET = "";

export interface AccountEnvironmentBuildInput {
  readonly provider: SupportedAccountProvider;
  readonly ordinal: number;
  readonly authMethod: AgentAuthMethod;
  readonly agentHome: string;
  readonly apiKey?: string;
}

export interface AccountLaunchEnvironment {
  readonly environment: ProcessEnvRecord;
  readonly profilePath: string;
}

export type AccountEnvironmentBuilder = (
  input: AccountEnvironmentBuildInput,
) => AccountLaunchEnvironment;

// Providers register their builder from their own module (see
// codexAccountEnvironment.ts); adding a provider never edits a central switch.
// TODO(PR3-PR5): register claudeAgent, cursor, and grok builders.
const builders = new Map<SupportedAccountProvider, AccountEnvironmentBuilder>();

export function registerAccountEnvironmentBuilder(
  provider: SupportedAccountProvider,
  builder: AccountEnvironmentBuilder,
): void {
  builders.set(provider, builder);
}

export function resolveAccountEnvironmentBuilder(
  provider: SupportedAccountProvider,
): AccountEnvironmentBuilder | undefined {
  return builders.get(provider);
}

/** Applies account environment overrides onto a child process environment. */
export function applyAccountEnvironmentOverrides(
  env: NodeJS.ProcessEnv,
  overrides: ProcessEnvRecord,
): NodeJS.ProcessEnv {
  for (const [name, value] of Object.entries(overrides)) {
    if (value === ACCOUNT_ENV_UNSET) {
      delete env[name];
    } else {
      env[name] = value;
    }
  }
  return env;
}

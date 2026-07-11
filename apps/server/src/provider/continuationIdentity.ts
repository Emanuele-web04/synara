// FILE: continuationIdentity.ts
// Purpose: Identifies provider-native session storage independently from account/runtime options.
// Layer: Server provider utility.

import { homedir } from "node:os";
import path from "node:path";

import type { ProviderKind, ProviderStartOptions } from "@synara/contracts";

import { resolveActiveCodexHomeWritePath, resolveBaseCodexHomePath } from "../codexHomePaths.ts";
import { resolveCodexPathIdentity } from "../codexPathIdentity.ts";
import {
  isCodexSharedContinuationStatePrepared,
  prepareCodexHomeOverlay,
  type CodexProcessEnvInput,
} from "../codexProcessEnv.ts";
import { expandProviderAccountHomePath } from "../providerAccountHomePath.ts";

function canonicalStoragePath(value: string): string {
  return resolveCodexPathIdentity(value);
}

function codexContinuationInput(options: ProviderStartOptions | undefined): Pick<
  CodexProcessEnvInput,
  "homePath" | "shadowHomePath" | "accountId"
> & {
  readonly env: NodeJS.ProcessEnv;
} {
  const codex = options?.codex;
  return {
    env: { ...process.env, ...codex?.environment },
    ...(codex?.homePath ? { homePath: codex.homePath } : {}),
    ...(codex?.shadowHomePath ? { shadowHomePath: codex.shadowHomePath } : {}),
    ...(codex?.accountId ? { accountId: codex.accountId } : {}),
  };
}

function sharedCodexContinuationIdentity(input: ReturnType<typeof codexContinuationInput>): string {
  return `codex:shared-v1:${canonicalStoragePath(
    resolveBaseCodexHomePath(input.env, input.homePath),
  )}`;
}

/**
 * Prepares provider-native storage before evaluating whether an existing
 * resume cursor can be reused. Codex account overlays must be materialized
 * first; otherwise a new account temporarily reports its overlay identity
 * even when it safely shares the existing source store.
 */
export function prepareProviderContinuationIdentity(
  provider: ProviderKind,
  options: ProviderStartOptions | undefined,
  persistedIdentity: string | undefined,
): string | undefined {
  if (provider === "codex") {
    const continuationInput = codexContinuationInput(options);
    const candidateSharedIdentity = sharedCodexContinuationIdentity(continuationInput);
    // Only materialize a target overlay when it could satisfy an existing
    // shared-source identity. Different homes and legacy overlay identities
    // are already incompatible without creating any new filesystem state.
    if (persistedIdentity === candidateSharedIdentity) {
      prepareCodexHomeOverlay(continuationInput);
    }
  }
  return providerContinuationIdentity(provider, options);
}

/**
 * Returns the identity of the storage that owns a provider-native resume
 * cursor. Account auth, binary paths, and turn settings deliberately do not
 * participate: two Codex account overlays can safely resume the same thread
 * only when they share the same source CODEX_HOME session store.
 */
export function providerContinuationIdentity(
  provider: ProviderKind,
  options: ProviderStartOptions | undefined,
): string | undefined {
  switch (provider) {
    case "codex": {
      const continuationInput = codexContinuationInput(options);
      if (isCodexSharedContinuationStatePrepared(continuationInput)) {
        return sharedCodexContinuationIdentity(continuationInput);
      }
      // Before shared-state preparation succeeds, bind continuation to the
      // effective overlay. This lets the same account recover exactly while
      // preventing another account overlay from claiming access to state it
      // may not actually share yet.
      const overlayHome = resolveActiveCodexHomeWritePath(continuationInput);
      return `codex:overlay-v1:${canonicalStoragePath(overlayHome)}`;
    }
    case "claudeAgent": {
      const claude = options?.claudeAgent;
      const env = { ...process.env, ...claude?.environment };
      const fallbackHome = homedir();
      const explicitHome = claude?.homePath?.trim();
      // An explicit home deliberately drops an inherited CLAUDE_CONFIG_DIR;
      // without one, the final merged environment remains authoritative.
      const configuredRoot = explicitHome
        ? claude?.environment?.CLAUDE_CONFIG_DIR?.trim()
        : env.CLAUDE_CONFIG_DIR?.trim();
      const effectiveHome = explicitHome
        ? expandProviderAccountHomePath(explicitHome, fallbackHome)
        : env.HOME?.trim() || fallbackHome;
      const storageRoot = configuredRoot
        ? expandProviderAccountHomePath(configuredRoot, effectiveHome)
        : path.join(effectiveHome, ".claude");
      return `claudeAgent:${canonicalStoragePath(storageRoot)}`;
    }
    default:
      return undefined;
  }
}

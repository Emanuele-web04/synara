// FILE: continuationIdentity.ts
// Purpose: Identifies provider-native session storage independently from account/runtime options.
// Layer: Server provider utility.

import { homedir } from "node:os";
import path from "node:path";

import type { ProviderKind, ProviderStartOptions } from "@synara/contracts";

import { resolveActiveCodexHomeWritePath, resolveBaseCodexHomePath } from "../codexHomePaths.ts";
import { resolveCodexPathIdentity } from "../codexPathIdentity.ts";
import {
  prepareCodexHomeOverlayFromPreparedContinuationSource,
  readCodexSharedContinuationGeneration,
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

const CODEX_SHARED_CONTINUATION_V1_PREFIX = "codex:shared-v1:";
const CODEX_SHARED_CONTINUATION_V2_PREFIX = "codex:shared-v2:";
const CODEX_SHARED_CONTINUATION_GENERATION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ParsedCodexSharedContinuationIdentity =
  | { readonly version: 1; readonly sourceIdentity: string }
  | {
      readonly version: 2;
      readonly generation: string;
      readonly sourceIdentity: string;
    };

/**
 * Parses only the fixed protocol prefix and UUID field. The source path is the
 * untouched remainder, so a Windows identity such as `C:\\Users\\...` keeps
 * its drive-letter colon instead of being split as another protocol field.
 */
export function parseCodexSharedContinuationIdentity(
  value: string | undefined,
): ParsedCodexSharedContinuationIdentity | undefined {
  if (!value) return undefined;
  if (value.startsWith(CODEX_SHARED_CONTINUATION_V1_PREFIX)) {
    const sourceIdentity = value.slice(CODEX_SHARED_CONTINUATION_V1_PREFIX.length);
    return sourceIdentity ? { version: 1, sourceIdentity } : undefined;
  }
  if (!value.startsWith(CODEX_SHARED_CONTINUATION_V2_PREFIX)) return undefined;
  const generationStart = CODEX_SHARED_CONTINUATION_V2_PREFIX.length;
  const generationEnd = value.indexOf(":", generationStart);
  if (generationEnd < 0) return undefined;
  const generation = value.slice(generationStart, generationEnd);
  const sourceIdentity = value.slice(generationEnd + 1);
  if (!CODEX_SHARED_CONTINUATION_GENERATION_PATTERN.test(generation) || !sourceIdentity) {
    return undefined;
  }
  return { version: 2, generation: generation.toLowerCase(), sourceIdentity };
}

export function codexSharedContinuationGeneration(
  identity: string | undefined,
): string | undefined {
  const parsed = parseCodexSharedContinuationIdentity(identity);
  return parsed?.version === 2 ? parsed.generation : undefined;
}

export function codexSharedContinuationIdentityIsSafeMigration(input: {
  readonly persistedIdentity: string;
  readonly currentIdentity: string | undefined;
}): boolean {
  const persisted = parseCodexSharedContinuationIdentity(input.persistedIdentity);
  const current = parseCodexSharedContinuationIdentity(input.currentIdentity);
  return (
    persisted?.version === 1 &&
    current?.version === 2 &&
    persisted.sourceIdentity === current.sourceIdentity
  );
}

function sharedCodexContinuationIdentity(
  input: ReturnType<typeof codexContinuationInput>,
  generation: string,
): string {
  return `codex:shared-v2:${generation}:${canonicalStoragePath(
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
    const persistedSharedIdentity = parseCodexSharedContinuationIdentity(persistedIdentity);
    const candidateSourceIdentity = canonicalStoragePath(
      resolveBaseCodexHomePath(continuationInput.env, continuationInput.homePath),
    );
    // Only materialize a target overlay when it could satisfy an existing
    // shared-source identity. Different homes and legacy overlay identities
    // are already incompatible without creating any new filesystem state.
    if (persistedSharedIdentity?.sourceIdentity === candidateSourceIdentity) {
      prepareCodexHomeOverlayFromPreparedContinuationSource({
        ...continuationInput,
        ...(persistedSharedIdentity.version === 2
          ? {
              expectedSharedContinuationGeneration: persistedSharedIdentity.generation,
            }
          : { allowLegacySharedContinuationMigration: true }),
      });
    }
  }
  return providerContinuationIdentity(provider, options);
}

/**
 * Validates the selected native store for a caller-supplied Codex resume
 * cursor that has no persisted Synara binding yet. This path accepts only an
 * already prepared v2 source, repairs the selected target overlay, and returns
 * the generation identity that must be pinned through the real launch.
 */
export function prepareProviderContinuationIdentityForExplicitResume(
  provider: ProviderKind,
  options: ProviderStartOptions | undefined,
): string | undefined {
  if (provider === "codex") {
    prepareCodexHomeOverlayFromPreparedContinuationSource(codexContinuationInput(options));
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
      const generation = readCodexSharedContinuationGeneration(continuationInput);
      if (generation) {
        return sharedCodexContinuationIdentity(continuationInput, generation);
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

// FILE: continuationIdentity.ts
// Purpose: Identifies provider-native session storage independently from account/runtime options.
// Layer: Server provider utility.

import { homedir } from "node:os";
import path from "node:path";

import type { ProviderKind, ProviderStartOptions } from "@synara/contracts";

import { resolveBaseCodexHomePath } from "../codexHomePaths.ts";
import { resolveCodexPathIdentity } from "../codexPathIdentity.ts";

function expandHomePath(value: string, fallbackHome: string): string {
  if (value === "~") return fallbackHome;
  if (!value.startsWith("~/") && !value.startsWith("~\\")) return value;

  const segments = value
    .slice(2)
    .split(/[\\/]+/u)
    .filter((segment) => segment.length > 0);
  return segments.length === 0 ? fallbackHome : path.join(fallbackHome, ...segments);
}

function canonicalStoragePath(value: string): string {
  return resolveCodexPathIdentity(value);
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
      const codex = options?.codex;
      const env = { ...process.env, ...codex?.environment };
      const sourceHome = resolveBaseCodexHomePath(env, codex?.homePath);
      return `codex:${canonicalStoragePath(sourceHome)}`;
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
        ? expandHomePath(explicitHome, fallbackHome)
        : env.HOME?.trim() || fallbackHome;
      const storageRoot = configuredRoot
        ? expandHomePath(configuredRoot, effectiveHome)
        : path.join(effectiveHome, ".claude");
      return `claudeAgent:${canonicalStoragePath(storageRoot)}`;
    }
    default:
      return undefined;
  }
}

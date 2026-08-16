// FILE: DiscoveryService.ts
// Purpose: Orchestrates KAR-525 deterministic discovery: local recipe lookup
//          (via BinaryRecipeResolver) ∪ upstream ACP Registry catalog ∪
//          user-supplied custom absolute paths → ordered ConnectionCandidate[].
//
// Ordering is deterministic: local recipe candidates first (they are directly
// launchable), then registry-only entries, then custom paths. The recipe
// overlay (shared contracts) may demote a registry entry via `compatibility`.
//
// This service is the READ-ONLY discovery surface KAR-526's Add Agent UI will
// call. It never installs anything and never emits a shell command — the
// registry distribution facts are passed through only as structured display
// metadata (AC #6).
//
// NOTE: the bounded ACP `initialize` probe (AcpProbe.ts) is intentionally NOT
// run per-candidate in `listCandidates`: listing must stay cheap and offline.
// KAR-526 drives the probe for a focused candidate when the UI needs the
// agent's advertised identity/capabilities. Version probes (BinaryRecipeResolver)
// already run during list because they are bounded and needed for the
// missing-vs-unsupported distinction (AC #3).
// Layer: Server discovery
import { Effect, FileSystem, Layer, Path, ServiceMap } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  AGENT_RECIPES,
  RECIPE_BY_AGENT_ID,
  type AcpRegistryEntry,
  type ConnectionCandidate,
} from "@synara/contracts";
import { ServerConfig } from "../config.ts";

import { BinaryRecipeResolver, BinaryRecipeResolverLive } from "./BinaryRecipeResolver.ts";
import { AcpRegistryClient, AcpRegistryClientLive } from "./AcpRegistryClient.ts";
import { acpRegistryCatalogFromDocument } from "./AcpRegistryCatalog.ts";

export interface DiscoveryOptions {
  /** Custom absolute executable paths the user wants listed (KAR-526 can add). */
  readonly customCommands?: ReadonlyArray<string>;
}

export interface DiscoveryServiceOptions {
  /**
   * Recipe overlay (agentId → recipe) used to stamp compatibility onto
   * registry entries and demote `listed: false` agents (AC #5). Defaults to
   * the built-in shared overlay; tests inject a synthetic map.
   */
  readonly recipes?: ReadonlyMap<string, import("@synara/contracts").AgentRecipeDefinition>;
}

export interface DiscoveryResult {
  readonly candidates: ReadonlyArray<ConnectionCandidate>;
  readonly registryStatus: {
    readonly available: boolean;
    readonly fetchedAt?: string;
    readonly registryVersion?: string;
    readonly error?: string;
  };
}

export interface DiscoveryServiceShape {
  readonly listCandidates: (
    options?: DiscoveryOptions,
  ) => Effect.Effect<
    DiscoveryResult,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | ServerConfig
  >;
}

export class DiscoveryService extends ServiceMap.Service<DiscoveryService, DiscoveryServiceShape>()(
  "synara/discovery/DiscoveryService",
) {}

/**
 * Build one display-only registry candidate from a catalog entry. It carries
 * the upstream provenance + structured distribution facts, is LISTED, but has
 * no local binary and no endpoint, so `buildConnectionPlan` refuses to turn it
 * into a launch plan until KAR-526 installs it.
 *
 * AC #5 (recipe overlay): the local recipe overlay is joined onto registry
 * entries by agent id WITHOUT copying registry data. When the overlay marks an
 * agent `listed: false`, the entry is demoted to a hidden/unlisted overlay
 * entry; otherwise the recipe's compatibility facts are stamped onto the
 * candidate (which shares the recipe's own `listed` default of true).
 */
function registryCandidate(
  entry: AcpRegistryEntry,
  order: number,
  compatibility?: ConnectionCandidate["compatibility"],
): ConnectionCandidate | undefined {
  // Overlay says broken for us → do not surface it in discovery.
  if (compatibility?.listed === false) return undefined;

  const catalyst: ConnectionCandidate = {
    candidateId: `registry:${entry.agentId}`,
    agentId: entry.agentId,
    displayName: entry.name,
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    source: "registry",
    ...(entry.distribution !== undefined
      ? {
          install: {
            kind: entry.distribution.kind,
            ...(entry.distribution.package !== undefined
              ? { package: entry.distribution.package }
              : {}),
          } satisfies ConnectionCandidate["install"],
        }
      : {}),
    ...(compatibility !== undefined ? { compatibility } : {}),
    provenance: {
      source: "registry",
      ...(entry.registry?.registryVersion !== undefined
        ? { version: entry.registry.registryVersion }
        : {}),
    },
    registry: entry,
    order,
  };
  return catalyst;
}

export const makeDiscoveryService = (serviceOptions: DiscoveryServiceOptions = {}) =>
  Effect.gen(function* () {
    const recipeResolver = yield* BinaryRecipeResolver;
    const registryClient = yield* AcpRegistryClient;
    const recipes = serviceOptions.recipes ?? RECIPE_BY_AGENT_ID;

    const listCandidates: DiscoveryServiceShape["listCandidates"] = (options) =>
      Effect.gen(function* () {
        const candidates: ConnectionCandidate[] = [];
        let order = 0;

        // 1. Local recipe candidates (directly launchable, one per absolute PATH hit).
        for (const recipe of AGENT_RECIPES) {
          const resolved = yield* recipeResolver.resolveRecipe(recipe);
          for (const candidate of resolved.candidates) {
            candidates.push({ ...candidate, order: order++ });
          }
        }

        // 2. Upstream registry entries (provenance-stamped display candidates),
        //    overlaid with the local recipe compatibility map (AC #5).
        const registry = yield* registryClient.getSnapshot;
        let registryStatus: DiscoveryResult["registryStatus"];
        if (registry.status === "available") {
          const catalog = acpRegistryCatalogFromDocument(registry.snapshot.document, {
            fetchedAt: registry.snapshot.fetchedAt,
          });
          for (const entry of catalog.entries) {
            const compatibility = recipes.get(entry.agentId)?.compatibility;
            const candidate = registryCandidate(entry, order++, compatibility);
            if (candidate === undefined) continue;
            candidates.push(candidate);
          }
          registryStatus = {
            available: true,
            fetchedAt: registry.snapshot.fetchedAt,
            ...(registry.snapshot.document.version !== undefined
              ? { registryVersion: registry.snapshot.document.version }
              : {}),
          };
        } else {
          registryStatus = { available: false, error: registry.error };
        }

        // 3. Custom absolute paths (user-supplied, KAR-526 can add more).
        for (const command of options?.customCommands ?? []) {
          candidates.push({
            candidateId: `custom:${command}`,
            agentId: "custom",
            displayName: command,
            source: "custom",
            resolvedPath: command,
            provenance: { source: "custom" },
            order: order++,
          });
        }

        return {
          candidates,
          registryStatus,
        } satisfies DiscoveryResult;
      });

    return { listCandidates } satisfies DiscoveryServiceShape;
  });

export const DiscoveryServiceLive = Layer.effect(
  DiscoveryService,
  makeDiscoveryService().pipe(
    Effect.provide(Layer.mergeAll(BinaryRecipeResolverLive, AcpRegistryClientLive)),
  ),
);

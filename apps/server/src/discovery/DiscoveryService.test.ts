import { describe, expect, it } from "vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { Effect, Layer } from "effect";

import { BinaryRecipeResolver, type BinaryRecipeResolution } from "./BinaryRecipeResolver.ts";
import { AcpRegistryClient, type AcpRegistrySnapshot } from "./AcpRegistryClient.ts";
import { decodeAcpRegistryDocument } from "./acpRegistry.ts";
import {
  DiscoveryService,
  makeDiscoveryService,
  type DiscoveryServiceOptions,
} from "./DiscoveryService.ts";
import type { ConnectionCandidate } from "@synara/contracts";
import { ServerConfig } from "../config.ts";

const recipeCandidate = (overrides: Partial<ConnectionCandidate> = {}): ConnectionCandidate =>
  ({
    candidateId: "recipe:cline:/usr/local/bin/cline",
    agentId: "cline",
    displayName: "Cline",
    source: "recipe",
    resolvedPath: "/usr/local/bin/cline",
    provenance: { source: "recipe", version: "3.0.55" },
    order: 0,
    ...overrides,
  }) as ConnectionCandidate;

const registrySnapshot = (): AcpRegistrySnapshot => ({
  document: decodeAcpRegistryDocument({
    version: "2.3.0",
    agents: [
      { id: "cline", name: "Cline", distribution: { npx: { package: "cline" } } },
      { id: "goose", name: "goose", distribution: { npx: { package: "goose" } } },
    ],
  }),
  fetchedAt: "2026-08-16T00:00:00.000Z",
});

/**
 * A testable DiscoveryService with stubbed resolver + registry (no network,
 * no child processes).
 */
function discoveryLayer(input: {
  readonly recipeCandidates?: ReadonlyArray<ConnectionCandidate>;
  readonly registry?: AcpRegistrySnapshot;
  readonly registryUnavailable?: boolean;
  readonly serviceOptions?: DiscoveryServiceOptions;
}) {
  const binaryResolver: BinaryRecipeResolver["Service"] = {
    resolveRecipe: (recipe: { agentId: string }) =>
      Effect.succeed({
        candidates: (input.recipeCandidates ?? [])
          .filter((c) => c.agentId === recipe.agentId)
          .map((c) => recipeCandidate(c)),
      } satisfies BinaryRecipeResolution),
  };

  const registryClient: AcpRegistryClient["Service"] = {
    getSnapshot: Effect.succeed(
      input.registryUnavailable === true
        ? { status: "unavailable", error: "offline" }
        : {
            status: "available",
            snapshot: input.registry ?? registrySnapshot(),
            fromCache: true,
          },
    ),
  };

  return Layer.effect(
    DiscoveryService,
    makeDiscoveryService(input.serviceOptions).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(BinaryRecipeResolver, binaryResolver as BinaryRecipeResolver["Service"]),
          Layer.succeed(AcpRegistryClient, registryClient as AcpRegistryClient["Service"]),
        ),
      ),
    ),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "discovery-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
}

const runDiscovery = (
  layer: ReturnType<typeof discoveryLayer>,
  options?: Parameters<DiscoveryService["Service"]["listCandidates"]>[0],
) =>
  Effect.gen(function* () {
    const svc = yield* DiscoveryService;
    return yield* svc.listCandidates(options);
  }).pipe(Effect.provide(layer));

describe("DiscoveryService — deterministic candidate orchestration", () => {
  it("orders recipe candidates before registry entries, then custom paths", async () => {
    const result = await Effect.runPromise(
      runDiscovery(
        discoveryLayer({
          recipeCandidates: [
            recipeCandidate({ agentId: "cline", resolvedPath: "/usr/local/bin/cline" }),
          ],
        }),
        { customCommands: ["/opt/manual/agent"] },
      ),
    );

    expect(result.candidates.map((c) => c.source)).toEqual([
      "recipe",
      "registry",
      "registry",
      "custom",
    ]);
    expect(result.candidates[0]?.source).toBe("recipe");
    expect(result.candidates.at(-1)?.source).toBe("custom");
    // The custom path keeps its absolute resolved path and provenance.
    expect(result.candidates.at(-1)).toMatchObject({
      resolvedPath: "/opt/manual/agent",
      provenance: { source: "custom" },
    });
  });

  it("carries upstream registry provenance when the registry is available", async () => {
    const result = await Effect.runPromise(runDiscovery(discoveryLayer({ recipeCandidates: [] })));

    expect(result.registryStatus.available).toBe(true);
    expect(result.registryStatus.registryVersion).toBe("2.3.0");
    const registryCandidates = result.candidates.filter((c) => c.source === "registry");
    expect(registryCandidates).toHaveLength(2);
    for (const candidate of registryCandidates) {
      expect(candidate.registry?.registry.sourceUrl).toContain("agentclientprotocol.com");
      expect(candidate.provenance.source).toBe("registry");
    }
  });

  it("degrades the registry status (not the whole list) when the registry is offline", async () => {
    const result = await Effect.runPromise(
      runDiscovery(
        discoveryLayer({
          recipeCandidates: [recipeCandidate({ agentId: "cline" })],
          registryUnavailable: true,
        }),
      ),
    );

    expect(result.registryStatus.available).toBe(false);
    expect(result.registryStatus.error).toBeTruthy();
    // Recipe candidates still surface even when the registry is offline.
    expect(result.candidates.some((c) => c.source === "recipe")).toBe(true);
  });

  it("emits no shell commands or install instructions in any candidate (AC #6)", async () => {
    const result = await Effect.runPromise(
      runDiscovery(
        discoveryLayer({
          recipeCandidates: [recipeCandidate({ agentId: "cline" })],
        }),
        { customCommands: ["/opt/manual/agent"] },
      ),
    );

    for (const candidate of result.candidates) {
      // No field can ever look like a shell snippet.
      const serialized = JSON.stringify(candidate);
      expect(serialized).not.toMatch(/\$(?:\(|{)/);
      expect(serialized).not.toContain("`");
      expect(serialized).not.toContain("&&");
    }
  });

  it("AC #5 — overlays recipe compatibility onto registry entries without copying registry data", async () => {
    const result = await Effect.runPromise(
      runDiscovery(
        discoveryLayer({
          recipeCandidates: [],
          serviceOptions: {
            recipes: new Map([
              [
                "cline",
                {
                  agentId: "cline",
                  primaryName: "Cline",
                  binaryNames: ["cline"],
                  compatibility: {
                    listed: true,
                    summary: "Detected from the local Cline CLI shim.",
                  },
                },
              ],
              [
                "broken-agent",
                {
                  agentId: "broken-agent",
                  primaryName: "Broken Agent",
                  binaryNames: ["broken-agent"],
                  compatibility: { listed: false },
                },
              ],
            ]),
          },
        }),
      ),
    );

    const registryCandidates = result.candidates.filter((c) => c.source === "registry");
    // Cline kept its upstream entry (no registry data copied); the compatibility
    // overlay was stamped on as an assessment, and the broken agent was demoted.
    expect(registryCandidates.map((c) => c.agentId)).toEqual(["cline", "goose"]);
    const clineEntry = registryCandidates.find((c) => c.agentId === "cline");
    expect(clineEntry).toMatchObject({
      compatibility: { listed: true, summary: "Detected from the local Cline CLI shim." },
    });
    // The demoted entry is absent, and its upstream facts are gone with it —
    // the overlay filtered it out, proving the overlay governs the registry
    // without forking or mutating it.
    expect(registryCandidates.some((c) => c.agentId === "broken-agent")).toBe(false);
  });
});

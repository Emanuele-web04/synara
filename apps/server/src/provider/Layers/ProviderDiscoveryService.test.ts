// FILE: ProviderDiscoveryService.test.ts
// Purpose: Verifies the discovery service merges provider-native skills with the
//          unified Synara catalog, filters user-disabled skills, and reports
//          skill discovery as supported for every provider.
// Layer: Server provider tests

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type {
  ProviderComposerCapabilities,
  ProviderKind,
  ProviderListModelsResult,
  ProviderListPluginsResult,
  ProviderListSkillsResult,
  ServerSettings,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deriveServerPaths,
  resolveDefaultChatWorkspaceRoot,
  resolveDefaultStudioWorkspaceRoot,
  ServerConfig,
  type ServerConfigShape,
} from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderDiscoveryService } from "../Services/ProviderDiscoveryService.ts";
import { clearSkillsCatalogCacheForTests } from "../skillsCatalog.ts";
import { ProviderDiscoveryServiceLive } from "./ProviderDiscoveryService.ts";

let root: string;
let homeDir: string;
let baseDir: string;
let cwd: string;

async function writeSkill(skillDir: string, name: string): Promise<void> {
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} description\n---\n\n# ${name}\n`,
  );
}

const makeConfigLayer = () =>
  Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const derived = yield* deriveServerPaths(baseDir, undefined);
      return {
        mode: "web",
        port: 0,
        host: undefined,
        cwd,
        homeDir,
        chatWorkspaceRoot: resolveDefaultChatWorkspaceRoot({ homeDir }),
        studioWorkspaceRoot: resolveDefaultStudioWorkspaceRoot({ homeDir }),
        baseDir,
        ...derived,
        staticDir: undefined,
        devUrl: undefined,
        noBrowser: true,
        authToken: undefined,
        autoBootstrapProjectFromCwd: false,
        logProviderEvents: false,
        logWebSocketEvents: false,
      } satisfies ServerConfigShape;
    }),
  );

const makeRegistryLayer = (adapter: Partial<ProviderAdapterShape<ProviderAdapterError>>) =>
  Layer.succeed(ProviderAdapterRegistry, {
    getByProvider: () => Effect.succeed(adapter as ProviderAdapterShape<ProviderAdapterError>),
    listProviders: () => Effect.succeed([]),
  });

const runListSkills = (input: {
  adapter: Partial<ProviderAdapterShape<ProviderAdapterError>>;
  disabled?: string[];
  provider: ProviderKind;
}) => {
  const baseLayer = Layer.mergeAll(
    makeConfigLayer(),
    ServerSettingsService.layerTest({ skills: { disabled: input.disabled ?? [] } }),
    makeRegistryLayer(input.adapter),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const testLayer = ProviderDiscoveryServiceLive.pipe(Layer.provideMerge(baseLayer));
  const program = Effect.gen(function* () {
    const discovery = yield* ProviderDiscoveryService;
    return yield* discovery.listSkills({ provider: input.provider, cwd });
  }).pipe(Effect.provide(testLayer));
  return Effect.runPromise(
    program as unknown as Effect.Effect<ProviderListSkillsResult, never, never>,
  );
};

const runDiscovery = <A>(input: {
  adapter: Partial<ProviderAdapterShape<ProviderAdapterError>>;
  settings?: Partial<ServerSettings>;
  effect: Effect.Effect<A, unknown, ProviderDiscoveryService>;
}) => {
  const baseLayer = Layer.mergeAll(
    makeConfigLayer(),
    ServerSettingsService.layerTest(input.settings),
    makeRegistryLayer(input.adapter),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const testLayer = ProviderDiscoveryServiceLive.pipe(Layer.provideMerge(baseLayer));
  return Effect.runPromise(input.effect.pipe(Effect.provide(testLayer)) as Effect.Effect<A, never>);
};

beforeEach(async () => {
  clearSkillsCatalogCacheForTests();
  root = mkdtempSync(path.join(os.tmpdir(), "discovery-service-"));
  homeDir = path.join(root, "home");
  baseDir = path.join(homeDir, ".synara");
  cwd = path.join(root, "repo");
  await mkdir(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ProviderDiscoveryService.listSkills", () => {
  it("serves the unified catalog for providers without native skill discovery", async () => {
    await writeSkill(path.join(baseDir, "skills", "portable"), "portable");

    const result = await runListSkills({ adapter: {}, provider: "gemini" });

    expect(result.skills.map((skill) => skill.name)).toEqual(["portable"]);
  });

  it("prefers provider-native entries and appends catalog-only skills", async () => {
    await writeSkill(path.join(baseDir, "skills", "shared"), "shared");
    await writeSkill(path.join(baseDir, "skills", "portable"), "portable");

    const nativeShared = {
      name: "shared",
      path: path.join(homeDir, ".codex", "skills", "shared", "SKILL.md"),
      enabled: true,
      scope: "user",
    };
    const result = await runListSkills({
      adapter: {
        listSkills: () =>
          Effect.succeed({ skills: [nativeShared], source: "codex-app-server", cached: false }),
      },
      provider: "codex",
    });

    const shared = result.skills.find((skill) => skill.name === "shared");
    expect(shared?.path).toBe(nativeShared.path);
    expect(result.skills.some((skill) => skill.name === "portable")).toBe(true);
  });

  it("filters user-disabled skills from merged results", async () => {
    await writeSkill(path.join(baseDir, "skills", "portable"), "portable");
    await writeSkill(path.join(baseDir, "skills", "muted"), "muted");

    const result = await runListSkills({
      adapter: {},
      disabled: ["Muted"],
      provider: "opencode",
    });

    expect(result.skills.map((skill) => skill.name)).toEqual(["portable"]);
  });

  it("falls back to the catalog when native discovery fails", async () => {
    await writeSkill(path.join(baseDir, "skills", "portable"), "portable");

    const result = await runListSkills({
      adapter: {
        listSkills: () =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: "codex",
              method: "skills/list",
              detail: "codex binary missing",
            }),
          ),
      },
      provider: "codex",
    });

    expect(result.skills.map((skill) => skill.name)).toEqual(["portable"]);
  });
});

describe("ProviderDiscoveryService provider instances", () => {
  it("clears stale Codex account fields when resolving the explicit default instance", async () => {
    let captured: Record<string, unknown> | undefined;

    const result = await runDiscovery({
      adapter: {
        listModels: (input) =>
          Effect.sync(() => {
            captured = input as unknown as Record<string, unknown>;
            return {
              models: [],
              source: "stub",
              cached: false,
            } satisfies ProviderListModelsResult;
          }),
      },
      settings: {
        providerInstances: {
          codex_work: {
            driver: "codex",
            config: {
              homePath: "/work-codex",
              shadowHomePath: "/work-auth",
              accountId: "work",
            },
          },
        },
      },
      effect: Effect.gen(function* () {
        const discovery = yield* ProviderDiscoveryService;
        return yield* discovery.listModels({
          provider: "codex",
          instanceId: "codex",
          homePath: "/stale-home",
          shadowHomePath: "/stale-shadow",
          accountId: "stale",
        });
      }),
    });

    expect(result.source).toBe("stub");
    expect(captured).toMatchObject({ provider: "codex", instanceId: "codex" });
    expect(captured).not.toHaveProperty("homePath");
    expect(captured).not.toHaveProperty("shadowHomePath");
    expect(captured).not.toHaveProperty("accountId");
  });

  it("passes resolved Codex instance options into plugin discovery", async () => {
    let captured: Record<string, unknown> | undefined;

    await runDiscovery({
      adapter: {
        listPlugins: (input) =>
          Effect.sync(() => {
            captured = input as unknown as Record<string, unknown>;
            return {
              marketplaces: [],
              marketplaceLoadErrors: [],
              remoteSyncError: null,
              featuredPluginIds: [],
              source: "stub",
              cached: false,
            } satisfies ProviderListPluginsResult;
          }),
      },
      settings: {
        providerInstances: {
          codex_work: {
            driver: "codex",
            config: {
              homePath: "/work-codex",
              shadowHomePath: "/work-auth",
              accountId: "work",
            },
          },
        },
      },
      effect: Effect.gen(function* () {
        const discovery = yield* ProviderDiscoveryService;
        return yield* discovery.listPlugins({
          provider: "codex",
          instanceId: "codex_work",
        });
      }),
    });

    expect(captured).toMatchObject({
      provider: "codex",
      instanceId: "codex_work",
      homePath: "/work-codex",
      shadowHomePath: "/work-auth",
      accountId: "work",
    });
  });

  it("rejects explicit unknown provider instance ids", async () => {
    await expect(
      runDiscovery({
        adapter: {
          listModels: () =>
            Effect.succeed({
              models: [],
              source: "stub",
              cached: false,
            } satisfies ProviderListModelsResult),
        },
        effect: Effect.gen(function* () {
          const discovery = yield* ProviderDiscoveryService;
          return yield* discovery.listModels({
            provider: "codex",
            instanceId: "codex_removed",
          });
        }),
      }),
    ).rejects.toThrow("Unknown provider instance 'codex_removed'");
  });

  it("rejects disabled provider instance ids", async () => {
    await expect(
      runDiscovery({
        adapter: {
          listModels: () =>
            Effect.succeed({
              models: [],
              source: "stub",
              cached: false,
            } satisfies ProviderListModelsResult),
        },
        settings: {
          providerInstances: {
            codex_disabled: {
              driver: "codex",
              enabled: false,
              config: {
                homePath: "/disabled-codex",
              },
            },
          },
        },
        effect: Effect.gen(function* () {
          const discovery = yield* ProviderDiscoveryService;
          return yield* discovery.listModels({
            provider: "codex",
            instanceId: "codex_disabled",
          });
        }),
      }),
    ).rejects.toThrow("Provider instance 'codex_disabled' is disabled");
  });
});

describe("ProviderDiscoveryService.getComposerCapabilities", () => {
  it("reports skill discovery as supported even when the adapter declines it", async () => {
    const baseLayer = Layer.mergeAll(
      makeConfigLayer(),
      ServerSettingsService.layerTest(),
      makeRegistryLayer({}),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    const testLayer = ProviderDiscoveryServiceLive.pipe(Layer.provideMerge(baseLayer));

    const program = Effect.gen(function* () {
      const discovery = yield* ProviderDiscoveryService;
      return yield* discovery.getComposerCapabilities({ provider: "grok" });
    }).pipe(Effect.provide(testLayer));
    const capabilities = await Effect.runPromise(
      program as unknown as Effect.Effect<ProviderComposerCapabilities, never, never>,
    );

    expect(capabilities.supportsSkillDiscovery).toBe(true);
    expect(capabilities.supportsSkillMentions).toBe(true);
  });
});

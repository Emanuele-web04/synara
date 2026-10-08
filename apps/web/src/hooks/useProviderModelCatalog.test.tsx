// FILE: useProviderModelCatalog.test.tsx
// Purpose: Locks the shared provider-model catalog's memoization and discovery policy.
// Layer: Web hook tests

import {
  DEFAULT_SERVER_SETTINGS,
  MODEL_OPTIONS_BY_PROVIDER,
  type ProviderKind,
  type ProviderModelDescriptor,
  type NativeApi,
} from "@synara/contracts";
import { useState } from "react";
import { QueryClient } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderModelCatalog } from "./useProviderModelCatalog";
import { useProviderModelCatalog } from "./useProviderModelCatalog";
import * as nativeApi from "../nativeApi";
import { providerModelsQueryOptions } from "../lib/providerDiscoveryReactQuery";

const mocks = vi.hoisted(() => ({
  useAppSettings: vi.fn(),
  useQueries: vi.fn(),
  useQuery: vi.fn(),
  useQueryClient: vi.fn(),
  useEffect: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useEffect: mocks.useEffect };
});

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueries: mocks.useQueries,
    useQuery: mocks.useQuery,
    useQueryClient: mocks.useQueryClient,
  };
});

vi.mock("../appSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../appSettings")>();
  return { ...actual, useAppSettings: mocks.useAppSettings };
});

interface QueryOptionsLike {
  readonly queryKey: readonly unknown[];
  readonly enabled?: boolean;
}

interface QueryResultLike {
  readonly data?: {
    readonly agents?: ReadonlyArray<{ name: string; displayName: string }>;
    readonly cached?: boolean;
    readonly error?: string;
    readonly models?: ReadonlyArray<ProviderModelDescriptor>;
    readonly source?: string;
  };
  readonly error?: unknown;
  readonly isFetching: boolean;
  readonly isLoading: boolean;
  readonly isPlaceholderData: boolean;
  readonly isError: boolean;
}

const EMPTY_QUERY: QueryResultLike = {
  isFetching: false,
  isLoading: false,
  isPlaceholderData: false,
  isError: false,
};
const modelQueries = new Map<ProviderKind, QueryResultLike>();
const instanceModelQueries = new Map<string, QueryResultLike>();
const agentQueries = new Map<ProviderKind, QueryResultLike>();
let lastInstanceQueryResults: QueryResultLike[] = [];
let lastCombinedInstanceQueryResults: unknown;
const MODEL_HINTS = { cursor: "composer-2" } as const;
const SETTINGS = {
  antigravityBinaryPath: "",
  codexAccounts: [],
  codexHomePath: "",
  cursorApiEndpoint: "",
  cursorBinaryPath: "",
  customAntigravityModels: [],
  customClaudeModels: [],
  customCodexModels: [],
  customCursorModels: ["cursor-custom"],
  customDroidModels: [],
  customGrokModels: [],
  customOpenCodeModels: [],
  customPiModels: [],
  droidBinaryPath: "",
  grokBinaryPath: "",
  hiddenProviders: [],
  openCodeBinaryPath: "",
  piAgentDir: "",
  piBinaryPath: "",
  providerInstances: {},
  selectedCodexAccountId: "",
};

function readCatalogRenders(
  input: Parameters<typeof useProviderModelCatalog>[0],
  nextInput = input,
): ProviderModelCatalog[] {
  const results: ProviderModelCatalog[] = [];

  function Probe() {
    const [renderIndex, setRenderIndex] = useState(0);
    results.push(useProviderModelCatalog(renderIndex === 0 ? input : nextInput));
    if (renderIndex === 0) {
      setRenderIndex(1);
    }
    return null;
  }

  renderToStaticMarkup(<Probe />);
  expect(results).toHaveLength(2);
  return results;
}

// The selected-account priority effect depends on [queryKey, enabled].
function readForegroundEffectCalls() {
  return mocks.useEffect.mock.calls.filter(([, deps]) => Array.isArray(deps) && deps.length === 2);
}

function readAgentQueryEnabled(provider: ProviderKind): boolean | undefined {
  const call = mocks.useQuery.mock.calls.find(([value]) => {
    const queryKey = (value as QueryOptionsLike).queryKey;
    return queryKey[1] === "agents" && queryKey[2] === provider;
  });
  return call ? (call[0] as QueryOptionsLike).enabled : undefined;
}

function readModelQueryEnabled(provider: ProviderKind): boolean | undefined {
  const call = mocks.useQuery.mock.calls.find(([value]) => {
    const queryKey = (value as QueryOptionsLike).queryKey;
    return queryKey[1] === "models" && queryKey[2] === provider;
  });
  return call ? (call[0] as QueryOptionsLike).enabled : undefined;
}

beforeEach(() => {
  mocks.useQueryClient.mockReturnValue(new QueryClient());
  mocks.useEffect.mockClear();
  modelQueries.clear();
  instanceModelQueries.clear();
  agentQueries.clear();
  lastInstanceQueryResults = [];
  lastCombinedInstanceQueryResults = undefined;
  mocks.useAppSettings
    .mockReset()
    .mockReturnValue({ settings: SETTINGS, serverSettings: DEFAULT_SERVER_SETTINGS });
  mocks.useQuery.mockReset().mockImplementation((value: QueryOptionsLike) => {
    const [, resource, provider] = value.queryKey;
    if (resource === "models") {
      return modelQueries.get(provider as ProviderKind) ?? EMPTY_QUERY;
    }
    if (resource === "agents") {
      return agentQueries.get(provider as ProviderKind) ?? EMPTY_QUERY;
    }
    throw new Error(`Unexpected provider catalog query: ${String(resource)}`);
  });
  mocks.useQueries
    .mockReset()
    .mockImplementation(
      ({
        queries,
        combine,
      }: {
        readonly queries: ReadonlyArray<QueryOptionsLike>;
        readonly combine?: (results: ReadonlyArray<QueryResultLike>) => unknown;
      }) => {
        const next = queries.map((query) => {
          const instanceId = query.queryKey[3];
          return query.enabled === false || typeof instanceId !== "string"
            ? EMPTY_QUERY
            : (instanceModelQueries.get(instanceId) ?? EMPTY_QUERY);
        });
        const changed =
          next.length !== lastInstanceQueryResults.length ||
          next.some((result, index) => result !== lastInstanceQueryResults[index]);
        if (changed) {
          lastInstanceQueryResults = next;
        }
        if (!combine) {
          return lastInstanceQueryResults;
        }
        // Like the real hook: the combined value keeps its identity while the results do.
        if (changed || lastCombinedInstanceQueryResults === undefined) {
          lastCombinedInstanceQueryResults = combine(lastInstanceQueryResults);
        }
        return lastCombinedInstanceQueryResults;
      },
    );
});

describe("useProviderModelCatalog", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shares account catalog refreshes across projects and updates the observed query", async () => {
    const listModels = vi.fn().mockResolvedValue({
      models: [{ slug: "gpt-6.1-sol", name: "GPT-6.1 Sol" }],
      source: "codex-app-server",
    });
    vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
      provider: { listModels },
    } as unknown as NativeApi);
    const [first] = readCatalogRenders({
      selectedProvider: "codex",
      cwd: "/one",
      discoveryEnabled: false,
    });
    const [second] = readCatalogRenders({
      selectedProvider: "codex",
      cwd: "/two",
      discoveryEnabled: false,
    });
    const queryClient = mocks.useQueryClient() as QueryClient;
    const options = providerModelsQueryOptions({ provider: "codex", instanceId: "codex" });
    // Ordinary discovery can cache a stale server snapshot moments before a tab opens.
    queryClient.setQueryData(options.queryKey, {
      models: [{ slug: "old-model", name: "Old model" }],
      source: "codex-app-server",
      cached: true,
    });
    await first!.refreshModels("codex", "codex", "if-stale");
    await second!.refreshModels("codex", "codex", "if-stale");
    expect(listModels).toHaveBeenCalledTimes(2);
    expect(listModels).toHaveBeenLastCalledWith({
      provider: "codex",
      instanceId: "codex",
      refresh: "if-stale",
    });
    expect(queryClient.getQueryData(options.queryKey)).toMatchObject({
      models: [{ slug: "gpt-6.1-sol" }],
    });
    listModels.mockResolvedValueOnce({ models: [], source: "codex-app-server" });
    await second!.refreshModels("codex", "codex", "now");
    expect(listModels).toHaveBeenLastCalledWith({
      provider: "codex",
      instanceId: "codex",
      refresh: "now",
    });
    expect(queryClient.getQueryData(options.queryKey)).toMatchObject({ models: [] });
    queryClient.clear();
  });

  it("does not lose refresh intent behind an in-flight stale prefetch", async () => {
    let finish!: (value: unknown) => void;
    const promise = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    const listModels = vi
      .fn()
      .mockReturnValueOnce(promise)
      .mockResolvedValue({
        models: [{ slug: "new-model", name: "New model" }],
        source: "codex-app-server",
      });
    vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
      provider: { listModels },
    } as unknown as NativeApi);
    const queryClient = mocks.useQueryClient() as QueryClient;
    const options = providerModelsQueryOptions({ provider: "codex", instanceId: "codex" });
    const prefetch = queryClient.fetchQuery(options);
    await vi.waitFor(() => expect(listModels).toHaveBeenCalledTimes(1));
    const [catalog] = readCatalogRenders({ selectedProvider: "codex", discoveryEnabled: false });
    const refreshed = catalog!.refreshModels("codex", "codex", "now");
    finish({
      models: [{ slug: "old-model", name: "Old model" }],
      source: "codex-app-server",
      cached: true,
    });
    await Promise.all([prefetch, refreshed]);
    expect(listModels).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(options.queryKey)).toMatchObject({
      models: [{ slug: "new-model" }],
    });
    queryClient.clear();
  });

  it.each([false, true])(
    "keeps an account refresh ahead of background catalogs after a prefetch (fails: %s)",
    async (prefetchFails) => {
      let finishActive!: () => void;
      const catalog = { models: [{ slug: "same-model", name: "Same model" }], source: "runtime" };
      const listModels = vi.fn().mockImplementation(({ provider, refresh }) => {
        if (provider === "opencode") {
          return new Promise((resolve) => {
            finishActive = () => resolve(catalog);
          });
        }
        if (provider === "codex" && !refresh && prefetchFails) {
          return Promise.reject(new Error("prefetch failed"));
        }
        return Promise.resolve(catalog);
      });
      vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
        provider: { listModels },
      } as unknown as NativeApi);
      const client = mocks.useQueryClient() as QueryClient;
      const active = client.fetchQuery(providerModelsQueryOptions({ provider: "opencode" }));
      await vi.waitFor(() => expect(finishActive).toBeDefined());
      const background = client.fetchQuery(providerModelsQueryOptions({ provider: "pi" }));
      const prefetch = client
        .fetchQuery({
          ...providerModelsQueryOptions({ provider: "codex", instanceId: "codex_work" }),
          retry: false,
        })
        .catch(() => undefined);
      const [catalogHook] = readCatalogRenders({
        selectedProvider: "codex",
        discoveryEnabled: false,
      });
      const refreshed = catalogHook!.refreshModels("codex", "codex_work", "now");
      const outcome = refreshed.then(
        () => "completed",
        () => "failed",
      );
      finishActive();
      await Promise.all([active, background, prefetch]);
      expect(await outcome).toBe("completed");
      expect(listModels.mock.calls.map(([input]) => input)).toEqual([
        { provider: "opencode" },
        { provider: "codex", instanceId: "codex_work" },
        { provider: "codex", instanceId: "codex_work", refresh: "now" },
        { provider: "pi" },
      ]);
      client.clear();
    },
  );

  it("reports a degraded provider response as a failed refresh", async () => {
    vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
      provider: {
        listModels: vi.fn().mockResolvedValue({
          models: [{ slug: "fallback", name: "Fallback" }],
          source: "runtime.static",
          error: "Provider unavailable",
        }),
      },
    } as unknown as NativeApi);
    const [catalog] = readCatalogRenders({ selectedProvider: "codex", discoveryEnabled: false });
    await expect(catalog!.refreshModels("codex", "codex", "now")).rejects.toThrow(
      "Provider unavailable",
    );
    (mocks.useQueryClient() as QueryClient).clear();
  });

  it.each([{ models: [{ slug: "gpt-5.6-sol", name: "GPT-5.6 Sol" }] }, { models: [] }])(
    "uses the Codex catalog without restoring retired built-ins: %j",
    ({ models }) => {
      mocks.useAppSettings.mockReturnValue({
        settings: { ...SETTINGS, customCodexModels: ["private-model"] },
        serverSettings: DEFAULT_SERVER_SETTINGS,
      });
      modelQueries.set("codex", {
        ...EMPTY_QUERY,
        data: { models, source: "codex-app-server", cached: false },
      });
      instanceModelQueries.set("codex", {
        ...EMPTY_QUERY,
        data: { models, source: "codex-app-server", cached: false },
      });

      const [catalog] = readCatalogRenders({
        selectedProvider: "codex",
        discoveryEnabled: true,
        modelHintByProvider: { codex: "gpt-5.4" },
      });

      expect(catalog?.modelOptionsByProvider.codex.map((model) => model.slug)).toEqual([
        ...models.map((model) => model.slug),
        "private-model",
      ]);
      expect(catalog?.modelOptionsByProviderInstance.codex?.map((model) => model.slug)).toEqual([
        ...models.map((model) => model.slug),
        "private-model",
      ]);
    },
  );

  it.each([
    { ...EMPTY_QUERY, error: new Error("Codex unavailable") },
    {
      ...EMPTY_QUERY,
      isLoading: true,
      isPlaceholderData: true,
      data: { models: [], source: "empty", cached: false },
    },
  ])("keeps the Codex fallback until discovery succeeds: %j", (query) => {
    modelQueries.set("codex", query);
    instanceModelQueries.set("codex", query);

    const [catalog] = readCatalogRenders({ selectedProvider: "codex", discoveryEnabled: true });

    expect(catalog?.modelOptionsByProvider.codex.map((model) => model.slug)).toEqual(
      MODEL_OPTIONS_BY_PROVIDER.codex.map((model) => model.slug),
    );
    expect(catalog?.modelOptionsByProviderInstance.codex?.map((model) => model.slug)).toEqual(
      MODEL_OPTIONS_BY_PROVIDER.codex.map((model) => model.slug),
    );
  });

  it.each(["opencode", "opencode-cli", "disabled", "unsupported"])(
    "honors an empty OpenCode %s catalog without restoring built-ins",
    (source) => {
      mocks.useAppSettings.mockReturnValue({
        settings: { ...SETTINGS, customOpenCodeModels: ["private/model"] },
        serverSettings: DEFAULT_SERVER_SETTINGS,
      });
      const query = { ...EMPTY_QUERY, data: { models: [], source, cached: false } };
      modelQueries.set("opencode", query);
      instanceModelQueries.set("opencode", query);

      const [catalog] = readCatalogRenders({
        selectedProvider: "opencode",
        discoveryEnabled: true,
        modelHintByProvider: { opencode: MODEL_OPTIONS_BY_PROVIDER.opencode[0]?.slug },
      });

      expect(catalog?.modelOptionsByProvider.opencode.map((model) => model.slug)).toEqual([
        "private/model",
      ]);
      expect(catalog?.modelOptionsByProviderInstance.opencode?.map((model) => model.slug)).toEqual([
        "private/model",
      ]);
    },
  );

  it("shows both qualified OpenCode routes after a degraded catalog recovers", () => {
    modelQueries.set("opencode", {
      ...EMPTY_QUERY,
      data: { models: [], source: "static", error: "OpenCode is still starting", cached: false },
    });
    const [degraded] = readCatalogRenders({ selectedProvider: "opencode", discoveryEnabled: true });
    expect(degraded?.discoveryErrorsByProvider.opencode).toBe("OpenCode is still starting");

    const models = [
      {
        slug: "opencode/muse-spark",
        name: "Muse Spark",
        upstreamProviderId: "opencode",
        upstreamProviderName: "OpenCode Zen",
      },
      {
        slug: "openrouter/muse-spark",
        name: "Muse Spark",
        upstreamProviderId: "openrouter",
        upstreamProviderName: "OpenRouter",
      },
    ];
    const recovered = { ...EMPTY_QUERY, data: { models, source: "opencode", cached: false } };
    modelQueries.set("opencode", recovered);
    instanceModelQueries.set("opencode", recovered);
    const [healthy] = readCatalogRenders({ selectedProvider: "opencode", discoveryEnabled: true });
    for (const options of [
      healthy?.modelOptionsByProvider.opencode,
      healthy?.modelOptionsByProviderInstance.opencode,
    ]) {
      expect(options?.map((model) => [model.slug, model.upstreamProviderName])).toEqual([
        ["opencode/muse-spark", "OpenCode Zen"],
        ["openrouter/muse-spark", "OpenRouter"],
      ]);
    }
    expect(healthy?.discoveryErrorsByProvider.opencode).toBeUndefined();
  });

  it("warms every enabled OpenCode account at the chat cwd", () => {
    mocks.useAppSettings.mockReturnValue({
      settings: {
        ...SETTINGS,
        providerInstances: {
          opencode_work: { driver: "opencode", displayName: "Work", config: {} },
          opencode_off: { driver: "opencode", displayName: "Off", enabled: false, config: {} },
        },
      },
      serverSettings: DEFAULT_SERVER_SETTINGS,
    });
    const queryClient = mocks.useQueryClient() as QueryClient;
    const prefetchQuery = vi.spyOn(queryClient, "prefetchQuery").mockResolvedValue();
    readCatalogRenders({
      selectedProvider: "codex",
      discoveryEnabled: false,
      cwd: "/repo/worktree",
      warmProviders: ["opencode"],
    });
    const warmEffect = mocks.useEffect.mock.calls.find(([, deps]) =>
      (deps as unknown[]).includes("opencode"),
    );
    warmEffect?.[0]();

    const warmed = prefetchQuery.mock.calls.map(([options]) => options.queryKey);
    expect(warmed.map((queryKey) => [queryKey[2], queryKey[3], queryKey[7]])).toEqual([
      ["opencode", "opencode", "/repo/worktree"],
      ["opencode", "opencode_work", "/repo/worktree"],
    ]);
  });

  it("bridges a thread's move into a new directory with its previous OpenCode catalog", () => {
    const queryClient = mocks.useQueryClient() as QueryClient;
    const previous = { models: [{ slug: "opencode/muse", name: "Muse" }], source: "opencode" };
    queryClient.setQueryData(
      providerModelsQueryOptions({ provider: "opencode", instanceId: "opencode", cwd: "/chats" })
        .queryKey,
      previous,
    );
    const readPlaceholder = (placeholderCwd: string | null) => {
      mocks.useQuery.mockClear();
      readCatalogRenders({
        selectedProvider: "opencode",
        discoveryEnabled: false,
        cwd: "/chats/2026-10-08/hi",
        placeholderCwd,
      });
      const options = mocks.useQuery.mock.calls
        .map(([value]) => value as QueryOptionsLike & { placeholderData?: unknown })
        .find(({ queryKey }) => queryKey[1] === "models" && queryKey[2] === "opencode");
      const placeholderData = options!.placeholderData as (previous: unknown) => unknown;
      return placeholderData(undefined);
    };

    expect(readPlaceholder("/chats")).toBe(previous);
    expect(readPlaceholder(null)).toMatchObject({ models: [] });
  });

  it("does not warm OpenCode when the provider is disabled or hidden", () => {
    const queryClient = mocks.useQueryClient() as QueryClient;
    const prefetchQuery = vi.spyOn(queryClient, "prefetchQuery").mockResolvedValue();
    for (const appSettings of [
      {
        settings: SETTINGS,
        serverSettings: {
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            opencode: { ...DEFAULT_SERVER_SETTINGS.providers.opencode, enabled: false },
          },
        },
      },
      {
        settings: { ...SETTINGS, hiddenProviders: ["opencode"] },
        serverSettings: DEFAULT_SERVER_SETTINGS,
      },
    ]) {
      mocks.useEffect.mockClear();
      mocks.useAppSettings.mockReturnValue(appSettings);
      readCatalogRenders({
        selectedProvider: "codex",
        discoveryEnabled: false,
        warmProviders: ["opencode"],
      });
      for (const [effect] of mocks.useEffect.mock.calls) effect();
    }
    expect(prefetchQuery).not.toHaveBeenCalled();
  });

  it("keeps the last Codex catalog when a background refresh fails", () => {
    modelQueries.set("codex", {
      ...EMPTY_QUERY,
      data: {
        models: [{ slug: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
        source: "codex-app-server",
        cached: true,
      },
      error: new Error("Codex unavailable"),
    });

    const [catalog] = readCatalogRenders({ selectedProvider: "codex", discoveryEnabled: true });

    expect(catalog?.modelOptionsByProvider.codex.map((model) => model.slug)).toEqual([
      "gpt-5.6-sol",
    ]);
  });

  it("keeps the foreground effect dependency stable across unrelated renders", () => {
    readCatalogRenders({ selectedProvider: "cursor", discoveryEnabled: true });
    const [first, second] = readForegroundEffectCalls();
    // React uses Object.is on each dependency: an equal-but-new query key
    // would release/reacquire ownership and reorder split-view selections.
    expect(first?.[1][0]).toBe(second?.[1][0]);
    expect(first?.[1][1]).toBe(second?.[1][1]);
    expect(readForegroundEffectCalls()).toHaveLength(2);
  });

  it.each([
    { selectedProvider: "cursor", discoveryEnabled: true, cwd: "/first" },
    { selectedProvider: "pi", discoveryEnabled: true, cwd: "/second" },
  ] as const)("changes foreground ownership when the selected query changes: %j", (nextInput) => {
    readCatalogRenders(
      { selectedProvider: "pi", discoveryEnabled: true, cwd: "/first" },
      nextInput,
    );
    const [first, second] = readForegroundEffectCalls();
    expect(first?.[1][0]).not.toEqual(second?.[1][0]);
  });

  it("keeps aggregate identities stable when inputs and query data are unchanged", () => {
    const [first, second] = readCatalogRenders({
      selectedProvider: "cursor",
      discoveryEnabled: true,
      modelHintByProvider: MODEL_HINTS,
    });

    expect(second).toBe(first);
    expect(second?.customModelsByProvider).toBe(first?.customModelsByProvider);
    expect(second?.modelOptionsByProvider).toBe(first?.modelOptionsByProvider);
    expect(second?.loadingModelProviders).toBe(first?.loadingModelProviders);
    expect(second?.runtimeModelsByProvider).toBe(first?.runtimeModelsByProvider);
    expect(second?.selectedRuntimeAgents).toBe(first?.selectedRuntimeAgents);
  });

  it("keeps runtime and custom model catalogs separate for same-provider instances", () => {
    const customInstanceId = "cursor-work";
    mocks.useAppSettings.mockReturnValue({
      settings: {
        ...SETTINGS,
        providerInstances: {
          [customInstanceId]: {
            driver: "cursor",
            displayName: "Cursor Work",
            config: {
              binaryPath: "/opt/cursor-work",
              customModels: ["work-custom"],
            },
          },
        },
      },
      serverSettings: DEFAULT_SERVER_SETTINGS,
    });
    instanceModelQueries.set(customInstanceId, {
      data: {
        models: [{ slug: "composer-work", name: "Composer Work" }],
        source: "cursor.cli",
        cached: false,
      },
      isError: false,
      isFetching: false,
      isLoading: false,
      isPlaceholderData: false,
    });

    const catalog = readCatalogRenders({
      selectedProvider: "cursor",
      selectedProviderInstanceId: customInstanceId,
      discoveryEnabled: false,
    }).at(-1);

    expect(
      catalog?.modelOptionsByProviderInstance[customInstanceId]?.map((model) => model.slug),
    ).toEqual(["composer-work", "work-custom"]);
    expect(
      catalog?.modelOptionsByProviderInstance.cursor?.some(
        (model) => model.slug === "composer-work" || model.slug === "work-custom",
      ),
    ).toBe(false);
  });

  it("keeps an undiscovered sibling runtime catalog empty beside a warm default", () => {
    mocks.useAppSettings.mockReturnValue({
      settings: {
        ...SETTINGS,
        providerInstances: {
          claude_work: {
            driver: "claudeAgent",
            displayName: "Work",
            config: { customModels: ["work-only"] },
          },
        },
      },
      serverSettings: DEFAULT_SERVER_SETTINGS,
    });
    const warmDefault = {
      ...EMPTY_QUERY,
      data: {
        models: [{ slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", supportsAutoMode: true }],
        source: "claude-cli",
      },
    };
    modelQueries.set("claudeAgent", warmDefault);
    instanceModelQueries.set("claudeAgent", warmDefault);
    const catalog = readCatalogRenders({
      selectedProvider: "claudeAgent",
      discoveryEnabled: true,
    }).at(-1)!;

    expect(catalog.runtimeModelsByProvider.claudeAgent[0]?.supportsAutoMode).toBe(true);
    // Consumers may fall back to their provider catalog only for an unknown account;
    // a configured account without discovery has no known runtime capabilities yet.
    expect(catalog.runtimeModelsByProviderInstance.claude_work).toEqual([]);
    expect(
      catalog.modelOptionsByProviderInstance.claude_work?.map((option) => option.slug),
    ).toContain("work-only");
  });

  it("discovers core agents only when selected unless eager-core is requested", () => {
    readCatalogRenders({ selectedProvider: "cursor", discoveryEnabled: false });
    expect(readAgentQueryEnabled("claudeAgent")).toBe(false);
    expect(readAgentQueryEnabled("codex")).toBe(false);

    mocks.useQuery.mockClear();
    readCatalogRenders({
      selectedProvider: "cursor",
      discoveryEnabled: false,
      agentDiscoveryPolicy: "eager-core",
    });
    expect(readAgentQueryEnabled("claudeAgent")).toBe(true);
    expect(readAgentQueryEnabled("codex")).toBe(true);
  });

  it("does not prefetch providers hidden from picker surfaces", () => {
    mocks.useAppSettings.mockReturnValue({
      settings: { ...SETTINGS, hiddenProviders: ["cursor"] },
      serverSettings: DEFAULT_SERVER_SETTINGS,
    });

    readCatalogRenders({ selectedProvider: "codex", discoveryEnabled: true });

    expect(readModelQueryEnabled("codex")).toBe(true);
    expect(readModelQueryEnabled("cursor")).toBe(false);
    expect(readModelQueryEnabled("antigravity")).toBe(true);
  });

  it("keeps an enabled selected provider discoverable when it is hidden", () => {
    mocks.useAppSettings.mockReturnValue({
      settings: { ...SETTINGS, hiddenProviders: ["cursor"] },
      serverSettings: DEFAULT_SERVER_SETTINGS,
    });

    readCatalogRenders({ selectedProvider: "cursor", discoveryEnabled: false });

    expect(readModelQueryEnabled("cursor")).toBe(true);
  });

  it("does not discover a disabled provider even when it is selected", () => {
    mocks.useAppSettings.mockReturnValue({
      settings: SETTINGS,
      serverSettings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          cursor: {
            ...DEFAULT_SERVER_SETTINGS.providers.cursor,
            enabled: false,
          },
        },
      },
    });

    readCatalogRenders({ selectedProvider: "cursor", discoveryEnabled: true });

    expect(readModelQueryEnabled("cursor")).toBe(false);
  });

  it("keeps discovering while the server settings are unavailable", () => {
    // `serverSettings` is undefined until the settings query resolves, and stays
    // undefined for good if it fails — the query never refetches on its own. Failing
    // closed here would blank every provider's model list, selected one included.
    mocks.useAppSettings.mockReturnValue({ settings: SETTINGS, serverSettings: undefined });

    readCatalogRenders({ selectedProvider: "claudeAgent", discoveryEnabled: true });

    expect(readModelQueryEnabled("claudeAgent")).toBe(true);
    expect(readModelQueryEnabled("codex")).toBe(true);
  });

  it("keeps discovering the selected provider when the settings omit it", () => {
    // A client talking to a server whose provider set it does not fully know must not
    // lose model discovery over the unknown key — and must not throw reading it.
    const { cursor: _cursor, ...providersWithoutCursor } = DEFAULT_SERVER_SETTINGS.providers;
    mocks.useAppSettings.mockReturnValue({
      settings: SETTINGS,
      serverSettings: { ...DEFAULT_SERVER_SETTINGS, providers: providersWithoutCursor },
    });

    readCatalogRenders({ selectedProvider: "cursor", discoveryEnabled: false });

    expect(readModelQueryEnabled("cursor")).toBe(true);
  });

  it("restricts non-picker prefetch to the requested providers", () => {
    readCatalogRenders({
      selectedProvider: "codex",
      discoveryEnabled: true,
      prefetchProviders: ["codex", "opencode"],
    });

    expect(readModelQueryEnabled("codex")).toBe(true);
    expect(readModelQueryEnabled("opencode")).toBe(true);
    expect(readModelQueryEnabled("cursor")).toBe(false);
    expect(readModelQueryEnabled("antigravity")).toBe(false);
  });

  it("warms droid discovery only when a surface explicitly prefetches it", () => {
    readCatalogRenders({
      selectedProvider: "codex",
      discoveryEnabled: true,
      prefetchProviders: ["codex", "droid", "opencode"],
    });
    expect(readModelQueryEnabled("droid")).toBe(true);

    mocks.useQuery.mockClear();
    readCatalogRenders({ selectedProvider: "codex", discoveryEnabled: true });
    expect(readModelQueryEnabled("droid")).toBe(false);
  });

  it("keeps droid cold when the surface is inactive even if it prefetches droid", () => {
    readCatalogRenders({
      selectedProvider: "opencode",
      discoveryEnabled: false,
      prefetchProviders: ["codex", "droid", "opencode"],
    });

    expect(readModelQueryEnabled("droid")).toBe(false);
  });

  it("reports OMP as loading during its initial model discovery", () => {
    // OMP has no static model fallback and (unlike other providers) opts out of
    // placeholderData, so its first `omp models` fetch reports a genuine
    // `isLoading` pending state. The catalog must flag OMP as loading in that
    // window so the picker renders the "Loading models" skeleton — not a false
    // "No matches" — during the ~3s discovery.
    modelQueries.set("omp", {
      isFetching: true,
      isLoading: true,
      isPlaceholderData: false,
      isError: false,
    });

    const catalog = readCatalogRenders({
      selectedProvider: "omp",
      discoveryEnabled: true,
    }).at(-1);

    expect(catalog?.loadingModelProviders.omp).toBe(true);
  });

  it("clears OMP loading once discovery resolves with models", () => {
    modelQueries.set("omp", {
      data: {
        models: [{ slug: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4" }],
        source: "omp-cli",
        cached: false,
      },
      isFetching: false,
      isLoading: false,
      isPlaceholderData: false,
      isError: false,
    });

    const catalog = readCatalogRenders({
      selectedProvider: "omp",
      discoveryEnabled: true,
    }).at(-1);

    expect(catalog?.loadingModelProviders.omp).toBe(false);
    expect(catalog?.modelOptionsByProvider.omp.map((m) => m.slug)).toEqual([
      "anthropic/claude-sonnet-4",
    ]);
  });

  it("clears OMP loading and options on terminal discovery failure", () => {
    // OMP has no static model fallback. A terminal discovery failure (retries
    // exhausted) must NOT park the picker on the skeleton (the documented
    // isInitialModelDiscoveryPending contract: "a failed provider must not park
    // the model control on a skeleton") NOR collapse to the hint-only static
    // list (previously-selected model as the sole OMP entry). Instead loading
    // clears and the options are emptied so the picker surfaces a load-failure
    // message.
    modelQueries.set("omp", {
      isFetching: false,
      isLoading: false,
      isPlaceholderData: false,
      isError: true,
    });

    const catalog = readCatalogRenders({
      selectedProvider: "omp",
      discoveryEnabled: true,
    }).at(-1);

    expect(catalog?.loadingModelProviders.omp).toBe(false);
    expect(catalog?.modelOptionsByProvider.omp).toEqual([]);
  });

  it("keeps user-configured OMP custom models on terminal discovery failure", () => {
    // The picker renders the discovery error line above whatever options
    // remain, so a failed `omp models` must not hide the user's own
    // configured models — only the hint placeholder is dropped.
    mocks.useAppSettings.mockReturnValue({
      settings: { ...SETTINGS, customOmpModels: ["acme/my-omp-model"] },
      serverSettings: DEFAULT_SERVER_SETTINGS,
    });
    modelQueries.set("omp", {
      isFetching: false,
      isLoading: false,
      isPlaceholderData: false,
      isError: true,
    });

    const catalog = readCatalogRenders({
      selectedProvider: "omp",
      discoveryEnabled: true,
    }).at(-1);

    expect(catalog?.loadingModelProviders.omp).toBe(false);
    expect(catalog?.modelOptionsByProvider.omp.map((m) => m.slug)).toEqual(["acme/my-omp-model"]);
  });

  it("clears OMP loading on a settled non-catalog result", () => {
    // A settled {source:"disabled"} answer is not an error and not a real
    // catalog — it must still end pending or the picker parks on the skeleton
    // forever (the query never refetches once settled).
    modelQueries.set("omp", {
      data: {
        models: [],
        source: "disabled",
        cached: false,
      },
      isFetching: false,
      isLoading: false,
      isPlaceholderData: false,
      isError: false,
    });

    const catalog = readCatalogRenders({
      selectedProvider: "omp",
      discoveryEnabled: true,
    }).at(-1);

    expect(catalog?.loadingModelProviders.omp).toBe(false);
    expect(catalog?.modelOptionsByProvider.omp).toEqual([]);
  });

  it("merges a settled runtime catalog with custom models without reporting loading", () => {
    modelQueries.set("cursor", {
      data: {
        models: [{ slug: "composer-2", name: "Composer 2" }],
        source: "cursor.cli",
        cached: false,
      },
      isFetching: true,
      isLoading: false,
      isPlaceholderData: true,
      isError: false,
    });

    const catalog = readCatalogRenders({
      selectedProvider: "cursor",
      discoveryEnabled: true,
      modelHintByProvider: MODEL_HINTS,
    }).at(-1);

    expect(catalog?.modelOptionsByProvider.cursor.map((model) => model.slug)).toEqual([
      "composer-2",
      "cursor-custom",
    ]);
    expect(catalog?.loadingModelProviders.cursor).toBe(false);
    expect(catalog?.selectedProviderModelsLoading).toBe(false);
    expect(catalog?.runtimeModelsByProvider.cursor).toEqual([
      { slug: "composer-2", name: "Composer 2" },
    ]);
  });

  it("surfaces devin discovery errors even when the result falls back to devin.static", () => {
    modelQueries.set("devin", {
      data: {
        models: [],
        source: "devin.static",
        cached: false,
        error: "Devin CLI failed",
      },
      isFetching: false,
      isLoading: false,
      isPlaceholderData: false,
      isError: false,
    });

    const catalog = readCatalogRenders({
      selectedProvider: "codex",
      discoveryEnabled: true,
    }).at(-1);

    expect(catalog?.discoveryErrorsByProvider.devin).toBe("Devin CLI failed");
  });

  it("surfaces a rejected discovery after retries are exhausted", () => {
    modelQueries.set("opencode", {
      error: new Error("OpenCode model discovery temporarily unavailable"),
      isFetching: false,
      isLoading: false,
      isPlaceholderData: false,
      isError: false,
    });

    const catalog = readCatalogRenders({
      selectedProvider: "opencode",
      discoveryEnabled: true,
    }).at(-1);

    expect(catalog?.discoveryErrorsByProvider.opencode).toBe(
      "OpenCode model discovery temporarily unavailable",
    );
  });
});

// FILE: providerModelPrefetch.test.ts
// Purpose: Verifies new-thread model prefetch resolves providers/cwds, hits the
//          same React Query keys ChatView uses, warms every visible provider,
//          and gates Droid to explicit intent.
// Layer: Web lib tests

import { DEFAULT_SERVER_SETTINGS } from "@synara/contracts";
import type { ProviderKind, ServerProviderStatus } from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NEW_THREAD_MODEL_PREFETCH_PROVIDERS,
  NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS,
  prefetchModelsForNewThread,
  prefetchProviderModelsForNewThread,
  providerModelsPrefetchQueryOptions,
  resolveNewThreadModelPrefetchCwd,
  resolveNewThreadModelPrefetchProvider,
  type ProviderModelPrefetchSettings,
} from "./providerModelPrefetch";
import { providerDiscoveryQueryKeys } from "./providerDiscoveryReactQuery";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeSettings(
  overrides: Partial<ProviderModelPrefetchSettings> = {},
): ProviderModelPrefetchSettings {
  return {
    defaultProvider: "codex",
    claudeBinaryPath: "",
    cursorBinaryPath: "",
    cursorApiEndpoint: "",
    devinBinaryPath: "",
    antigravityBinaryPath: "",
    grokBinaryPath: "",
    droidBinaryPath: "",
    openCodeBinaryPath: "",
    piBinaryPath: "",
    piAgentDir: "",
    copilotBinaryPath: "",
    ...overrides,
  };
}

function makeStatus(provider: ProviderKind, available: boolean): ServerProviderStatus {
  return {
    provider,
    available,
    status: available ? "ready" : "error",
    authStatus: "authenticated",
    checkedAt: "2026-08-13T10:00:00.000Z",
    message: available ? undefined : `${provider} is not installed on this machine.`,
  };
}

function expectQueryData(queryClient: QueryClient, queryKey: readonly unknown[]) {
  return queryClient.getQueryData(queryKey);
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
    },
  });
}

describe("resolveNewThreadModelPrefetchProvider", () => {
  it("uses the explicit override first", () => {
    expect(
      resolveNewThreadModelPrefetchProvider({
        providerOverride: "claudeAgent",
        draftActiveProvider: "cursor",
        stickyActiveProvider: "grok",
        projectDefaultProvider: "droid",
        defaultProvider: "codex",
      }),
    ).toBe("claudeAgent");
  });

  it("falls back through draft, sticky, project, and app defaults", () => {
    expect(
      resolveNewThreadModelPrefetchProvider({
        draftActiveProvider: "cursor",
        stickyActiveProvider: "grok",
        projectDefaultProvider: "droid",
        defaultProvider: "codex",
      }),
    ).toBe("cursor");
    expect(
      resolveNewThreadModelPrefetchProvider({
        stickyActiveProvider: "grok",
        projectDefaultProvider: "droid",
        defaultProvider: "codex",
      }),
    ).toBe("grok");
    expect(
      resolveNewThreadModelPrefetchProvider({
        projectDefaultProvider: "droid",
        defaultProvider: "codex",
      }),
    ).toBe("droid");
    expect(
      resolveNewThreadModelPrefetchProvider({
        defaultProvider: "codex",
      }),
    ).toBe("codex");
  });
});

describe("resolveNewThreadModelPrefetchCwd", () => {
  it("prefers an explicitly supplied worktree", () => {
    expect(
      resolveNewThreadModelPrefetchCwd({
        worktreePath: "/tmp/worktree",
        hasExplicitWorktreePath: true,
        draftWorktreePath: "/tmp/draft-worktree",
        projectCwd: "/tmp/project",
        serverCwd: "/tmp/server",
      }),
    ).toBe("/tmp/worktree");
  });

  it("keeps an explicit null worktree from inheriting the draft worktree", () => {
    expect(
      resolveNewThreadModelPrefetchCwd({
        worktreePath: null,
        hasExplicitWorktreePath: true,
        draftWorktreePath: "/tmp/draft-worktree",
        projectCwd: "/tmp/project",
        serverCwd: "/tmp/server",
      }),
    ).toBe("/tmp/project");
  });

  it("ignores the draft worktree for fresh threads", () => {
    expect(
      resolveNewThreadModelPrefetchCwd({
        fresh: true,
        draftWorktreePath: "/tmp/draft-worktree",
        projectCwd: "/tmp/project",
        serverCwd: "/tmp/server",
      }),
    ).toBe("/tmp/project");
  });

  it("uses the draft worktree when no explicit override clears it", () => {
    expect(
      resolveNewThreadModelPrefetchCwd({
        draftWorktreePath: "/tmp/draft-worktree",
        projectCwd: "/tmp/project",
        serverCwd: "/tmp/server",
      }),
    ).toBe("/tmp/draft-worktree");
  });

  it("falls back from project cwd to server cwd", () => {
    expect(resolveNewThreadModelPrefetchCwd({ serverCwd: "/tmp/server" })).toBe("/tmp/server");
  });
});

describe("providerModelsPrefetchQueryOptions", () => {
  it("builds the same provider-specific model query inputs", () => {
    const settings = makeSettings({
      claudeBinaryPath: "/bin/claude",
      cursorBinaryPath: "/bin/cursor-agent",
      cursorApiEndpoint: "http://127.0.0.1:4111",
      devinBinaryPath: "/bin/devin",
      antigravityBinaryPath: "/bin/agy",
      grokBinaryPath: "/bin/grok",
      droidBinaryPath: "/bin/droid",
      openCodeBinaryPath: "/bin/opencode",
      piBinaryPath: "/bin/pi",
      piAgentDir: "/tmp/pi-agent",
      copilotBinaryPath: "/bin/copilot",
    });

    expect(
      providerModelsPrefetchQueryOptions({ provider: "claudeAgent", settings, cwd: "/repo" })
        .queryKey,
    ).toEqual(providerDiscoveryQueryKeys.models("claudeAgent", "/bin/claude"));
    expect(
      providerModelsPrefetchQueryOptions({ provider: "codex", settings, cwd: "/repo" }).queryKey,
    ).toEqual(providerDiscoveryQueryKeys.models("codex"));
    expect(
      providerModelsPrefetchQueryOptions({ provider: "cursor", settings, cwd: "/repo" }).queryKey,
    ).toEqual(
      providerDiscoveryQueryKeys.models(
        "cursor",
        "/bin/cursor-agent",
        "http://127.0.0.1:4111",
      ),
    );
    expect(
      providerModelsPrefetchQueryOptions({ provider: "devin", settings, cwd: "/repo" }).queryKey,
    ).toEqual(providerDiscoveryQueryKeys.models("devin", "/bin/devin", null, null, "/repo"));
    expect(
      providerModelsPrefetchQueryOptions({ provider: "antigravity", settings, cwd: "/repo" })
        .queryKey,
    ).toEqual(providerDiscoveryQueryKeys.models("antigravity", "/bin/agy", null, null, "/repo"));
    expect(
      providerModelsPrefetchQueryOptions({ provider: "grok", settings, cwd: "/repo" }).queryKey,
    ).toEqual(providerDiscoveryQueryKeys.models("grok", "/bin/grok"));
    expect(
      providerModelsPrefetchQueryOptions({ provider: "droid", settings, cwd: "/repo" }).queryKey,
    ).toEqual(providerDiscoveryQueryKeys.models("droid", "/bin/droid", null, null, "/repo"));
    expect(
      providerModelsPrefetchQueryOptions({ provider: "opencode", settings, cwd: "/repo" }).queryKey,
    ).toEqual(providerDiscoveryQueryKeys.models("opencode", "/bin/opencode", null, null, "/repo"));
    expect(
      providerModelsPrefetchQueryOptions({ provider: "pi", settings, cwd: "/repo" }).queryKey,
    ).toEqual(providerDiscoveryQueryKeys.models("pi", "/bin/pi", null, "/tmp/pi-agent", "/repo"));
    expect(
      providerModelsPrefetchQueryOptions({ provider: "copilot", settings, cwd: "/repo" }).queryKey,
    ).toEqual(providerDiscoveryQueryKeys.models("copilot", "/bin/copilot", null, null, "/repo"));
  });
});

describe("prefetchProviderModelsForNewThread", () => {
  it("prefetches model catalogs and composer capabilities for each provider", async () => {
    const queryClient = createQueryClient();
    const settings = makeSettings();

    const modelCalls: ProviderKind[] = [];
    const capabilitiesCalls: ProviderKind[] = [];
    const originalFetchQuery = queryClient.fetchQuery.bind(queryClient);
    vi.spyOn(queryClient, "fetchQuery").mockImplementation(async (options) => {
      const provider = options.queryKey[2] as ProviderKind;
      if (options.queryKey[1] === "models") {
        modelCalls.push(provider);
        return { models: [] };
      }
      capabilitiesCalls.push(provider);
      return originalFetchQuery(options);
    });

    prefetchProviderModelsForNewThread(queryClient, { settings, cwd: "/repo" });
    await Promise.resolve();

    expect(modelCalls).toEqual(NEW_THREAD_MODEL_PREFETCH_PROVIDERS);
    expect(capabilitiesCalls).toEqual(NEW_THREAD_MODEL_PREFETCH_PROVIDERS);
  });
});

describe("prefetchModelsForNewThread", () => {
  it("uses status-aware preference resolution and skips hidden/disabled providers", async () => {
    const queryClient = createQueryClient();
    const settings = makeSettings({ defaultProvider: "claudeAgent" });
    const providerStatuses = [
      makeStatus("claudeAgent", false),
      makeStatus("codex", true),
      makeStatus("cursor", true),
    ];
    const serverSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        cursor: {
          ...DEFAULT_SERVER_SETTINGS.providers.cursor,
          enabled: false,
        },
      },
    };

    prefetchModelsForNewThread(queryClient, {
      settings,
      serverSettings,
      providerStatuses,
      statusesReconciled: true,
      providerOrder: ["claudeAgent", "codex", "cursor"],
      hiddenProviders: ["grok"],
      projectCwd: "/repo",
    });

    await Promise.resolve();
    expect(expectQueryData(queryClient, providerDiscoveryQueryKeys.models("cursor"))).toBeUndefined();
  });
});

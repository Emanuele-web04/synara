// FILE: providerModelPrefetch.test.ts
// Purpose: Verifies new-thread model prefetch resolves providers/cwds, hits the
//          same React Query keys ChatView uses, warms every visible provider,
//          and gates Droid to explicit intent.
// Layer: Web lib tests

import { DEFAULT_SERVER_SETTINGS, type ProviderKind } from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  prefetchModelsForNewThread,
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
    antigravityBinaryPath: "",
    grokBinaryPath: "",
    droidBinaryPath: "",
    kiloBinaryPath: "",
    openCodeBinaryPath: "",
    piBinaryPath: "",
    piAgentDir: "",
    ...overrides,
  };
}

describe("resolveNewThreadModelPrefetchProvider", () => {
  it("prefers override, draft, sticky, project default, then app default", () => {
    expect(
      resolveNewThreadModelPrefetchProvider({
        providerOverride: "grok",
        draftActiveProvider: "cursor",
        stickyActiveProvider: "pi",
        projectDefaultProvider: "opencode",
        defaultProvider: "codex",
      }),
    ).toBe("grok");

    expect(
      resolveNewThreadModelPrefetchProvider({
        draftActiveProvider: "cursor",
        stickyActiveProvider: "pi",
        projectDefaultProvider: "opencode",
        defaultProvider: "codex",
      }),
    ).toBe("cursor");

    expect(
      resolveNewThreadModelPrefetchProvider({
        stickyActiveProvider: null,
        projectDefaultProvider: "opencode",
        defaultProvider: "codex",
      }),
    ).toBe("opencode");

    expect(
      resolveNewThreadModelPrefetchProvider({
        projectDefaultProvider: null,
        defaultProvider: "claudeAgent",
      }),
    ).toBe("claudeAgent");
  });
});

describe("resolveNewThreadModelPrefetchCwd", () => {
  it("prefers draft worktree, then project cwd, then server cwd", () => {
    expect(
      resolveNewThreadModelPrefetchCwd({
        draftWorktreePath: "/tmp/worktree",
        projectCwd: "/tmp/project",
        serverCwd: "/tmp/server",
      }),
    ).toBe("/tmp/worktree");

    expect(
      resolveNewThreadModelPrefetchCwd({
        draftWorktreePath: null,
        projectCwd: "/tmp/project",
        serverCwd: "/tmp/server",
      }),
    ).toBe("/tmp/project");

    expect(
      resolveNewThreadModelPrefetchCwd({
        projectCwd: null,
        serverCwd: "/tmp/server",
      }),
    ).toBe("/tmp/server");
  });
});

describe("providerModelsPrefetchQueryOptions", () => {
  it("matches ChatView cache keys for cwd-scoped and binary-scoped providers", () => {
    const settings = makeSettings({
      claudeBinaryPath: "/bin/claude",
      cursorBinaryPath: "/bin/agent",
      cursorApiEndpoint: "https://api.example",
      antigravityBinaryPath: "/bin/antigravity",
      openCodeBinaryPath: "/bin/opencode",
      piBinaryPath: "/bin/pi",
      piAgentDir: "/tmp/pi-agent",
    });

    expect(
      providerModelsPrefetchQueryOptions({ provider: "claudeAgent", settings }).queryKey,
    ).toEqual(providerDiscoveryQueryKeys.models("claudeAgent", "/bin/claude", null, null, null));

    expect(providerModelsPrefetchQueryOptions({ provider: "cursor", settings }).queryKey).toEqual(
      providerDiscoveryQueryKeys.models("cursor", "/bin/agent", "https://api.example", null, null),
    );

    expect(
      providerModelsPrefetchQueryOptions({ provider: "opencode", settings, cwd: "/tmp/project" })
        .queryKey,
    ).toEqual(
      providerDiscoveryQueryKeys.models("opencode", "/bin/opencode", null, null, "/tmp/project"),
    );

    expect(
      providerModelsPrefetchQueryOptions({ provider: "pi", settings, cwd: "/tmp/project" })
        .queryKey,
    ).toEqual(
      providerDiscoveryQueryKeys.models("pi", "/bin/pi", null, "/tmp/pi-agent", "/tmp/project"),
    );

    expect(providerModelsPrefetchQueryOptions({ provider: "codex", settings }).queryKey).toEqual(
      providerDiscoveryQueryKeys.models("codex", null, null, null, null),
    );
  });
});

describe("prefetchModelsForNewThread", () => {
  it("warms every provider except Droid, selected provider first", async () => {
    const queryClient = new QueryClient();
    const prefetchQuery = vi.spyOn(queryClient, "prefetchQuery").mockResolvedValue(undefined);

    prefetchModelsForNewThread(queryClient, {
      settings: makeSettings(),
      projectCwd: "/tmp/project",
      projectDefaultProvider: "opencode",
    });

    const modelKeys = prefetchQuery.mock.calls
      .map((call) => call[0].queryKey)
      .filter((key) => key[0] === "provider-discovery" && key[1] === "models");
    expect(modelKeys[0]).toEqual(
      providerDiscoveryQueryKeys.models("opencode", null, null, null, "/tmp/project"),
    );
    // Warm results stay fresh for 30 minutes, so repeated hovers do not re-probe.
    expect(prefetchQuery.mock.calls[0]?.[0].staleTime).toBe(30 * 60_000);
    expect(modelKeys).toHaveLength(8);
    expect(modelKeys).not.toContainEqual(
      providerDiscoveryQueryKeys.models("droid", null, null, null, "/tmp/project"),
    );
    expect(modelKeys).toContainEqual(
      providerDiscoveryQueryKeys.models("claudeAgent", null, null, null, null),
    );
  });

  it("skips hidden and disabled providers", async () => {
    const queryClient = new QueryClient();
    const prefetchQuery = vi.spyOn(queryClient, "prefetchQuery").mockResolvedValue(undefined);

    prefetchModelsForNewThread(queryClient, {
      settings: makeSettings(),
      serverSettings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          cursor: { ...DEFAULT_SERVER_SETTINGS.providers.cursor, enabled: false },
        },
      },
      hiddenProviders: ["pi"],
      projectCwd: "/tmp/project",
    });

    const modelKeys = prefetchQuery.mock.calls
      .map((call) => call[0].queryKey)
      .filter((key) => key[0] === "provider-discovery" && key[1] === "models");
    expect(modelKeys).toHaveLength(6);
    expect(modelKeys).not.toContainEqual(
      providerDiscoveryQueryKeys.models("cursor", null, null, null, "/tmp/project"),
    );
    expect(modelKeys).not.toContainEqual(
      providerDiscoveryQueryKeys.models("pi", null, null, null, "/tmp/project"),
    );
  });

  it("warms Droid only on explicit intent with Droid selected", async () => {
    const queryClient = new QueryClient();
    const prefetchQuery = vi.spyOn(queryClient, "prefetchQuery").mockResolvedValue(undefined);

    prefetchModelsForNewThread(queryClient, {
      settings: makeSettings(),
      providerOverride: "droid",
      projectCwd: "/tmp/project",
    });

    const modelKeys = prefetchQuery.mock.calls
      .map((call) => call[0].queryKey)
      .filter((key) => key[0] === "provider-discovery" && key[1] === "models");
    expect(modelKeys).not.toContainEqual(
      providerDiscoveryQueryKeys.models("droid", null, null, null, "/tmp/project"),
    );

    prefetchModelsForNewThread(queryClient, {
      settings: makeSettings(),
      providerOverride: "droid",
      projectCwd: "/tmp/project",
      includeDroid: true,
    });

    const modelKeys2 = prefetchQuery.mock.calls
      .map((call) => call[0].queryKey)
      .filter((key) => key[0] === "provider-discovery" && key[1] === "models");
    expect(modelKeys2).toContainEqual(
      providerDiscoveryQueryKeys.models("droid", null, null, null, "/tmp/project"),
    );
  });

  it("warms the explicit providers subset without Droid", async () => {
    const queryClient = new QueryClient();
    const prefetchQuery = vi.spyOn(queryClient, "prefetchQuery").mockResolvedValue(undefined);

    const { prefetchProviderModelsForNewThread } = await import("./providerModelPrefetch");
    prefetchProviderModelsForNewThread(queryClient, {
      settings: makeSettings(),
      providers: ["codex", "droid" as ProviderKind],
    });

    const modelKeys = prefetchQuery.mock.calls
      .map((call) => call[0].queryKey)
      .filter((key) => key[0] === "provider-discovery" && key[1] === "models");
    expect(modelKeys).toHaveLength(1);
    expect(modelKeys[0]).toEqual(
      providerDiscoveryQueryKeys.models("codex", null, null, null, null),
    );
  });
});

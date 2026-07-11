import {
  type ModelSlug,
  type ProviderInstanceId,
  type ProviderKind,
  type ServerProviderStatus,
} from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  ProviderModelPicker,
  type ProviderModelFavorite,
  type ProviderModelPickerInstance,
} from "./ProviderModelPicker";
import type { ProviderModelOption } from "../../providerModelOptions";

const MODEL_OPTIONS_BY_PROVIDER = {
  claudeAgent: [
    { slug: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { slug: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  ],
  codex: [
    { slug: "gpt-5-codex", name: "GPT-5 Codex" },
    { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
  ],
  cursor: [
    { slug: "auto", name: "Auto" },
    { slug: "composer-2", name: "Composer 2" },
  ],
  gemini: [
    { slug: "auto-gemini-3", name: "Auto Gemini 3" },
    { slug: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  ],
  grok: [
    { slug: "grok-build-0.1", name: "Grok Build 0.1" },
    { slug: "grok-build", name: "Grok 4.3" },
  ],
  kilo: [
    {
      slug: "kilo/kilo-auto/free",
      name: "Kilo Auto Free",
      upstreamProviderId: "kilo",
      upstreamProviderName: "Kilo",
    },
  ],
  opencode: [
    {
      slug: "opencode/nemotron-3-super-free",
      name: "Nemotron 3 Super Free",
      upstreamProviderId: "opencode",
      upstreamProviderName: "OpenCode",
    },
    {
      slug: "openai/gpt-5",
      name: "GPT-5",
      upstreamProviderId: "openai",
      upstreamProviderName: "OpenAI",
    },
  ],
  pi: [
    {
      slug: "anthropic/claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      upstreamProviderId: "anthropic",
      upstreamProviderName: "Anthropic",
    },
  ],
} as const satisfies Record<ProviderKind, ReadonlyArray<ProviderModelOption & { slug: ModelSlug }>>;

const MANY_OPENCODE_MODELS = Array.from({ length: 16 }, (_, index) => ({
  slug: `${index % 2 === 0 ? "openai" : "anthropic"}/model-${index + 1}` as ModelSlug,
  name: `${index % 2 === 0 ? "GPT" : "Claude"} ${index + 1}`,
  upstreamProviderId: index % 2 === 0 ? "openai" : "anthropic",
  upstreamProviderName: index % 2 === 0 ? "OpenAI" : "Anthropic",
})) satisfies ReadonlyArray<ProviderModelOption & { slug: ModelSlug }>;

const OPENCODE_FAVORITE_SORT_MODELS = [
  {
    slug: "anthropic/claude-favorite-sort" as ModelSlug,
    name: "Claude Favorite Sort",
    upstreamProviderId: "anthropic",
    upstreamProviderName: "Anthropic",
  },
  {
    slug: "openai/gpt-favorite-sort" as ModelSlug,
    name: "GPT Favorite Sort",
    upstreamProviderId: "openai",
    upstreamProviderName: "OpenAI",
  },
] satisfies ReadonlyArray<ProviderModelOption & { slug: ModelSlug }>;

const MANY_CURSOR_MODELS = Array.from({ length: 16 }, (_, index) => ({
  slug: `cursor-model-${index + 1}` as ModelSlug,
  name: `${index % 2 === 0 ? "GPT" : "Claude"} Cursor ${index + 1}`,
  upstreamProviderId: index % 2 === 0 ? "openai" : "anthropic",
  upstreamProviderName: index % 2 === 0 ? "OpenAI" : "Anthropic",
})) satisfies ReadonlyArray<ProviderModelOption & { slug: ModelSlug }>;

const CURSOR_FAVORITE_SORT_MODELS = [
  {
    slug: "cursor-claude-favorite-sort" as ModelSlug,
    name: "Claude Cursor Favorite Sort",
    upstreamProviderId: "anthropic",
    upstreamProviderName: "Anthropic",
  },
  {
    slug: "cursor-gpt-favorite-sort" as ModelSlug,
    name: "GPT Cursor Favorite Sort",
    upstreamProviderId: "openai",
    upstreamProviderName: "OpenAI",
  },
] satisfies ReadonlyArray<ProviderModelOption & { slug: ModelSlug }>;

const PI_FAVORITE_SORT_MODELS = [
  {
    slug: "anthropic/claude-pi-favorite-sort" as ModelSlug,
    name: "Claude Pi Favorite Sort",
    upstreamProviderId: "anthropic",
    upstreamProviderName: "Anthropic",
  },
  {
    slug: "openai/gpt-pi-favorite-sort" as ModelSlug,
    name: "GPT Pi Favorite Sort",
    upstreamProviderId: "openai",
    upstreamProviderName: "OpenAI",
  },
] satisfies ReadonlyArray<ProviderModelOption & { slug: ModelSlug }>;

function providerStatus(
  provider: ProviderKind,
  overrides: Partial<ServerProviderStatus> = {},
): ServerProviderStatus {
  return {
    provider,
    instanceId: provider,
    driver: provider,
    status: "ready",
    available: true,
    authStatus: "authenticated",
    checkedAt: "2026-04-10T10:00:00.000Z",
    ...overrides,
  };
}

async function mountPicker(props: {
  provider: ProviderKind;
  model: ModelSlug;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProviderStatus>;
  loadingModelProviders?: Partial<Record<ProviderKind, boolean>>;
  onSelectionCommitted?: () => void;
  providerInstances?: ReadonlyArray<ProviderModelPickerInstance>;
  selectedProviderInstanceId?: ProviderInstanceId;
  showProviderInstanceChoices?: boolean;
  favoriteModels?: ReadonlyArray<ProviderModelFavorite>;
  onFavoriteModelsChange?: (favoriteModels: ProviderModelFavorite[]) => void;
  modelOptionsByProviderInstance?: Partial<
    Record<ProviderInstanceId, ReadonlyArray<ProviderModelOption & { slug: ModelSlug }>>
  >;
  modelOptionsByProvider?: Record<
    ProviderKind,
    ReadonlyArray<ProviderModelOption & { slug: ModelSlug }>
  >;
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const onProviderModelChange = vi.fn();
  const screen = await render(
    <ProviderModelPicker
      provider={props.provider}
      model={props.model}
      lockedProvider={props.lockedProvider}
      modelOptionsByProvider={props.modelOptionsByProvider ?? MODEL_OPTIONS_BY_PROVIDER}
      {...(props.loadingModelProviders
        ? { loadingModelProviders: props.loadingModelProviders }
        : {})}
      {...(props.providers ? { providers: props.providers } : {})}
      {...(props.providerInstances ? { providerInstances: props.providerInstances } : {})}
      {...(props.selectedProviderInstanceId
        ? { selectedProviderInstanceId: props.selectedProviderInstanceId }
        : {})}
      {...(props.showProviderInstanceChoices !== undefined
        ? { showProviderInstanceChoices: props.showProviderInstanceChoices }
        : {})}
      {...(props.favoriteModels ? { favoriteModels: props.favoriteModels } : {})}
      {...(props.onFavoriteModelsChange
        ? { onFavoriteModelsChange: props.onFavoriteModelsChange }
        : {})}
      {...(props.modelOptionsByProviderInstance
        ? { modelOptionsByProviderInstance: props.modelOptionsByProviderInstance }
        : {})}
      {...(props.onSelectionCommitted ? { onSelectionCommitted: props.onSelectionCommitted } : {})}
      onProviderModelChange={onProviderModelChange}
    />,
    { container: host },
  );

  return {
    onProviderModelChange,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("ProviderModelPicker", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("shows provider submenus when provider switching is allowed", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Codex");
        expect(text).toContain("Claude");
        expect(text).not.toContain("Claude Sonnet 4.6");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("selects an enabled provider instance when switching providers", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: null,
      providerInstances: [
        {
          instanceId: "opencode",
          provider: "opencode",
          label: "Default OpenCode",
          enabled: false,
          isDefault: true,
        },
        {
          instanceId: "opencode_work",
          provider: "opencode",
          label: "Work OpenCode",
          enabled: true,
          isDefault: false,
        },
      ],
      providers: [
        {
          provider: "opencode",
          instanceId: "opencode_work",
          driver: "opencode",
          status: "ready",
          available: true,
          authStatus: "authenticated",
          checkedAt: "2026-04-10T10:00:00.000Z",
        },
      ],
      modelOptionsByProviderInstance: {
        opencode_work: [{ slug: "work/opencode-model", name: "Work OpenCode Model" }],
      },
    });

    try {
      await page.getByRole("button").click();
      await page.getByText("OpenCode").click();
      await page.getByRole("menuitemradio", { name: "Work OpenCode Model" }).click();

      expect(mounted.onProviderModelChange).toHaveBeenCalledWith(
        "opencode",
        "work/opencode-model",
        "opencode_work",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows models directly when the provider is locked mid-thread", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: "claudeAgent",
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Claude Sonnet 4.6");
        expect(text).toContain("Claude Haiku 4.5");
        expect(text).not.toContain("Codex");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("dispatches the canonical slug when a model is selected", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: "claudeAgent",
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("menuitemradio", { name: "Claude Sonnet 4.6" }).click();

      expect(mounted.onProviderModelChange).toHaveBeenCalledWith(
        "claudeAgent",
        "claude-sonnet-4-6",
        "claudeAgent",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("stores settings-backed favourites by exact provider instance", async () => {
    const onFavoriteModelsChange = vi.fn();
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: "claudeAgent",
      selectedProviderInstanceId: "claude_work",
      providerInstances: [
        {
          instanceId: "claudeAgent",
          provider: "claudeAgent",
          label: "Personal Claude",
          enabled: true,
          isDefault: true,
        },
        {
          instanceId: "claude_work",
          provider: "claudeAgent",
          label: "Work Claude",
          enabled: true,
          isDefault: false,
        },
      ],
      providers: [
        {
          provider: "claudeAgent",
          instanceId: "claude_work",
          driver: "claudeAgent",
          status: "ready",
          available: true,
          authStatus: "authenticated",
          checkedAt: "2026-04-10T10:00:00.000Z",
        },
      ],
      favoriteModels: [],
      onFavoriteModelsChange,
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("button", { name: "Add Claude Sonnet 4.6 to favourites" }).click();

      expect(onFavoriteModelsChange).toHaveBeenCalledWith([
        { provider: "claude_work", model: "claude-sonnet-4-6" },
      ]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps account choices out of the model picker", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: "codex",
      showProviderInstanceChoices: false,
      selectedProviderInstanceId: "codex",
      providerInstances: [
        {
          instanceId: "codex",
          provider: "codex",
          label: "Personal",
          enabled: true,
          isDefault: true,
        },
        {
          instanceId: "codex_work",
          provider: "codex",
          label: "Work",
          enabled: true,
          isDefault: false,
        },
      ],
      providers: [
        {
          provider: "codex",
          instanceId: "codex",
          driver: "codex",
          status: "ready",
          available: true,
          authStatus: "authenticated",
          checkedAt: "2026-04-10T10:00:00.000Z",
        },
        {
          provider: "codex",
          instanceId: "codex_work",
          driver: "codex",
          status: "ready",
          available: true,
          authStatus: "authenticated",
          checkedAt: "2026-04-10T10:00:00.000Z",
        },
      ],
      modelOptionsByProviderInstance: {
        codex_work: [{ slug: "gpt-5-work-codex", name: "GPT-5 Work Codex" }],
      },
    });

    try {
      await page.getByRole("button").click();
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").not.toContain("Work");
        expect(document.body.textContent ?? "").toContain("GPT-5 Codex");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps embedded account choices for standalone picker callers", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: "codex",
      selectedProviderInstanceId: "codex",
      providerInstances: [
        {
          instanceId: "codex",
          provider: "codex",
          label: "Personal",
          enabled: true,
          isDefault: true,
        },
        {
          instanceId: "codex_work",
          provider: "codex",
          label: "Work",
          enabled: true,
          isDefault: false,
        },
      ],
      providers: [
        providerStatus("codex"),
        providerStatus("codex", {
          instanceId: "codex_work",
          displayName: "Work",
        }),
      ],
      modelOptionsByProviderInstance: {
        codex_work: [{ slug: "gpt-5-work-codex", name: "GPT-5 Work Codex" }],
      },
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("menuitemradio", { name: "Work" }).click();

      expect(mounted.onProviderModelChange).toHaveBeenCalledWith(
        "codex",
        "gpt-5-work-codex",
        "codex_work",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a removed active account and commits a valid replacement account", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: null,
      selectedProviderInstanceId: "codex_removed",
      providerInstances: [
        {
          instanceId: "codex",
          provider: "codex",
          label: "Personal",
          enabled: true,
          isDefault: true,
        },
      ],
      providers: [providerStatus("codex")],
    });

    try {
      await expect
        .element(page.getByRole("button", { name: /Missing account · GPT-5 Codex/ }))
        .toBeInTheDocument();
      await page.getByRole("button", { name: /Missing account · GPT-5 Codex/ }).click();
      await page.getByText("Codex", { exact: true }).click();

      const missingAccount = page.getByRole("menuitemradio", { name: /Missing account/ });
      await expect.element(missingAccount).toBeDisabled();
      await page.getByRole("menuitemradio", { name: "Personal" }).click();

      expect(mounted.onProviderModelChange).toHaveBeenCalledWith("codex", "gpt-5-codex", "codex");
      expect(mounted.onProviderModelChange).not.toHaveBeenCalledWith(
        "codex",
        "gpt-5-codex",
        "codex_removed",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("preserves the selected same-provider instance when selecting one of its models", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-work-codex",
      lockedProvider: "codex",
      selectedProviderInstanceId: "codex_work",
      providerInstances: [
        {
          instanceId: "codex",
          provider: "codex",
          label: "Personal",
          enabled: true,
          isDefault: true,
        },
        {
          instanceId: "codex_work",
          provider: "codex",
          label: "Work",
          enabled: true,
          isDefault: false,
        },
      ],
      providers: [
        {
          provider: "codex",
          instanceId: "codex",
          driver: "codex",
          status: "ready",
          available: true,
          authStatus: "authenticated",
          checkedAt: "2026-04-10T10:00:00.000Z",
        },
        {
          provider: "codex",
          instanceId: "codex_work",
          driver: "codex",
          status: "ready",
          available: true,
          authStatus: "authenticated",
          checkedAt: "2026-04-10T10:00:00.000Z",
        },
      ],
      modelOptionsByProviderInstance: {
        codex_work: [
          { slug: "gpt-5-work-codex", name: "GPT-5 Work Codex" },
          { slug: "gpt-5-work-fast", name: "GPT-5 Work Fast" },
        ],
      },
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("menuitemradio", { name: "GPT-5 Work Fast" }).click();

      expect(mounted.onProviderModelChange).toHaveBeenCalledWith(
        "codex",
        "gpt-5-work-fast",
        "codex_work",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("notifies after a model selection commits so the composer can refocus", async () => {
    const onSelectionCommitted = vi.fn();
    const mounted = await mountPicker({
      provider: "grok",
      model: "grok-build",
      lockedProvider: "grok",
      onSelectionCommitted,
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("menuitemradio", { name: "Grok 4.3" }).click();

      await vi.waitFor(() => {
        expect(onSelectionCommitted).toHaveBeenCalledTimes(1);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("groups upstream OpenCode models by provider label", async () => {
    const mounted = await mountPicker({
      provider: "opencode",
      model: "openai/gpt-5",
      lockedProvider: "opencode",
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("OpenCode");
        expect(text).toContain("Nemotron 3 Super Free");
        expect(text).toContain("OpenAI");
        expect(text).toContain("GPT-5");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows OpenCode search when the provider has at least fifteen models", async () => {
    const mounted = await mountPicker({
      provider: "opencode",
      model: MANY_OPENCODE_MODELS[0]!.slug,
      lockedProvider: "opencode",
      modelOptionsByProvider: {
        ...MODEL_OPTIONS_BY_PROVIDER,
        opencode: MANY_OPENCODE_MODELS,
      },
    });

    try {
      await page.getByRole("button").click();

      await expect.element(page.getByPlaceholder("Search models or providers")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("filters OpenCode models by upstream provider name", async () => {
    const mounted = await mountPicker({
      provider: "opencode",
      model: MANY_OPENCODE_MODELS[0]!.slug,
      lockedProvider: "opencode",
      modelOptionsByProvider: {
        ...MODEL_OPTIONS_BY_PROVIDER,
        opencode: MANY_OPENCODE_MODELS,
      },
    });

    try {
      await page.getByRole("button").click();
      await page.getByPlaceholder("Search models or providers").fill("Anthropic");

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("Claude 2");
      });

      await expect
        .element(page.getByRole("menuitemradio", { name: "Claude 2" }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("menuitemradio", { name: "GPT 1" }))
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows favourited OpenCode models in their own top category", async () => {
    const mounted = await mountPicker({
      provider: "opencode",
      model: "anthropic/claude-favorite-sort",
      lockedProvider: "opencode",
      modelOptionsByProvider: {
        ...MODEL_OPTIONS_BY_PROVIDER,
        opencode: OPENCODE_FAVORITE_SORT_MODELS,
      },
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text.indexOf("Anthropic")).toBeLessThan(text.indexOf("OpenAI"));
      });

      await page.getByRole("button", { name: "Add GPT Favorite Sort to favourites" }).click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text.indexOf("Favourites")).toBeLessThan(text.indexOf("Anthropic"));
        expect(text.indexOf("GPT Favorite Sort")).toBeGreaterThan(text.indexOf("Favourites"));
        expect(text.indexOf("GPT Favorite Sort")).toBeLessThan(text.indexOf("Anthropic"));
      });
      await expect
        .element(page.getByRole("menuitemradio", { name: "GPT Favorite Sort" }))
        .toBeInTheDocument();
      expect(
        Array.from(document.querySelectorAll('[role="menuitemradio"]')).filter((element) =>
          element.textContent?.includes("GPT Favorite Sort"),
        ),
      ).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps OpenCode model favourites scoped to the selected provider instance", async () => {
    const openCodeProviders: ReadonlyArray<ServerProviderStatus> = [
      {
        provider: "opencode",
        instanceId: "opencode",
        driver: "opencode",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        checkedAt: "2026-04-10T10:00:00.000Z",
      },
      {
        provider: "opencode",
        instanceId: "opencode_work",
        driver: "opencode",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        checkedAt: "2026-04-10T10:00:00.000Z",
      },
    ];
    const openCodeInstances: ReadonlyArray<ProviderModelPickerInstance> = [
      {
        instanceId: "opencode",
        provider: "opencode",
        label: "Default OpenCode",
        enabled: true,
        isDefault: true,
      },
      {
        instanceId: "opencode_work",
        provider: "opencode",
        label: "Work OpenCode",
        enabled: true,
        isDefault: false,
      },
    ];
    const mounted = await mountPicker({
      provider: "opencode",
      model: "anthropic/claude-favorite-sort",
      lockedProvider: "opencode",
      providers: openCodeProviders,
      providerInstances: openCodeInstances,
      selectedProviderInstanceId: "opencode_work",
      modelOptionsByProvider: {
        ...MODEL_OPTIONS_BY_PROVIDER,
        opencode: OPENCODE_FAVORITE_SORT_MODELS,
      },
      modelOptionsByProviderInstance: {
        opencode: OPENCODE_FAVORITE_SORT_MODELS,
        opencode_work: OPENCODE_FAVORITE_SORT_MODELS,
      },
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("button", { name: "Add GPT Favorite Sort to favourites" }).click();

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("Favourites");
      });
    } finally {
      await mounted.cleanup();
    }

    const defaultMounted = await mountPicker({
      provider: "opencode",
      model: "anthropic/claude-favorite-sort",
      lockedProvider: "opencode",
      providers: openCodeProviders,
      providerInstances: openCodeInstances,
      selectedProviderInstanceId: "opencode",
      modelOptionsByProvider: {
        ...MODEL_OPTIONS_BY_PROVIDER,
        opencode: OPENCODE_FAVORITE_SORT_MODELS,
      },
      modelOptionsByProviderInstance: {
        opencode: OPENCODE_FAVORITE_SORT_MODELS,
        opencode_work: OPENCODE_FAVORITE_SORT_MODELS,
      },
    });

    try {
      await page.getByRole("button").click();
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").not.toContain("Favourites");
      });
    } finally {
      await defaultMounted.cleanup();
    }
  });

  it("filters Cursor models by upstream provider name", async () => {
    const mounted = await mountPicker({
      provider: "cursor",
      model: MANY_CURSOR_MODELS[0]!.slug,
      lockedProvider: "cursor",
      modelOptionsByProvider: {
        ...MODEL_OPTIONS_BY_PROVIDER,
        cursor: MANY_CURSOR_MODELS,
      },
    });

    try {
      await page.getByRole("button").click();
      await page.getByPlaceholder("Search models or providers").fill("Anthropic");

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("Claude Cursor 2");
      });

      await expect
        .element(page.getByRole("menuitemradio", { name: "Claude Cursor 2" }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("menuitemradio", { name: "GPT Cursor 1" }))
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows favourited Cursor models in their own top category", async () => {
    const mounted = await mountPicker({
      provider: "cursor",
      model: "cursor-claude-favorite-sort",
      lockedProvider: "cursor",
      modelOptionsByProvider: {
        ...MODEL_OPTIONS_BY_PROVIDER,
        cursor: CURSOR_FAVORITE_SORT_MODELS,
      },
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text.indexOf("Anthropic")).toBeLessThan(text.indexOf("OpenAI"));
      });

      await page
        .getByRole("button", { name: "Add GPT Cursor Favorite Sort to favourites" })
        .click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text.indexOf("Favourites")).toBeLessThan(text.indexOf("Anthropic"));
        expect(text.indexOf("GPT Cursor Favorite Sort")).toBeGreaterThan(
          text.indexOf("Favourites"),
        );
        expect(text.indexOf("GPT Cursor Favorite Sort")).toBeLessThan(text.indexOf("Anthropic"));
      });
      await expect
        .element(page.getByRole("menuitemradio", { name: "GPT Cursor Favorite Sort" }))
        .toBeInTheDocument();
      expect(
        Array.from(document.querySelectorAll('[role="menuitemradio"]')).filter((element) =>
          element.textContent?.includes("GPT Cursor Favorite Sort"),
        ),
      ).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows favourited Pi models in their own top category", async () => {
    const mounted = await mountPicker({
      provider: "pi",
      model: "anthropic/claude-pi-favorite-sort",
      lockedProvider: "pi",
      modelOptionsByProvider: {
        ...MODEL_OPTIONS_BY_PROVIDER,
        pi: PI_FAVORITE_SORT_MODELS,
      },
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text.indexOf("Anthropic")).toBeLessThan(text.indexOf("OpenAI"));
      });

      await page.getByRole("button", { name: "Add GPT Pi Favorite Sort to favourites" }).click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text.indexOf("Favourites")).toBeLessThan(text.indexOf("Anthropic"));
        expect(text.indexOf("GPT Pi Favorite Sort")).toBeGreaterThan(text.indexOf("Favourites"));
        expect(text.indexOf("GPT Pi Favorite Sort")).toBeLessThan(text.indexOf("Anthropic"));
      });
      await expect
        .element(page.getByRole("menuitemradio", { name: "GPT Pi Favorite Sort" }))
        .toBeInTheDocument();
      expect(
        Array.from(document.querySelectorAll('[role="menuitemradio"]')).filter((element) =>
          element.textContent?.includes("GPT Pi Favorite Sort"),
        ),
      ).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a loading skeleton instead of fallback models for loading providers", async () => {
    const mounted = await mountPicker({
      provider: "cursor",
      model: "auto",
      lockedProvider: "cursor",
      loadingModelProviders: { cursor: true },
    });

    try {
      await page.getByRole("button").click();

      await expect.element(page.getByLabelText("Loading models")).toBeInTheDocument();
      await expect
        .element(page.getByRole("menuitemradio", { name: "Auto" }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole("menuitemradio", { name: "Composer 2" }))
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows unavailable providers as disabled rows", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: null,
      providers: [
        providerStatus("codex"),
        providerStatus("claudeAgent", {
          status: "error",
          available: false,
          authStatus: "unauthenticated",
        }),
      ],
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Codex");
        expect(text).toContain("Claude");
        expect(text).toContain("Sign in");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not make providers selectable before live status is known", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: null,
      providers: [providerStatus("codex")],
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Claude");
        expect(text).toContain("Checking");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows unsupported provider instances as missing-driver rows", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: null,
      providers: [
        providerStatus("codex"),
        providerStatus("codex", {
          provider: "codex",
          instanceId: "fork_work",
          driver: "customFork",
          displayName: "Fork Work",
          status: "error",
          available: false,
          availability: "unavailable",
          unavailableReason: "Provider driver 'customFork' is not supported by this Synara build.",
          authStatus: "unknown",
        }),
      ],
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Fork Work");
        expect(text).toContain("Missing driver");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps warning providers selectable when they are still available", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: null,
      providers: [
        providerStatus("codex"),
        providerStatus("claudeAgent", {
          status: "warning",
          available: true,
          authStatus: "unknown",
          message: "Could not verify auth status.",
        }),
      ],
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("Claude");
      });

      await expect.element(page.getByText("Sign in")).not.toBeInTheDocument();
      await expect.element(page.getByText("Unavailable")).not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });
});

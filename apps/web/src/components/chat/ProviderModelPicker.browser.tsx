import { waitForTransientPopups } from "../../lib/browserPopupCleanup";
import {
  type ModelSlug,
  type ProviderInstanceId,
  type ProviderKind,
  type ServerProviderStatus,
} from "@synara/contracts";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  ProviderModelPicker,
  type ProviderModelOptionsByProviderInstance,
  type ProviderModelPickerInstance,
} from "./ProviderModelPicker";
import { mergeDynamicModelOptions, type ProviderModelOption } from "../../providerModelOptions";
import { FAVORITE_MODEL_STORAGE_KEYS } from "../../lib/modelFavorites";
import { appHistory } from "../../appNavigation";

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
  grok: [
    { slug: "grok-build-0.1", name: "Grok Build 0.1" },
    { slug: "grok-build", name: "Grok 4.3" },
  ],
  droid: [
    {
      slug: "gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      description: "0.4x Factory token rate",
    },
    { slug: "custom:GPT-5.6-Luna-0", name: "Custom GPT-5.6 Luna" },
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
  devin: [
    {
      slug: "devin/swe-1.7",
      name: "SWE 1.7",
      upstreamProviderId: "devin",
      upstreamProviderName: "Devin",
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
  omp: [],
  antigravity: [
    {
      slug: "Gemini 3.5 Flash",
      name: "Gemini 3.5 Flash",
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

const OPENCODE_DUPLICATE_NAME_MODELS = [
  {
    slug: "deepseek/deepseek-v4-flash" as ModelSlug,
    name: "DeepSeek V4 Flash",
    upstreamProviderId: "deepseek",
    upstreamProviderName: "DeepSeek",
  },
  {
    slug: "opencode-go/deepseek-v4-flash" as ModelSlug,
    name: "DeepSeek V4 Flash",
    upstreamProviderId: "opencode-go",
    upstreamProviderName: "OpenCode Go",
  },
] satisfies ReadonlyArray<ProviderModelOption & { slug: ModelSlug }>;

const PI_BRANDED_MODELS = mergeDynamicModelOptions({
  provider: "pi",
  staticOptions: [],
  dynamicModels: [
    {
      slug: "zai/glm-5.3-flash",
      name: "GLM-5.3-Flash",
      upstreamProviderId: "zai",
      upstreamProviderName: "Z.AI",
    },
    {
      slug: "deepseek/deepseek-v4-flash",
      name: "Deepseek V4 Flash",
      upstreamProviderId: "deepseek",
      upstreamProviderName: "DeepSeek",
    },
  ],
}) satisfies ReadonlyArray<ProviderModelOption & { slug: ModelSlug }>;

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
  providerInstances?: ReadonlyArray<ProviderModelPickerInstance>;
  selectedProviderInstanceId?: ProviderInstanceId;
  showProviderInstanceChoices?: boolean;
  modelOptionsByProviderInstance?: ProviderModelOptionsByProviderInstance;
  loadingModelProviders?: Partial<Record<ProviderKind, boolean>>;
  onSelectionCommitted?: () => void;
  withRoleSelect?: boolean;
  modelOptionsByProvider?: Record<
    ProviderKind,
    ReadonlyArray<ProviderModelOption & { slug: ModelSlug }>
  >;
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const onProviderModelChange = vi.fn();
  const onProviderModelRoleSelect = vi.fn();
  const screen = await render(
    <ProviderModelPicker
      provider={props.provider}
      model={props.model}
      lockedProvider={props.lockedProvider}
      modelOptionsByProvider={props.modelOptionsByProvider ?? MODEL_OPTIONS_BY_PROVIDER}
      {...(props.providerInstances ? { providerInstances: props.providerInstances } : {})}
      {...(props.selectedProviderInstanceId
        ? { selectedProviderInstanceId: props.selectedProviderInstanceId }
        : {})}
      {...(props.showProviderInstanceChoices !== undefined
        ? { showProviderInstanceChoices: props.showProviderInstanceChoices }
        : {})}
      {...(props.modelOptionsByProviderInstance
        ? { modelOptionsByProviderInstance: props.modelOptionsByProviderInstance }
        : {})}
      {...(props.loadingModelProviders
        ? { loadingModelProviders: props.loadingModelProviders }
        : {})}
      {...(props.providers ? { providers: props.providers } : {})}
      {...(props.onSelectionCommitted ? { onSelectionCommitted: props.onSelectionCommitted } : {})}
      {...(props.withRoleSelect ? { onProviderModelRoleSelect } : undefined)}
      onProviderModelChange={onProviderModelChange}
    />,
    { container: host },
  );

  return {
    onProviderModelChange,
    onProviderModelRoleSelect,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("ProviderModelPicker", () => {
  afterEach(async () => {
    await waitForTransientPopups();
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("shows provider submenus when provider switching is allowed", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
      providers: [providerStatus("codex"), providerStatus("claudeAgent")],
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

  it("lists each account of a provider as its own named entry", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: null,
      selectedProviderInstanceId: "codex_work",
      providerInstances: [
        { instanceId: "codex", provider: "codex", label: "Codex", enabled: true, isDefault: true },
        {
          instanceId: "codex_work",
          provider: "codex",
          label: "Work",
          accentColor: "#16a34a",
          enabled: true,
          isDefault: false,
        },
        {
          instanceId: "codex_side",
          provider: "codex",
          label: "Side",
          enabled: true,
          isDefault: false,
        },
        {
          instanceId: "codex_old",
          provider: "codex",
          label: "Old",
          enabled: false,
          isDefault: false,
        },
      ],
      providers: [
        providerStatus("codex"),
        providerStatus("codex", { instanceId: "codex_work", displayName: "Work" }),
        providerStatus("codex", {
          instanceId: "codex_side",
          displayName: "Side",
          authStatus: "unauthenticated",
        }),
      ],
      modelOptionsByProviderInstance: {
        codex_work: [
          { slug: "gpt-5-codex", name: "GPT-5 Codex" },
          { slug: "gpt-5-work-codex", name: "GPT-5 Work Codex" },
        ],
      },
    });

    try {
      // The trigger names the account the selection runs in.
      const trigger = page.getByRole("button").element();
      expect(trigger.textContent).toContain("Work · GPT-5 Codex");
      expect(trigger.querySelector<HTMLElement>("[data-accent]")?.dataset.accent).toBe("#16a34a");

      await page.getByRole("button").click();
      await expect
        .element(page.getByRole("menuitem", { name: "Codex", exact: true }))
        .toBeVisible();
      const signedOut = page.getByRole("menuitem", { name: /Codex · Side/ });
      await expect.element(signedOut).not.toHaveAttribute("aria-disabled", "true");
      expect(signedOut.element().textContent).toContain("Sign in");
      expect(document.body.textContent ?? "").not.toContain("Old");

      await page.getByRole("menuitem", { name: /Codex · Work/ }).click();
      await expect
        .element(page.getByRole("menuitemradio", { name: "GPT-5 Codex" }))
        .toHaveAttribute("aria-checked", "true");
      await page.getByRole("menuitemradio", { name: "GPT-5 Work Codex" }).click();

      expect(mounted.onProviderModelChange).toHaveBeenCalledWith(
        "codex",
        "gpt-5-work-codex",
        "codex_work",
      );
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
        providerStatus("codex"),
        providerStatus("codex", { instanceId: "codex_work", displayName: "Work" }),
      ],
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
        providerStatus("codex", { instanceId: "codex_work", displayName: "Work" }),
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
        providerStatus("codex"),
        providerStatus("codex", { instanceId: "codex_work", displayName: "Work" }),
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

  it("hides disabled provider models even when an existing thread is locked to it", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: "codex",
      providers: [providerStatus("codex", { enabled: false, available: false })],
    });
    try {
      await page.getByRole("button").click();
      expect(
        page.getByRole("menuitemradio", { name: "GPT-5 Codex", exact: true }).elements(),
      ).toHaveLength(0);
      expect(
        page.getByRole("menuitemradio", { name: "GPT-5.3 Codex", exact: true }).elements(),
      ).toHaveLength(0);
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

  it("dispatches the role model and thinking level through onProviderModelRoleSelect", async () => {
    const mounted = await mountPicker({
      provider: "omp",
      model: "deepseek/deepseek-v4-flash",
      lockedProvider: "omp",
      withRoleSelect: true,
      modelOptionsByProvider: {
        ...MODEL_OPTIONS_BY_PROVIDER,
        omp: [
          {
            slug: "role:dreaming-proposer",
            name: "Dreaming Proposer",
            upstreamProviderId: "roles",
            upstreamProviderName: "Roles",
            role: {
              name: "Dreaming Proposer",
              model: "anthropic/claude-opus-4-6",
              thinkingLevel: "high",
            },
          },
          {
            slug: "deepseek/deepseek-v4-flash",
            name: "DeepSeek V4 Flash",
            upstreamProviderId: "deepseek",
            upstreamProviderName: "DeepSeek",
          },
        ],
      },
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("menuitemradio", { name: "Dreaming Proposer" }).click();

      // The role is committed for the account whose list it was picked from.
      expect(mounted.onProviderModelRoleSelect).toHaveBeenCalledWith(
        "anthropic/claude-opus-4-6",
        { thinkingLevel: "high" },
        "omp",
      );
      expect(mounted.onProviderModelChange).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("commits the role's model via onProviderModelChange when no role callback exists", async () => {
    const mounted = await mountPicker({
      provider: "omp",
      model: "deepseek/deepseek-v4-flash",
      lockedProvider: "omp",
      modelOptionsByProvider: {
        ...MODEL_OPTIONS_BY_PROVIDER,
        omp: [
          {
            slug: "role:dreaming-proposer",
            name: "Dreaming Proposer",
            upstreamProviderId: "roles",
            upstreamProviderName: "Roles",
            role: {
              name: "Dreaming Proposer",
              model: "anthropic/claude-opus-4-6",
              thinkingLevel: "high",
            },
          },
          {
            slug: "deepseek/deepseek-v4-flash",
            name: "DeepSeek V4 Flash",
            upstreamProviderId: "deepseek",
            upstreamProviderName: "DeepSeek",
          },
        ],
      },
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("menuitemradio", { name: "Dreaming Proposer" }).click();

      expect(mounted.onProviderModelChange).toHaveBeenCalledWith(
        "omp",
        "anthropic/claude-opus-4-6",
        "omp",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps branded Pi model labels stable after selection", async () => {
    const host = document.createElement("div");
    document.body.append(host);

    function ControlledPiPicker() {
      const [model, setModel] = useState<ModelSlug>("deepseek/deepseek-v4-flash");
      return (
        <ProviderModelPicker
          provider="pi"
          model={model}
          lockedProvider="pi"
          modelOptionsByProvider={{
            ...MODEL_OPTIONS_BY_PROVIDER,
            pi: PI_BRANDED_MODELS,
          }}
          onProviderModelChange={(_provider, nextModel) => setModel(nextModel)}
        />
      );
    }

    const screen = await render(<ControlledPiPicker />, { container: host });
    try {
      await expect.element(page.getByRole("button", { name: /DeepSeek V4 Flash/u })).toBeVisible();
      await page.getByRole("button", { name: /DeepSeek V4 Flash/u }).click();
      await page.getByRole("menuitemradio", { name: "GLM 5.3 Flash" }).click();

      await expect.element(page.getByRole("button", { name: /GLM 5.3 Flash/u })).toBeVisible();
      expect(document.body.textContent ?? "").not.toContain("Glm 5.3 Flash");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("shows live Droid cost multipliers without adding one to BYOK models", async () => {
    const mounted = await mountPicker({
      provider: "droid",
      model: "gpt-5.6-luna",
      lockedProvider: "droid",
    });

    try {
      await page.getByRole("button").click();

      const rows = Array.from(document.querySelectorAll('[role="menuitemradio"]'));
      const pricedRow = rows.find((row) => row.textContent?.includes("GPT-5.6 Luna"));
      const byokRow = rows.find((row) => row.textContent?.includes("Custom GPT-5.6 Luna"));

      expect(pricedRow?.textContent).toContain("0.4×");
      expect(pricedRow?.querySelector('[title="0.4x Factory token rate"]')).not.toBeNull();
      expect(byokRow?.textContent).not.toContain("×");
      await expect
        .element(
          page.getByRole("menuitemradio", {
            name: "GPT-5.6 Luna 0.4x Factory token rate",
          }),
        )
        .toBeInTheDocument();
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
        .element(page.getByRole("menuitemradio", { name: "GPT Favorite Sort — OpenAI" }))
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

  it("distinguishes same-name favourite models by their upstream provider", async () => {
    localStorage.setItem(
      FAVORITE_MODEL_STORAGE_KEYS.opencode,
      JSON.stringify(OPENCODE_DUPLICATE_NAME_MODELS.map((model) => model.slug)),
    );
    const mounted = await mountPicker({
      provider: "opencode",
      model: OPENCODE_DUPLICATE_NAME_MODELS[0]!.slug,
      lockedProvider: "opencode",
      modelOptionsByProvider: {
        ...MODEL_OPTIONS_BY_PROVIDER,
        opencode: OPENCODE_DUPLICATE_NAME_MODELS,
      },
    });

    try {
      await page.getByRole("button").click();

      await expect
        .element(page.getByRole("menuitemradio", { name: "DeepSeek V4 Flash — DeepSeek" }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("menuitemradio", { name: "DeepSeek V4 Flash — OpenCode Go" }))
        .toBeInTheDocument();
      await expect
        .element(
          page.getByRole("button", {
            name: "Remove DeepSeek V4 Flash — DeepSeek from favourites",
          }),
        )
        .toBeInTheDocument();
      await expect
        .element(
          page.getByRole("button", {
            name: "Remove DeepSeek V4 Flash — OpenCode Go from favourites",
          }),
        )
        .toBeInTheDocument();
      expect(
        Array.from(document.querySelectorAll('[role="menuitemradio"]')).map(
          (element) => element.textContent,
        ),
      ).toEqual(["DeepSeek V4 FlashDeepSeek", "DeepSeek V4 FlashOpenCode Go"]);
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

  it("hides unavailable providers and offers provider settings", async () => {
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
        expect(text).not.toContain("Claude");
        expect(text).not.toContain("Sign in");
      });
      await expect.element(page.getByRole("menuitem", { name: "Add Providers" })).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens provider settings when an installed provider needs sign-in", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: null,
      providers: [
        providerStatus("codex"),
        providerStatus("antigravity", {
          status: "error",
          available: true,
          authStatus: "unauthenticated",
        }),
      ],
    });
    const pushSpy = vi.spyOn(appHistory, "push").mockImplementation(() => undefined);

    try {
      await page.getByRole("button").click();
      const signIn = page.getByRole("menuitem", { name: /Antigravity/ });
      await expect.element(signIn).toBeVisible();
      await expect.element(signIn).not.toHaveAttribute("aria-disabled", "true");
      expect(signIn.element().textContent).toContain("Sign in");

      await signIn.click();
      expect(pushSpy).toHaveBeenCalledWith("/settings?section=providers");
    } finally {
      pushSpy.mockRestore();
      await mounted.cleanup();
    }
  });

  it("hides providers before live status is known", async () => {
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
        expect(text).not.toContain("Claude");
        expect(text).not.toContain("Checking");
      });
      await expect.element(page.getByRole("menuitem", { name: "Add Providers" })).toBeVisible();
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

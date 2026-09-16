import "../../index.css";

import {
  type CodexModelOptions,
  type ModelSlug,
  type ProviderKind,
  type ServerProviderStatus,
  ThreadId,
} from "@synara/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  COMPOSER_DRAFT_STORAGE_KEY,
  type ComposerThreadDraftState,
  useComposerDraftStore,
  useComposerThreadDraft,
  useEffectiveComposerModelState,
} from "../../composerDraftStore";
import { type ProviderModelOption } from "../../providerModelOptions";
import { buildModelSelection, buildNextProviderOptions } from "../../providerModelOptions";
import {
  COMPOSER_MODEL_PRESETS_STORAGE_KEY,
  type ComposerModelPreset,
} from "../../lib/composerModelPresets";
import { FAVORITE_MODEL_STORAGE_KEYS } from "../../lib/modelFavorites";
import { commitAfterRuntimeModePersistence } from "../ChatView.logic";
import { ComposerModelEffortPicker, type ComposerEffortControl } from "./ComposerModelEffortPicker";
import { planComposerModelPreset } from "./composerModelPresetSelection";

const THREAD_ID = ThreadId.makeUnsafe("thread-grok-model-effort-picker");
const GROK_4_6 = "grok-4.6" as ModelSlug;

const EMPTY_MODEL_OPTIONS_BY_PROVIDER: Record<ProviderKind, ReadonlyArray<ProviderModelOption>> = {
  claudeAgent: [],
  codex: [],
  cursor: [],
  devin: [],
  cline: [],
  antigravity: [],
  grok: [],
  droid: [],
  opencode: [],
  pi: [],
};

const EMPTY_CUSTOM_MODELS_BY_PROVIDER: Record<ProviderKind, never[]> = {
  claudeAgent: [],
  codex: [],
  cursor: [],
  devin: [],
  cline: [],
  antigravity: [],
  grok: [],
  droid: [],
  opencode: [],
  pi: [],
};

// ── Slider layout (store-backed) ──────────────────────────────────────

const CODEX_THREAD_ID = ThreadId.makeUnsafe("thread-codex-effort-slider");
const GPT_5_5 = "gpt-5.5" as ModelSlug;
const GPT_5_4 = "gpt-5.4" as ModelSlug;

const CODEX_PROVIDER_STATUS: ServerProviderStatus = {
  provider: "codex",
  status: "ready",
  available: true,
  authStatus: "authenticated",
  checkedAt: "2026-04-10T10:00:00.000Z",
};

type CodexSliderHarnessProps = {
  // Unlocked providers add the provider page before the model list.
  lockedProvider?: ProviderKind | null;
  onProviderModelChange?: (
    provider: ProviderKind,
    model: ModelSlug,
    preset?: ComposerModelPreset,
  ) => void;
  persistRuntimeMode?: () => Promise<boolean>;
  effortControl?: ComposerEffortControl;
  providers?: ReadonlyArray<ServerProviderStatus>;
  modelOptionsByProvider?: Record<ProviderKind, ReadonlyArray<ProviderModelOption>>;
  loadingModelProviders?: Partial<Record<ProviderKind, boolean>>;
};

const HARNESS_MODEL_OPTIONS = {
  ...EMPTY_MODEL_OPTIONS_BY_PROVIDER,
  codex: [
    { slug: GPT_5_5, name: "GPT-5.5" },
    { slug: GPT_5_4, name: "GPT-5.4" },
  ],
  claudeAgent: [{ slug: "claude-opus-5", name: "Opus 5" }],
};

function CodexSliderHarness(props: CodexSliderHarnessProps) {
  const lockedProvider = props.lockedProvider === undefined ? "codex" : props.lockedProvider;
  const prompt = useComposerThreadDraft(CODEX_THREAD_ID).prompt;
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const { modelOptions, selectedModel } = useEffectiveComposerModelState({
    threadId: CODEX_THREAD_ID,
    selectedProvider: "codex",
    threadModelSelection: null,
    projectModelSelection: null,
    customModelsByProvider: EMPTY_CUSTOM_MODELS_BY_PROVIDER,
  });
  return (
    <ComposerModelEffortPicker
      provider="codex"
      model={(selectedModel ?? GPT_5_5) as ModelSlug}
      // Started threads pin their provider and skip the provider browsing page.
      lockedProvider={lockedProvider}
      providers={
        props.providers ?? [
          CODEX_PROVIDER_STATUS,
          { ...CODEX_PROVIDER_STATUS, provider: "claudeAgent" },
        ]
      }
      modelOptionsByProvider={props.modelOptionsByProvider ?? HARNESS_MODEL_OPTIONS}
      {...(props.loadingModelProviders
        ? { loadingModelProviders: props.loadingModelProviders }
        : {})}
      effortControl={props.effortControl ?? "slider"}
      onProviderModelChange={async (provider, model, preset) => {
        if (props.onProviderModelChange) {
          if (preset) props.onProviderModelChange(provider, model, preset);
          else props.onProviderModelChange(provider, model);
          return true;
        }
        const plan = preset
          ? planComposerModelPreset({
              preset,
              lockedProvider,
              availableModels: (props.modelOptionsByProvider ?? HARNESS_MODEL_OPTIONS)[provider],
              providerAvailable: true,
              prompt,
            })
          : null;
        if (plan?.kind === "unavailable") return false;
        return commitAfterRuntimeModePersistence({
          currentRuntimeMode: props.persistRuntimeMode ? "auto" : "approval-required",
          nextRuntimeMode: "approval-required",
          persistRuntimeMode: props.persistRuntimeMode ?? (async () => true),
          commit: () => {
            useComposerDraftStore
              .getState()
              .setModelSelectionAndSticky(
                CODEX_THREAD_ID,
                buildModelSelection(
                  provider,
                  model,
                  plan?.kind === "ready" && plan.patch
                    ? buildNextProviderOptions(provider, modelOptions?.[provider], plan.patch)
                    : undefined,
                ),
              );
            if (plan?.kind === "ready" && plan.prompt !== undefined)
              setPrompt(CODEX_THREAD_ID, plan.prompt);
          },
        });
      }}
      threadId={CODEX_THREAD_ID}
      modelOptions={modelOptions?.codex}
      prompt={prompt}
      onPromptChange={(next) => setPrompt(CODEX_THREAD_ID, next)}
    />
  );
}

async function mountCodexSlider(
  options?: CodexModelOptions,
  harnessProps: CodexSliderHarnessProps = {},
  anchorSide?: "left" | "right",
) {
  const draftsByThreadId: Record<ThreadId, ComposerThreadDraftState> = {
    [CODEX_THREAD_ID]: {
      prompt: "",
      promptHistorySavedDraft: null,
      images: [],
      files: [],
      nonPersistedImageIds: [],
      persistedAttachments: [],
      assistantSelections: [],
      browserAnnotations: [],
      terminalContexts: [],
      fileComments: [],
      pastedTexts: [],
      pullRequestContexts: [],
      skills: [],
      mentions: [],
      queuedTurns: [],
      modelSelectionByProvider: {
        codex: {
          provider: "codex",
          model: GPT_5_5,
          ...(options ? { options } : {}),
        },
      },
      activeProvider: "codex",
      runtimeMode: null,
      interactionMode: null,
    },
  };
  useComposerDraftStore.setState({
    draftsByThreadId,
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
  });
  const screen = await render(
    <div style={anchorSide ? { position: "fixed", bottom: 36, [anchorSide]: 24 } : undefined}>
      <CodexSliderHarness {...harnessProps} />
    </div>,
  );
  return {
    cleanup: async () => {
      await screen.unmount();
    },
  };
}

describe("ComposerModelEffortPicker (effort slider)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
    localStorage.removeItem(COMPOSER_MODEL_PRESETS_STORAGE_KEY);
    localStorage.removeItem(FAVORITE_MODEL_STORAGE_KEYS.codex);
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
    });
  });

  it("renders the effort ladder as a slider and commits keyboard steps", async () => {
    const { cleanup } = await mountCodexSlider({ reasoningEffort: "medium" });
    try {
      await page.getByRole("button", { name: "Change model and reasoning" }).click();

      const slider = page.getByRole("slider", { name: "Reasoning effort" });
      await expect.element(slider).toHaveAttribute("aria-valuetext", "Medium");
      // Base UI backs the thumb with a native range input: one stop per effort level.
      await expect.element(slider).toHaveAttribute("max", "3");
      // Radio rows are gone: the slider owns the ladder.
      expect(document.body.querySelector('[role="menuitemradio"]')).toBeNull();

      await slider.element().focus();
      await userEvent.keyboard("{ArrowRight}");

      await expect.element(slider).toHaveAttribute("aria-valuetext", "High");
      expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex).toMatchObject({
        provider: "codex",
        options: { reasoningEffort: "high" },
      });
      // The stacked label follows the thumb and the menu stays open.
      await expect.element(page.getByRole("menuitem", { name: /^High/u })).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  it("toggles fast mode and resets both controls from the card", async () => {
    const { cleanup } = await mountCodexSlider({ reasoningEffort: "xhigh" });
    try {
      await page.getByRole("button", { name: "Change model and reasoning" }).click();

      const fastToggle = page.getByRole("button", { name: "Fast mode" });
      await expect.element(fastToggle).toHaveAttribute("aria-pressed", "false");
      await fastToggle.click();
      await expect.element(fastToggle).toHaveAttribute("aria-pressed", "true");

      const reset = page.getByRole("button", { name: "Reset effort and speed" });
      await reset.click();

      const slider = page.getByRole("slider", { name: "Reasoning effort" });
      await expect.element(slider).toHaveAttribute("aria-valuetext", "Medium");
      await expect.element(fastToggle).toHaveAttribute("aria-pressed", "false");
      await expect.element(reset).toBeDisabled();
    } finally {
      await cleanup();
    }
  });

  it("opens the model list from the stacked effort/model label", async () => {
    const { cleanup } = await mountCodexSlider(undefined);
    try {
      await page.getByRole("button", { name: "Change model and reasoning" }).click();
      // The stacked "effort / model" label opens the model page in the same popup.
      await page.getByRole("menuitem", { name: /GPT-5\.5/u }).click();

      await expect.element(page.getByRole("menuitemradio", { name: "GPT-5.5" })).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  it("keeps the slider open after picking a model so effort can be adjusted", async () => {
    const onProviderModelChange = vi.fn();
    const { cleanup } = await mountCodexSlider(undefined, { onProviderModelChange });
    try {
      await page.getByRole("button", { name: "Change model and reasoning" }).click();
      await page.getByRole("menuitem", { name: /GPT-5\.5/u }).click();
      await page.getByRole("menuitemradio", { name: "GPT-5.4" }).click();

      expect(onProviderModelChange).toHaveBeenCalledWith("codex", GPT_5_4);
      // The popup returns to the card with the slider ready to use.
      await vi.waitFor(() => {
        expect(document.body.querySelector('[role="menuitemradio"]')).toBeNull();
      });
      await expect.element(page.getByRole("slider", { name: "Reasoning effort" })).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  it("returns from provider browsing to configuration when a model is picked", async () => {
    const onProviderModelChange = vi.fn();
    const { cleanup } = await mountCodexSlider(undefined, {
      lockedProvider: null,
      onProviderModelChange,
    });
    try {
      await page.getByRole("button", { name: "Change model and reasoning" }).click();
      await page.getByRole("menuitem", { name: /GPT-5\.5/u }).click();
      await page.getByRole("menuitem", { name: "Codex" }).click();
      await page.getByRole("menuitemradio", { name: "GPT-5.4" }).click();

      expect(onProviderModelChange).toHaveBeenCalledWith("codex", GPT_5_4);
      await vi.waitFor(() => {
        expect(document.body.querySelector('[role="menuitemradio"]')).toBeNull();
        expect(document.body.textContent ?? "").not.toContain("Add Providers");
      });
      await expect.element(page.getByRole("slider", { name: "Reasoning effort" })).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  it.each([
    { width: 800, side: "right" },
    { width: 800, side: "left" },
    { width: 320, side: "right" },
  ] as const)(
    "keeps catalog navigation in one panel at the $side edge of a $width px viewport",
    async ({ width, side }) => {
      const originalViewport = { width: window.innerWidth, height: window.innerHeight };
      await page.viewport(width, 480);
      const onProviderModelChange = vi.fn();
      const { cleanup } = await mountCodexSlider(
        { reasoningEffort: "xhigh" },
        { lockedProvider: null, onProviderModelChange },
        side,
      );
      const expectSinglePanel = async (expectedWidth: number) => {
        await vi.waitFor(() => {
          const menus = document.querySelectorAll('[role="menu"]');
          expect(menus).toHaveLength(1);
          const bounds = menus[0]!.getBoundingClientRect();
          expect(bounds.width).toBe(expectedWidth);
          expect(bounds.left).toBeGreaterThanOrEqual(0);
          expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
          expect(bounds.top).toBeGreaterThanOrEqual(0);
          expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
        });
      };
      try {
        const trigger = page.getByRole("button", { name: "Change model and reasoning" });
        await trigger.click();
        await expectSinglePanel(256);
        await page.getByRole("menuitem", { name: "Extra High GPT-5.5", exact: true }).click();
        await expectSinglePanel(200);
        await page.getByRole("menuitem", { name: "Claude", exact: true }).click();
        await expectSinglePanel(256);
        await expect.element(page.getByRole("menuitemradio", { name: "Opus 5" })).toBeVisible();
        expect(onProviderModelChange).not.toHaveBeenCalled();
        await page.getByRole("menuitemradio", { name: "Opus 5" }).click();
        expect(onProviderModelChange).toHaveBeenCalledExactlyOnceWith(
          "claudeAgent",
          "claude-opus-5",
        );
        await expect.element(page.getByRole("slider", { name: "Reasoning effort" })).toBeVisible();
        await expectSinglePanel(256);
        await userEvent.keyboard("{Escape}");
        await expect.element(trigger).toHaveFocus();
      } finally {
        await cleanup();
        await page.viewport(originalViewport.width, originalViewport.height);
      }
    },
    15_000,
  );

  it.each([
    { lockedProvider: null, effortControl: "slider" },
    { lockedProvider: "codex", effortControl: "slider" },
    { lockedProvider: null, effortControl: "menu" },
    { lockedProvider: "codex", effortControl: "menu" },
  ] as const)(
    "preserves keyboard navigation and favourites with $effortControl controls and lock $lockedProvider",
    async ({ lockedProvider, effortControl }) => {
      const onProviderModelChange = vi.fn();
      const { cleanup } = await mountCodexSlider(undefined, {
        lockedProvider,
        effortControl,
        onProviderModelChange,
      });
      try {
        const trigger = page.getByRole("button", { name: "Change model and reasoning" });
        trigger.element().focus();
        await userEvent.keyboard("{Enter}");
        if (effortControl === "slider") {
          await expect
            .element(page.getByRole("button", { name: "Save GPT-5.5 · Medium as preset" }))
            .toHaveFocus();
          await userEvent.keyboard("{Tab}{Tab}");
        } else {
          await userEvent.keyboard("{End}");
        }
        const browse = page.getByRole("menuitem", {
          name: effortControl === "slider" ? "Medium GPT-5.5" : "GPT-5.5",
          exact: true,
        });
        await expect.element(browse).toHaveFocus();
        await userEvent.keyboard("{ArrowRight}");
        if (lockedProvider === null) {
          await expect
            .element(page.getByRole("menuitem", { name: "Codex", exact: true }))
            .toHaveFocus();
          await userEvent.keyboard("{ArrowDown}");
          await expect
            .element(page.getByRole("menuitem", { name: "Claude", exact: true }))
            .toHaveFocus();
          await userEvent.keyboard("{ArrowRight}");
          await expect
            .element(page.getByRole("menuitemradio", { name: "Opus 5", exact: true }))
            .toHaveFocus();
          await userEvent.keyboard("{Escape}");
          await expect
            .element(page.getByRole("menuitem", { name: "Claude", exact: true }))
            .toHaveFocus();
          await userEvent.keyboard("{ArrowUp}");
          await expect
            .element(page.getByRole("menuitem", { name: "Codex", exact: true }))
            .toHaveFocus();
          await userEvent.keyboard("{ArrowRight}");
        } else {
          await expect
            .element(page.getByRole("menuitem", { name: "Claude", exact: true }))
            .not.toBeInTheDocument();
        }
        await expect
          .element(page.getByRole("menuitemradio", { name: "GPT-5.5", exact: true }))
          .toHaveFocus();
        await userEvent.keyboard("{Tab}");
        await expect
          .element(page.getByRole("button", { name: "Add GPT-5.5 to favourites" }))
          .toHaveFocus();
        await userEvent.keyboard("{Enter}");
        await expect
          .element(page.getByRole("button", { name: "Remove GPT-5.5 from favourites" }))
          .toHaveFocus();
        expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
        expect(onProviderModelChange).not.toHaveBeenCalled();
        await userEvent.keyboard("{Escape}");
        if (lockedProvider === null) {
          await expect
            .element(page.getByRole("menuitem", { name: "Codex", exact: true }))
            .toHaveFocus();
          await userEvent.keyboard("{ArrowLeft}");
        }
        await expect.element(browse).toHaveFocus();
        await userEvent.keyboard("{Escape}");
        await expect.element(trigger).toHaveFocus();
        await userEvent.keyboard("{Enter}");
        await expect
          .element(page.getByRole("button", { name: "Save GPT-5.5 · Medium as preset" }))
          .toBeVisible();
      } finally {
        await cleanup();
      }
    },
    15_000,
  );

  it("keeps search and Back in the same narrow catalog without changing selection", async () => {
    const originalViewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(320, 480);
    const onProviderModelChange = vi.fn();
    const { cleanup } = await mountCodexSlider(
      undefined,
      {
        lockedProvider: null,
        onProviderModelChange,
        providers: [CODEX_PROVIDER_STATUS, { ...CODEX_PROVIDER_STATUS, provider: "cline" }],
        modelOptionsByProvider: {
          ...HARNESS_MODEL_OPTIONS,
          cline: Array.from({ length: 20 }, (_, index) => ({
            slug: `long-model-${index}`,
            name: `A very long model display name ${index}`,
          })),
        },
      },
      "right",
    );
    try {
      await page.getByRole("button", { name: "Change model and reasoning" }).click();
      await page.getByRole("menuitem", { name: "Medium GPT-5.5", exact: true }).click();
      await page.getByRole("menuitem", { name: "Cline", exact: true }).click();
      const search = page.getByRole("searchbox", { name: "Search models" });
      await expect.element(search).toHaveFocus();
      await userEvent.keyboard("name 17");
      await expect.element(search).toHaveValue("name 17");
      await expect
        .element(page.getByRole("menuitemradio", { name: "A very long model display name 17" }))
        .toBeVisible();
      await expect
        .element(page.getByRole("menuitemradio", { name: "A very long model display name 18" }))
        .not.toBeInTheDocument();
      await userEvent.keyboard("{ArrowLeft}");
      await expect.element(search).toHaveFocus();
      const menu = page.getByRole("menu").element();
      expect(menu.getBoundingClientRect().width).toBe(256);
      expect(menu.scrollWidth).toBeLessThanOrEqual(menu.clientWidth + 1);
      expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
      await userEvent.keyboard("{Escape}");
      await expect
        .element(page.getByRole("menuitem", { name: "Cline", exact: true }))
        .toHaveFocus();
      await page.getByRole("menuitem", { name: "Back to configuration", exact: true }).click();
      await expect
        .element(page.getByRole("menuitem", { name: "Medium GPT-5.5", exact: true }))
        .toHaveFocus();
      expect(onProviderModelChange).not.toHaveBeenCalled();
    } finally {
      await cleanup();
      await page.viewport(originalViewport.width, originalViewport.height);
    }
  }, 15_000);

  it.each([false, true])(
    "keeps Back reachable with loading models %s and an empty catalog",
    async (loading) => {
      const { cleanup } = await mountCodexSlider(undefined, {
        modelOptionsByProvider: { ...HARNESS_MODEL_OPTIONS, codex: [] },
        loadingModelProviders: { codex: loading },
      });
      try {
        await page.getByRole("button", { name: "Change model and reasoning" }).click();
        await page.getByRole("menuitem", { name: /Medium/u }).click();
        const back = page.getByRole("menuitem", { name: "Back to configuration", exact: true });
        await expect.element(back).toHaveFocus();
        await expect.element(page.getByRole("status")).toBeVisible();
        await userEvent.keyboard("{Enter}");
        await expect.element(page.getByRole("slider", { name: "Reasoning effort" })).toBeVisible();
        expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
      } finally {
        await cleanup();
      }
    },
    15_000,
  );

  it.each([null, "codex"] as const)(
    "saves, reloads and restores model + effort with provider lock %s",
    async (lockedProvider) => {
      let mounted = await mountCodexSlider(
        { reasoningEffort: "medium", fastMode: true },
        { lockedProvider },
      );
      try {
        const trigger = page.getByRole("button", { name: "Change model and reasoning" });
        await trigger.click();
        const saveMedium = page.getByRole("button", {
          name: "Save GPT-5.5 · Medium as preset",
          exact: true,
        });
        await saveMedium.element().focus();
        await userEvent.keyboard("{Enter}");
        await expect
          .element(
            page.getByRole("button", { name: "Remove GPT-5.5 · Medium preset", exact: true }),
          )
          .toHaveFocus();
        const slider = page.getByRole("slider", { name: "Reasoning effort" });
        await slider.element().focus();
        await userEvent.keyboard("{End}");
        await page.getByRole("button", { name: "Save GPT-5.5 · Extra High as preset" }).click();
        expect(
          JSON.parse(localStorage.getItem(COMPOSER_MODEL_PRESETS_STORAGE_KEY) ?? "[]"),
        ).toHaveLength(2);
        await mounted.cleanup();
        mounted = await mountCodexSlider(
          { reasoningEffort: "low", fastMode: true },
          { lockedProvider },
        );
        await trigger.click();
        await page.getByRole("menuitem", { name: /^Low GPT-5.5$/u }).click();
        if (lockedProvider === null)
          await page.getByRole("menuitem", { name: "Codex", exact: true }).click();
        await page.getByRole("menuitemradio", { name: "GPT-5.4", exact: true }).click();
        await expect.element(page.getByRole("slider", { name: "Reasoning effort" })).toBeVisible();
        await page
          .getByRole("menuitem", { name: "Apply GPT-5.5 · Extra High (Codex)", exact: true })
          .click();
        await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
        const state = useComposerDraftStore.getState();
        const selection = {
          provider: "codex",
          model: GPT_5_5,
          options: { reasoningEffort: "xhigh", fastMode: true },
        };
        expect(state.draftsByThreadId[CODEX_THREAD_ID]?.modelSelectionByProvider.codex).toEqual(
          selection,
        );
        expect(state.stickyModelSelectionByProvider.codex).toEqual(selection);
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("keeps radio effort changes open so the new configuration can be saved", async () => {
    const { cleanup } = await mountCodexSlider(
      { reasoningEffort: "medium" },
      { effortControl: "menu" },
    );
    try {
      await page.getByRole("button", { name: "Change model and reasoning" }).click();
      await page.getByRole("menuitemradio", { name: "High", exact: true }).click();
      await expect
        .element(page.getByRole("button", { name: "Save GPT-5.5 · High as preset" }))
        .toBeVisible();
      await page.getByRole("button", { name: "Save GPT-5.5 · High as preset" }).click();
      await expect
        .element(page.getByRole("menuitem", { name: "Apply GPT-5.5 · High (Codex)" }))
        .toBeVisible();
    } finally {
      await cleanup();
    }
  });

  it("reaches the save star from the menu with the keyboard and toggles it without closing", async () => {
    const { cleanup } = await mountCodexSlider({ reasoningEffort: "medium" });
    try {
      const trigger = page.getByRole("button", { name: "Change model and reasoning" });
      await trigger.element().focus();
      await userEvent.keyboard("{Enter}");
      await expect
        .element(page.getByRole("button", { name: "Save GPT-5.5 · Medium as preset" }))
        .toHaveFocus();
      await userEvent.keyboard("{Tab}");
      await expect
        .element(page.getByRole("button", { name: "Fast mode", exact: true }))
        .toHaveFocus();
      await userEvent.keyboard("{Tab}");
      await expect
        .element(page.getByRole("menuitem", { name: "Medium GPT-5.5", exact: true }))
        .toHaveFocus();
      await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
      // The fast toggle precedes the stacked model label; the save star is immediately before it.
      await expect
        .element(page.getByRole("button", { name: "Fast mode", exact: true }))
        .toHaveFocus();
      await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
      await expect
        .element(page.getByRole("button", { name: "Save GPT-5.5 · Medium as preset" }))
        .toHaveFocus();
      await userEvent.keyboard("{Enter}");
      await expect
        .element(page.getByRole("button", { name: "Remove GPT-5.5 · Medium preset", exact: true }))
        .toHaveFocus();
      await userEvent.keyboard(" ");
      await expect
        .element(page.getByRole("button", { name: "Save GPT-5.5 · Medium as preset" }))
        .toHaveFocus();
      await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
      expect(localStorage.getItem(COMPOSER_MODEL_PRESETS_STORAGE_KEY)).toBe("[]");
    } finally {
      await cleanup();
    }
  }, 15_000);

  it("keeps unavailable presets removable and returns focus to the save control", async () => {
    localStorage.setItem(
      COMPOSER_MODEL_PRESETS_STORAGE_KEY,
      JSON.stringify([
        { provider: "codex", model: "missing-model", reasoning: null },
        {
          provider: "codex",
          model: GPT_5_5,
          reasoning: {
            kind: "effort",
            optionId: "reasoningEffort",
            value: "retired",
            label: "Retired effort",
          },
        },
      ]),
    );
    const { cleanup } = await mountCodexSlider({ reasoningEffort: "medium" });
    try {
      await page.getByRole("button", { name: "Change model and reasoning" }).click();
      await expect
        .element(page.getByRole("menuitem", { name: "Apply missing-model (Codex)" }))
        .toHaveAttribute("aria-disabled", "true");
      await expect.element(page.getByText("Saved effort is no longer supported.")).toBeVisible();
      await page.getByRole("button", { name: "Remove missing-model preset (Codex)" }).click();
      await expect
        .element(page.getByRole("button", { name: "Save GPT-5.5 · Medium as preset" }))
        .toHaveFocus();
      expect(
        JSON.parse(localStorage.getItem(COMPOSER_MODEL_PRESETS_STORAGE_KEY) ?? "[]"),
      ).toHaveLength(1);
      expect(
        useComposerDraftStore.getState().draftsByThreadId[CODEX_THREAD_ID]?.modelSelectionByProvider
          .codex?.model,
      ).toBe(GPT_5_5);
    } finally {
      await cleanup();
    }
  });

  it("shows cross-provider presets only before the provider is locked", async () => {
    const preset: ComposerModelPreset = {
      provider: "claudeAgent",
      model: "claude-opus-5",
      reasoning: { kind: "effort", optionId: "effort", value: "max", label: "Max" },
    };
    localStorage.setItem(COMPOSER_MODEL_PRESETS_STORAGE_KEY, JSON.stringify([preset]));
    let mounted = await mountCodexSlider();
    try {
      await page.getByRole("button", { name: "Change model and reasoning" }).click();
      expect(document.body.textContent).not.toContain("Opus 5 · Max");
      await mounted.cleanup();
      const onProviderModelChange = vi.fn();
      mounted = await mountCodexSlider(undefined, { lockedProvider: null, onProviderModelChange });
      await page.getByRole("button", { name: "Change model and reasoning" }).click();
      await page.getByRole("menuitem", { name: /^Apply Opus 5 · Max/u }).click();
      expect(onProviderModelChange).toHaveBeenCalledExactlyOnceWith(
        "claudeAgent",
        "claude-opus-5",
        preset,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not partially apply a preset while runtime-mode persistence is pending or fails", async () => {
    const preset: ComposerModelPreset = {
      provider: "codex",
      model: GPT_5_4,
      reasoning: {
        kind: "effort",
        optionId: "reasoningEffort",
        value: "xhigh",
        label: "Extra High",
      },
    };
    localStorage.setItem(COMPOSER_MODEL_PRESETS_STORAGE_KEY, JSON.stringify([preset]));
    let resolvePersistence: ((value: boolean) => void) | undefined;
    const persistence = new Promise<boolean>((resolve) => {
      resolvePersistence = resolve;
    });
    const persistRuntimeMode = vi.fn(() => persistence);
    const { cleanup } = await mountCodexSlider(
      { reasoningEffort: "low", fastMode: true },
      { persistRuntimeMode },
    );
    try {
      const initial = useComposerDraftStore.getState();
      await page.getByRole("button", { name: "Change model and reasoning" }).click();
      await page.getByRole("menuitem", { name: "Apply GPT-5.4 · Extra High (Codex)" }).click();
      await expect.element(page.getByRole("status")).toHaveTextContent("Applying preset…");
      expect(useComposerDraftStore.getState().draftsByThreadId).toEqual(initial.draftsByThreadId);
      resolvePersistence?.(false);
      await expect
        .element(page.getByRole("status"))
        .toHaveTextContent("Your configuration has not changed.");
      expect(useComposerDraftStore.getState().draftsByThreadId).toEqual(initial.draftsByThreadId);
      expect(useComposerDraftStore.getState().stickyModelSelectionByProvider).toEqual(
        initial.stickyModelSelectionByProvider,
      );
      persistRuntimeMode.mockResolvedValue(true);
      await page.getByRole("menuitem", { name: "Apply GPT-5.4 · Extra High (Codex)" }).click();
      await expect
        .element(page.getByRole("button", { name: "Change model and reasoning" }))
        .toHaveAttribute("aria-expanded", "false");
      expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex).toMatchObject({
        model: GPT_5_4,
        options: { reasoningEffort: "xhigh", fastMode: true },
      });
    } finally {
      await cleanup();
    }
  });

  it("recovers corrupt presets without modifying existing model favourites", async () => {
    localStorage.setItem(COMPOSER_MODEL_PRESETS_STORAGE_KEY, "not json");
    const favourites = JSON.stringify([GPT_5_4]);
    localStorage.setItem(FAVORITE_MODEL_STORAGE_KEYS.codex, favourites);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { cleanup } = await mountCodexSlider({ reasoningEffort: "medium" });
    try {
      await page.getByRole("button", { name: "Change model and reasoning" }).click();
      await page.getByRole("button", { name: "Save GPT-5.5 · Medium as preset" }).click();
      expect(
        JSON.parse(localStorage.getItem(COMPOSER_MODEL_PRESETS_STORAGE_KEY) ?? "[]"),
      ).toHaveLength(1);
      expect(localStorage.getItem(FAVORITE_MODEL_STORAGE_KEYS.codex)).toBe(favourites);
      await page.getByRole("menuitem", { name: "Medium GPT-5.5", exact: true }).click();
      await expect
        .element(page.getByRole("button", { name: "Remove GPT-5.4 from favourites", exact: true }))
        .toBeVisible();
    } finally {
      await cleanup();
      errorSpy.mockRestore();
    }
  });

  it("fits the compact panel and a long preset list in a narrow viewport", async () => {
    const originalViewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(320, 480);
    const presets: ComposerModelPreset[] = Array.from({ length: 20 }, (_, index) => ({
      provider: "codex",
      model: `A very long saved model name ${index}`,
      reasoning: null,
    }));
    localStorage.setItem(COMPOSER_MODEL_PRESETS_STORAGE_KEY, JSON.stringify(presets));
    const { cleanup } = await mountCodexSlider();
    try {
      const trigger = page.getByRole("button", { name: "Change model and reasoning" });
      await trigger.click();
      await expect.element(page.getByRole("slider", { name: "Reasoning effort" })).toBeVisible();
      await vi.waitFor(() => {
        const popup = page.getByRole("menu").element();
        const bounds = popup.getBoundingClientRect();
        expect(bounds.width).toBe(256);
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
        expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
        expect(popup.scrollWidth).toBeLessThanOrEqual(popup.clientWidth + 1);
      });
      await userEvent.keyboard("{Escape}");
      await expect.element(trigger).toHaveFocus();
    } finally {
      await cleanup();
      await page.viewport(originalViewport.width, originalViewport.height);
    }
  });
});

describe("ComposerModelEffortPicker", () => {
  it("keeps Grok 4.6 effort visible in compact layouts before runtime discovery", async () => {
    const screen = await render(
      <ComposerModelEffortPicker
        provider="grok"
        model={GROK_4_6}
        lockedProvider={null}
        modelOptionsByProvider={{
          ...EMPTY_MODEL_OPTIONS_BY_PROVIDER,
          grok: [{ slug: GROK_4_6, name: "Grok 4.6" }],
        }}
        hideStatusLabel
        onProviderModelChange={vi.fn()}
        threadId={THREAD_ID}
        modelOptions={undefined}
        prompt=""
        onPromptChange={vi.fn()}
      />,
    );

    try {
      const trigger = page.getByRole("button", { name: "Change model and reasoning" });
      await expect.element(trigger).toHaveAttribute("title", "High");
      expect(trigger.element().querySelector('[data-slot="central-icon"]')).not.toBeNull();

      await trigger.click();
      await expect.element(page.getByRole("menuitemradio", { name: "Low" })).toBeVisible();
      await expect.element(page.getByRole("menuitemradio", { name: "Medium" })).toBeVisible();
      await expect
        .element(page.getByRole("menuitemradio", { name: "High (default)" }))
        .toBeVisible();
      await expect.element(page.getByRole("menuitemradio", { name: "Extra High" })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("explains when the selected model exposes no adjustable settings", async () => {
    const screen = await render(
      <ComposerModelEffortPicker
        provider="opencode"
        model={"mimo-v2.5-free" as ModelSlug}
        lockedProvider="opencode"
        modelOptionsByProvider={{
          ...EMPTY_MODEL_OPTIONS_BY_PROVIDER,
          opencode: [{ slug: "mimo-v2.5-free" as ModelSlug, name: "MiMo V2.5 Free" }],
        }}
        effortControl="menu"
        onProviderModelChange={vi.fn()}
        threadId={THREAD_ID}
        modelOptions={undefined}
        prompt=""
        onPromptChange={vi.fn()}
      />,
    );

    try {
      await page.getByRole("button", { name: "Change model and reasoning" }).click();
      await expect.element(page.getByRole("menuitem", { name: "MiMo V2.5 Free" })).toBeVisible();
      await expect.element(page.getByText("No adjustable settings for this model.")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});

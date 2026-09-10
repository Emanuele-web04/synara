import "../../index.css";

import {
  type CodexModelOptions,
  type ModelSlug,
  type ProviderKind,
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
import { ComposerModelEffortPicker } from "./ComposerModelEffortPicker";

const THREAD_ID = ThreadId.makeUnsafe("thread-grok-model-effort-picker");
const GROK_4_6 = "grok-4.6" as ModelSlug;

const EMPTY_MODEL_OPTIONS_BY_PROVIDER: Record<ProviderKind, ReadonlyArray<ProviderModelOption>> = {
  claudeAgent: [],
  codex: [],
  cursor: [],
  devin: [],
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
  antigravity: [],
  grok: [],
  droid: [],
  opencode: [],
  pi: [],
};

// ── Slider layout (store-backed) ──────────────────────────────────────

const CODEX_THREAD_ID = ThreadId.makeUnsafe("thread-codex-effort-slider");
const GPT_5_5 = "gpt-5.5" as ModelSlug;

function CodexSliderHarness() {
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
      // Started threads pin their provider, which also gives the model submenu a
      // flat model list instead of one submenu per provider.
      lockedProvider="codex"
      modelOptionsByProvider={{
        ...EMPTY_MODEL_OPTIONS_BY_PROVIDER,
        codex: [{ slug: GPT_5_5, name: "GPT-5.5" }],
      }}
      effortControl="slider"
      onProviderModelChange={vi.fn()}
      threadId={CODEX_THREAD_ID}
      modelOptions={modelOptions?.codex}
      prompt={prompt}
      onPromptChange={(next) => setPrompt(CODEX_THREAD_ID, next)}
    />
  );
}

async function mountCodexSlider(options?: CodexModelOptions) {
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
  const screen = await render(<CodexSliderHarness />);
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
      // The stacked "effort / model" label is the submenu trigger for the model list.
      await page.getByRole("menuitem", { name: /GPT-5\.5/u }).click();

      await expect.element(page.getByRole("menuitemradio", { name: "GPT-5.5" })).toBeVisible();
    } finally {
      await cleanup();
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
});

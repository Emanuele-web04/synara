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
  useComposerDraftStore,
  useComposerThreadDraft,
  useEffectiveComposerModelState,
} from "../../composerDraftStore";
import { STARRED_MODELS_STORAGE_KEY, type StarredModel } from "../../lib/starredModels";
import { type ProviderModelOption } from "../../providerModelOptions";
import {
  deriveComposerContextWindowLabel,
  deriveContextWindowSelectionStatus,
  deriveSelectedContextWindowSnapshot,
} from "../../lib/contextWindow";
import { ComposerModelPicker } from "./ComposerModelPicker";

const THREAD_ID = ThreadId.makeUnsafe("thread-composer-model-picker");
const GPT_5_5 = "gpt-5.5" as ModelSlug;
const GPT_5_4 = "gpt-5.4" as ModelSlug;
const SONNET = "claude-sonnet-4-6" as ModelSlug;

const EMPTY_BY_PROVIDER: Record<ProviderKind, never[]> = {
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

const MODEL_OPTIONS_BY_PROVIDER: Record<ProviderKind, ReadonlyArray<ProviderModelOption>> = {
  ...EMPTY_BY_PROVIDER,
  codex: [
    { slug: GPT_5_5, name: "GPT-5.5", description: "Frontier agentic coding" },
    { slug: GPT_5_4, name: "GPT-5.4", description: "Previous generation" },
  ],
  claudeAgent: [{ slug: SONNET, name: "Claude Sonnet 4.6" }],
};

function readyProvider(provider: ProviderKind): ServerProviderStatus {
  return {
    provider,
    status: "ready",
    available: true,
    authStatus: "authenticated",
    checkedAt: "2026-04-10T10:00:00.000Z",
  };
}

type HarnessProps = {
  lockedProvider?: ProviderKind | null;
  modelOptionsByProvider?: React.ComponentProps<
    typeof ComposerModelPicker
  >["modelOptionsByProvider"];
  effortControl?: "menu" | "slider";
  onProviderModelChange?: React.ComponentProps<typeof ComposerModelPicker>["onProviderModelChange"];
};

function Harness(props: HarnessProps) {
  const prompt = useComposerThreadDraft(THREAD_ID).prompt;
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const { modelOptions, selectedModel } = useEffectiveComposerModelState({
    threadId: THREAD_ID,
    selectedProvider: "codex",
    threadModelSelection: null,
    projectModelSelection: null,
    customModelsByProvider: EMPTY_BY_PROVIDER,
  });
  return (
    <ComposerModelPicker
      provider="codex"
      model={(selectedModel ?? GPT_5_5) as ModelSlug}
      lockedProvider={props.lockedProvider ?? null}
      effortControl={props.effortControl ?? "menu"}
      providers={[readyProvider("codex"), readyProvider("claudeAgent")]}
      modelOptionsByProvider={props.modelOptionsByProvider ?? MODEL_OPTIONS_BY_PROVIDER}
      onProviderModelChange={props.onProviderModelChange ?? vi.fn()}
      threadId={THREAD_ID}
      modelOptions={modelOptions?.codex}
      prompt={prompt}
      onPromptChange={(next) => setPrompt(THREAD_ID, next)}
    />
  );
}

async function mountPicker(
  harnessProps: HarnessProps = {},
  options?: CodexModelOptions,
  starred?: ReadonlyArray<StarredModel>,
) {
  if (starred) {
    localStorage.setItem(STARRED_MODELS_STORAGE_KEY, JSON.stringify(starred));
  }
  useComposerDraftStore.getState().setModelSelection(THREAD_ID, {
    provider: "codex",
    model: GPT_5_5,
    ...(options ? { options } : {}),
  });
  const screen = await render(<Harness {...harnessProps} />);
  await page.getByRole("button", { name: "Change model and reasoning" }).click();
  return screen;
}

function readStoredStars(): unknown {
  return JSON.parse(localStorage.getItem(STARRED_MODELS_STORAGE_KEY) ?? "[]");
}

describe("ComposerModelPicker", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
    localStorage.removeItem(STARRED_MODELS_STORAGE_KEY);
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
    });
  });

  it("opens on the active provider tab and commits a clicked model", async () => {
    const onProviderModelChange = vi.fn();
    const screen = await mountPicker({ onProviderModelChange });
    try {
      await expect
        .element(page.getByRole("tab", { name: "Codex" }))
        .toHaveAttribute("aria-selected", "true");
      await page.getByRole("menuitem", { name: /GPT-5\.4/u }).click();
      expect(onProviderModelChange).toHaveBeenCalledWith("codex", GPT_5_4);
    } finally {
      await screen.unmount();
    }
  });

  it("switches provider tabs and filters rows with search", async () => {
    const screen = await mountPicker();
    try {
      await page.getByRole("tab", { name: "Claude" }).click();
      await expect.element(page.getByRole("menuitem", { name: /Claude Sonnet/u })).toBeVisible();

      await page.getByRole("tab", { name: "Codex" }).click();
      await page.getByRole("searchbox", { name: "Search models" }).fill("5.4");
      await expect.element(page.getByRole("menuitem", { name: /GPT-5\.4/u })).toBeVisible();
      await expect
        .element(page.getByRole("menuitem", { name: /GPT-5\.5/u }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("picks the Nth row with mod+digit", async () => {
    const onProviderModelChange = vi.fn();
    const screen = await mountPicker({ onProviderModelChange });
    try {
      await expect.element(page.getByRole("menuitem", { name: /GPT-5\.4/u })).toBeVisible();
      await userEvent.keyboard("{Control>}2{/Control}");
      expect(onProviderModelChange).toHaveBeenCalledWith("codex", GPT_5_4);
    } finally {
      await screen.unmount();
    }
  });

  it("picks a model and its effort from the row's hover side block", async () => {
    const onProviderModelChange = vi.fn();
    const screen = await mountPicker({ onProviderModelChange }, { reasoningEffort: "medium" });
    try {
      await page.getByRole("menuitem", { name: /GPT-5\.4/u }).hover();
      await page.getByRole("menuitemradio", { name: /^High/u }).click();
      expect(onProviderModelChange).toHaveBeenCalledWith("codex", GPT_5_4, {
        modelOptions: { reasoningEffort: "high" },
      });
    } finally {
      await screen.unmount();
    }
  });

  it("stars a model together with the traits composed in the footer rows", async () => {
    const screen = await mountPicker({}, { reasoningEffort: "medium" });
    try {
      await page.getByRole("menuitem", { name: /^Effort/u }).click();
      await page.getByRole("menuitemradio", { name: /^High/u }).click();
      await page
        .getByRole("button", { name: "Star GPT-5.5 with its current effort and speed" })
        .click();

      expect(readStoredStars()).toEqual([
        { provider: "codex", model: GPT_5_5, effort: "high", fastMode: false, thinking: null },
      ]);

      await page.getByRole("tab", { name: "Starred" }).click();
      await expect.element(page.getByRole("menuitem", { name: /GPT-5\.5.*High/u })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("opens on starred presets and restores model + traits in one click", async () => {
    const onProviderModelChange = vi.fn();
    const screen = await mountPicker({ onProviderModelChange }, { reasoningEffort: "medium" }, [
      { provider: "codex", model: GPT_5_4, effort: "low", fastMode: true, thinking: null },
    ]);
    try {
      await expect
        .element(page.getByRole("tab", { name: "Starred" }))
        .toHaveAttribute("aria-selected", "true");
      await page.getByRole("menuitem", { name: /GPT-5\.4.*Low · Fast/u }).click();
      expect(onProviderModelChange).toHaveBeenCalledWith("codex", GPT_5_4, {
        modelOptions: { reasoningEffort: "low", fastMode: true },
      });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps retired presets removable while blocking clicks and shortcuts", async () => {
    const onProviderModelChange = vi.fn();
    const screen = await mountPicker(
      {
        onProviderModelChange,
        modelOptionsByProvider: {
          ...MODEL_OPTIONS_BY_PROVIDER,
          codex: [{ slug: GPT_5_5, name: "GPT-5.5" }],
        },
      },
      undefined,
      [{ provider: "codex", model: GPT_5_4, effort: "low", fastMode: null, thinking: null }],
    );
    try {
      const retired = page.getByRole("menuitem", { name: /GPT-5\.4.*Unavailable/u });
      await expect.element(retired).toHaveAttribute("aria-disabled", "true");
      retired.element().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await userEvent.keyboard("{Control>}1{/Control}");
      expect(onProviderModelChange).not.toHaveBeenCalled();

      await page.getByRole("button", { name: "Remove GPT-5.4 from starred" }).click();
      expect(readStoredStars()).toEqual([]);
      expect(onProviderModelChange).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("enables a saved custom preset when its catalog becomes available", async () => {
    const onProviderModelChange = vi.fn();
    const model = "private-model" as ModelSlug;
    const preset: StarredModel = {
      provider: "codex",
      model,
      effort: null,
      fastMode: null,
      thinking: null,
    };
    const screen = await mountPicker(
      { onProviderModelChange, modelOptionsByProvider: EMPTY_BY_PROVIDER },
      undefined,
      [preset],
    );
    try {
      await expect
        .element(page.getByRole("menuitem", { name: /Private Model.*Unavailable/u }))
        .toHaveAttribute("aria-disabled", "true");
      expect(readStoredStars()).toEqual([preset]);

      await screen.rerender(
        <Harness
          onProviderModelChange={onProviderModelChange}
          modelOptionsByProvider={{
            ...EMPTY_BY_PROVIDER,
            codex: [{ slug: model, name: "Private Model" }],
          }}
        />,
      );
      const available = page.getByRole("menuitem", { name: /Private Model/u });
      await expect.element(available).not.toHaveAttribute("aria-disabled", "true");
      await available.click();
      expect(onProviderModelChange).toHaveBeenCalledWith("codex", model);
    } finally {
      await screen.unmount();
    }
  });

  it("renders the effort ladder as a footer slider and commits keyboard steps", async () => {
    const screen = await mountPicker({ effortControl: "slider" }, { reasoningEffort: "medium" });
    try {
      const slider = page.getByRole("slider", { name: "Reasoning effort" });
      await expect.element(slider).toHaveAttribute("aria-valuetext", "Medium");
      // The slider card owns effort and speed, so their rows are gone.
      expect(page.getByRole("menuitem", { name: /^Effort/u }).elements()).toHaveLength(0);
      expect(page.getByRole("menuitem", { name: /^Speed/u }).elements()).toHaveLength(0);

      await slider.element().focus();
      await userEvent.keyboard("{ArrowRight}");

      await expect.element(slider).toHaveAttribute("aria-valuetext", "High");
      expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex).toMatchObject({
        provider: "codex",
        options: { reasoningEffort: "high" },
      });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the panel open after switching model in slider mode so the slider stays usable", async () => {
    // Mirror the app: a picked model lands in the draft store and flows back as props.
    const onProviderModelChange = vi.fn((_provider: ProviderKind, model: ModelSlug) => {
      useComposerDraftStore.getState().setModelSelection(THREAD_ID, {
        provider: "codex",
        model,
        options: { reasoningEffort: "medium" },
      });
    });
    const screen = await mountPicker(
      { effortControl: "slider", onProviderModelChange },
      { reasoningEffort: "medium" },
    );
    try {
      const otherModel = page.getByRole("menuitem", { name: /GPT-5\.4/u });
      // Slider mode drops the per-row effort side block: the footer slider owns effort.
      await otherModel.hover();
      expect(page.getByRole("menuitemradio").elements()).toHaveLength(0);

      await otherModel.click();
      expect(onProviderModelChange).toHaveBeenCalledWith("codex", GPT_5_4);
      const slider = page.getByRole("slider", { name: "Reasoning effort" });
      await expect.element(slider).toBeVisible();
      await expect.element(otherModel).toHaveAttribute("aria-current", "true");

      // Picking the model that is already current is the "done" gesture.
      await otherModel.click();
      await expect.element(slider).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the trigger's size while the slider panel is open", async () => {
    useComposerDraftStore.getState().setModelSelection(THREAD_ID, {
      provider: "codex",
      model: GPT_5_5,
      options: { reasoningEffort: "medium" },
    });
    const screen = await render(<Harness effortControl="slider" />);
    try {
      const trigger = page.getByRole("button", { name: "Change model and reasoning" });
      const closedWidth = trigger.element().getBoundingClientRect().width;
      await trigger.click();

      // The covered label keeps sizing the pill; a resize under the cursor would make
      // Base UI cancel the open on mouseup.
      await expect.element(page.getByText("Select effort")).toBeVisible();
      const slider = page.getByRole("slider", { name: "Reasoning effort" });
      await expect.element(slider).toBeVisible();
      expect(trigger.element().getBoundingClientRect().width).toBeCloseTo(closedWidth, 1);

      slider.element().focus();
      await userEvent.keyboard("{ArrowRight}{ArrowRight}");
      await expect.element(slider).toHaveAttribute("aria-valuetext", "Extra High");
      expect(trigger.element().getBoundingClientRect().width).toBeCloseTo(closedWidth, 1);
    } finally {
      await screen.unmount();
    }
  });

  it("toggles fast mode and resets both controls from the slider card", async () => {
    const screen = await mountPicker({ effortControl: "slider" }, { reasoningEffort: "xhigh" });
    try {
      const fastToggle = page.getByRole("button", { name: "Fast mode" });
      await fastToggle.click();
      await expect.element(fastToggle).toHaveAttribute("aria-pressed", "true");

      const reset = page.getByRole("button", { name: "Reset effort and speed" });
      await reset.click();

      await expect
        .element(page.getByRole("slider", { name: "Reasoning effort" }))
        .toHaveAttribute("aria-valuetext", "Medium");
      await expect.element(fastToggle).toHaveAttribute("aria-pressed", "false");
      await expect.element(reset).toBeDisabled();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a started thread on its provider", async () => {
    const screen = await mountPicker({ lockedProvider: "codex" }, undefined, [
      { provider: "claudeAgent", model: SONNET, effort: null, fastMode: null, thinking: null },
    ]);
    try {
      expect(page.getByRole("tab", { name: "Claude" }).elements()).toHaveLength(0);
      await page.getByRole("tab", { name: "Starred" }).click();
      expect(page.getByRole("menuitem", { name: /Claude Sonnet/u }).elements()).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });
});

describe("Claude composer budget suffix", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });
  it.each([
    ["claude-fable-5-1", "Fable 5.1", "high", "(1M)", false, "Fable 5.1High(1M)"],
    ["claude-opus-4-7", "Opus", undefined, "(1M)", false, "OpusHigh(1M)"],
    [
      "claude-fable-5-1",
      "Fable 5.1",
      "high",
      "(200k · 1M next)",
      false,
      "Fable 5.1High(200k · 1M next)",
    ],
    ["claude-fable-5-1", "Fable 5.1", "high", "(1M next)", false, "Fable 5.1High(1M next)"],
    ["claude-fable-5-1", "Fable 5.1", "high", "(1M)", true, "Fable 5.1High(1M)"],
  ] as const)(
    "renders %s %s %s %s compact=%s",
    async (slug, name, effort, label, compact, expected) => {
      const snapshot = {
        ...deriveSelectedContextWindowSnapshot("1m")!,
        maxTokens: 967000,
        claudeCache: {
          model: `${slug}[1m]`,
          observedAt: "2026-09-17T00:00:00.000Z",
          state: "unknown" as const,
          source: "request-usage" as const,
        },
      };
      const runtimeLabel = deriveComposerContextWindowLabel({
        provider: "claudeAgent",
        model: slug,
        snapshot,
        status: deriveContextWindowSelectionStatus({
          activeSnapshot: snapshot,
          appliedValue: "1m",
          selectedValue: "1m",
        }),
      });
      const screen = await render(
        <ComposerModelPicker
          provider="claudeAgent"
          model={slug as ModelSlug}
          lockedProvider={null}
          modelOptionsByProvider={{
            ...EMPTY_BY_PROVIDER,
            claudeAgent: [{ slug: slug as ModelSlug, name }],
          }}
          onProviderModelChange={vi.fn()}
          threadId={THREAD_ID}
          modelOptions={{ ...(effort ? { effort } : {}), fastMode: true }}
          prompt=""
          onPromptChange={vi.fn()}
          contextWindowLabel={label === "(1M)" ? runtimeLabel : label}
          hideModelLabel={compact}
          hideStatusLabel={compact}
        />,
      );
      const button = page.getByRole("button", { name: "Change model and reasoning" });
      expect(button.element().textContent).toBe(expected);
      if (compact) {
        await expect.element(button).toHaveAttribute("title", `Fable 5.1 · High · ${label}`);
        expect(button.element().getBoundingClientRect().width).toBeLessThan(150);
      }
      await screen.unmount();
    },
  );
});

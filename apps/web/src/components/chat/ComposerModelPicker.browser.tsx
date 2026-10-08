import "../../index.css";

import {
  type CodexModelOptions,
  type ModelSlug,
  type ProviderInstanceId,
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
import { type ProviderModelPickerInstance } from "./ProviderModelPicker";

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
  omp: [],
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
    instanceId: provider,
    driver: provider,
    status: "ready",
    available: true,
    authStatus: "authenticated",
    checkedAt: "2026-04-10T10:00:00.000Z",
  };
}

const GPT_5_WORK = "gpt-5-work" as ModelSlug;

// A default Codex account plus a second one, each with its own model catalog.
const CODEX_ACCOUNTS: ReadonlyArray<ProviderModelPickerInstance> = [
  { instanceId: "codex", provider: "codex", label: "Codex", enabled: true, isDefault: true },
  { instanceId: "codex_work", provider: "codex", label: "Work", enabled: true, isDefault: false },
];
const WORK_ACCOUNT_STATUS: ServerProviderStatus = {
  ...readyProvider("codex"),
  instanceId: "codex_work",
  displayName: "Work",
};
const WORK_ACCOUNT_MODELS = {
  codex_work: [{ slug: GPT_5_WORK, name: "GPT-5 Work" }],
};

type HarnessProps = {
  providers?: ReadonlyArray<ServerProviderStatus>;
  providerInstances?: ReadonlyArray<ProviderModelPickerInstance>;
  selectedProviderInstanceId?: ProviderInstanceId;
  modelOptionsByProviderInstance?: React.ComponentProps<
    typeof ComposerModelPicker
  >["modelOptionsByProviderInstance"];
  lockedProvider?: ProviderKind | null;
  boundProviderInstance?: React.ComponentProps<typeof ComposerModelPicker>["boundProviderInstance"];
  modelOptionsByProvider?: React.ComponentProps<
    typeof ComposerModelPicker
  >["modelOptionsByProvider"];
  effortControl?: "menu" | "slider";
  onProviderModelChange?: React.ComponentProps<typeof ComposerModelPicker>["onProviderModelChange"];
  onRefreshModels?: React.ComponentProps<typeof ComposerModelPicker>["onRefreshModels"];
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
      boundProviderInstance={props.boundProviderInstance ?? null}
      effortControl={props.effortControl ?? "menu"}
      providers={props.providers ?? [readyProvider("codex"), readyProvider("claudeAgent")]}
      {...(props.providerInstances ? { providerInstances: props.providerInstances } : {})}
      {...(props.selectedProviderInstanceId
        ? { selectedProviderInstanceId: props.selectedProviderInstanceId }
        : {})}
      {...(props.modelOptionsByProviderInstance
        ? { modelOptionsByProviderInstance: props.modelOptionsByProviderInstance }
        : {})}
      modelOptionsByProvider={props.modelOptionsByProvider ?? MODEL_OPTIONS_BY_PROVIDER}
      onProviderModelChange={props.onProviderModelChange ?? vi.fn()}
      {...(props.onRefreshModels ? { onRefreshModels: props.onRefreshModels } : {})}
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
  it("hides a globally disabled provider's tabs and starred models, including the active default", async () => {
    const screen = await mountPicker(
      {
        providers: [
          { ...readyProvider("codex"), enabled: false, available: false },
          readyProvider("claudeAgent"),
        ],
        providerInstances: CODEX_ACCOUNTS.map((instance) => ({ ...instance, enabled: false })),
      },
      undefined,
      [{ provider: "codex", model: GPT_5_5, effort: null, fastMode: null, thinking: null }],
    );
    try {
      expect(page.getByRole("tab", { name: /^Codex/u }).elements()).toHaveLength(0);
      await expect.element(page.getByRole("menuitem", { name: /Claude Sonnet/u })).toBeVisible();
      await page.getByRole("tab", { name: "Starred", exact: true }).click();
      expect(page.getByRole("menuitem", { name: /GPT-5\.5/u }).elements()).toHaveLength(0);
      expect(readStoredStars()).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });

  it("checks a cached account silently and shows progress only on retry", async () => {
    let finish!: () => void;
    const promise = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const onRefreshModels = vi.fn().mockReturnValueOnce(promise);
    const screen = await mountPicker({ onRefreshModels });
    try {
      await vi.waitFor(() =>
        expect(onRefreshModels).toHaveBeenCalledExactlyOnceWith("codex", "codex", "if-stale"),
      );
      expect(page.getByRole("button", { name: "Refresh models" }).elements()).toHaveLength(0);
      expect(page.getByRole("status").elements()).toHaveLength(0);
      await expect.element(page.getByRole("menuitem", { name: /GPT-5.5/u }).first()).toBeVisible();
      finish();
      await promise;
      expect(page.getByRole("button", { name: "Refresh models" }).elements()).toHaveLength(0);

      onRefreshModels.mockRejectedValueOnce(new Error("offline"));
      await page.getByRole("tab", { name: "Claude" }).click();
      await expect.element(page.getByText("Couldn’t update models.")).toBeVisible();
      expect(onRefreshModels).toHaveBeenLastCalledWith("claudeAgent", "claudeAgent", "if-stale");
      let finishRetry!: () => void;
      onRefreshModels.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          finishRetry = resolve;
        }),
      );
      const retryButton = page.getByRole("button", { name: "Retry" });
      await retryButton.click();
      await expect.element(retryButton).toBeDisabled();
      await expect.element(page.getByText("Loading models…")).toBeVisible();
      expect(onRefreshModels).toHaveBeenLastCalledWith("claudeAgent", "claudeAgent", "now");
      finishRetry();
      await expect.element(retryButton).not.toBeInTheDocument();
      expect(page.getByRole("status").elements()).toHaveLength(0);
      await page.getByRole("tab", { name: "Starred" }).click();
      expect(onRefreshModels).toHaveBeenCalledTimes(3);
    } finally {
      await screen.unmount();
    }
  });

  it("does not restart a pending check when the refresh callback changes", async () => {
    let finish!: () => void;
    const onRefreshModels = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const screen = await mountPicker({ onRefreshModels });
    try {
      await vi.waitFor(() => expect(onRefreshModels).toHaveBeenCalledTimes(1));
      await screen.rerender(<Harness onRefreshModels={(...args) => onRefreshModels(...args)} />);
      expect(page.getByRole("status").elements()).toHaveLength(0);
      finish();
      expect(onRefreshModels).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("shows loading for an empty account and stays quiet for a cached one", async () => {
    let finishOpenCode!: () => void;
    let finishClaude!: () => void;
    const onRefreshModels = vi.fn((provider: ProviderKind) => {
      if (provider === "opencode") {
        return new Promise<void>((resolve) => {
          finishOpenCode = resolve;
        });
      }
      if (provider === "claudeAgent") {
        return new Promise<void>((resolve) => {
          finishClaude = resolve;
        });
      }
      return Promise.resolve();
    });
    const screen = await mountPicker({
      providers: [readyProvider("codex"), readyProvider("opencode"), readyProvider("claudeAgent")],
      onRefreshModels,
    });
    try {
      await page.getByRole("tab", { name: "OpenCode" }).click();
      await expect.element(page.getByText("Loading models…")).toBeVisible();
      await expect.element(page.getByLabelText("Loading models")).toBeVisible();
      expect(page.getByText("No models found").elements()).toHaveLength(0);
      await page.getByRole("tab", { name: "Claude" }).click();
      await expect
        .element(page.getByRole("menuitem", { name: /Claude Sonnet/u }).first())
        .toBeVisible();
      expect(page.getByText("Loading models…").elements()).toHaveLength(0);
      finishOpenCode();
      finishClaude();
      expect(page.getByText("Loading models…").elements()).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });

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
      expect(onProviderModelChange).toHaveBeenCalledWith("codex", GPT_5_4, { instanceId: "codex" });
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
      expect(onProviderModelChange).toHaveBeenCalledWith("codex", GPT_5_4, { instanceId: "codex" });
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
        instanceId: "codex",
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
        instanceId: "codex",
      });
    } finally {
      await screen.unmount();
    }
  });

  it("shows the star on every starred model of the provider tab, whatever its traits", async () => {
    const screen = await mountPicker({}, { reasoningEffort: "medium" }, [
      { provider: "codex", model: GPT_5_5, effort: "high", fastMode: false, thinking: null },
      { provider: "codex", model: GPT_5_4, effort: "low", fastMode: true, thinking: null },
    ]);
    try {
      await page.getByRole("tab", { name: "Codex" }).click();
      await expect
        .element(page.getByRole("button", { name: "Remove GPT-5.5 from starred" }))
        .toBeVisible();
      await page.getByRole("button", { name: "Remove GPT-5.4 from starred" }).click();

      expect(readStoredStars()).toEqual([
        { provider: "codex", model: GPT_5_5, effort: "high", fastMode: false, thinking: null },
      ]);
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
      expect(onProviderModelChange).toHaveBeenCalledWith("codex", model, { instanceId: "codex" });
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
      expect(onProviderModelChange).toHaveBeenCalledWith("codex", GPT_5_4, { instanceId: "codex" });
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

      // The panel still settles its own focus right after open and can steal it
      // back mid-typing, so step the thumb directly; each step must commit before
      // the next, since back-to-back keydowns would read the stale value.
      slider
        .element()
        .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      await expect.element(slider).toHaveAttribute("aria-valuetext", "High");
      slider
        .element()
        .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
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

describe("ComposerModelPicker with several accounts", () => {
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

  const multiAccount: HarnessProps = {
    providers: [readyProvider("codex"), WORK_ACCOUNT_STATUS, readyProvider("claudeAgent")],
    providerInstances: CODEX_ACCOUNTS,
    modelOptionsByProviderInstance: WORK_ACCOUNT_MODELS,
  };

  it("gives each enabled account its own named tab", async () => {
    const screen = await mountPicker({
      ...multiAccount,
      providerInstances: [
        ...CODEX_ACCOUNTS,
        {
          instanceId: "codex_old",
          provider: "codex",
          label: "Old",
          enabled: false,
          isDefault: false,
        },
      ],
    });
    try {
      const defaultTab = page.getByRole("tab", { name: "Codex", exact: true });
      const workTab = page.getByRole("tab", { name: "Codex · Work", exact: true });
      await expect.element(defaultTab).toHaveAttribute("aria-selected", "true");
      // Only the open tab spells its account out; the other stays icon-sized.
      expect(defaultTab.element().textContent).toBe("Codex");
      expect(workTab.element().textContent).toBe("");
      await workTab.click();
      expect(workTab.element().textContent).toBe("Work");
      expect(defaultTab.element().textContent).toBe("");
      // A disabled account is managed in settings, not offered in the picker.
      expect(page.getByRole("tab", { name: /Old/u }).elements()).toHaveLength(0);
      // Claude has a single account, so its icon says it all.
      expect(page.getByRole("tab", { name: "Claude" }).element().textContent).toBe("");
    } finally {
      await screen.unmount();
    }
  });

  it("lists the account's own models and commits them with its id", async () => {
    const onProviderModelChange = vi.fn();
    const screen = await mountPicker({ ...multiAccount, onProviderModelChange });
    try {
      await page.getByRole("tab", { name: "Codex · Work", exact: true }).click();
      await expect
        .element(page.getByRole("menuitem", { name: /GPT-5\.5/u }))
        .not.toBeInTheDocument();
      await page.getByRole("menuitem", { name: /GPT-5 Work/u }).click();
      expect(onProviderModelChange).toHaveBeenCalledWith("codex", GPT_5_WORK, {
        instanceId: "codex_work",
      });
    } finally {
      await screen.unmount();
    }
  });

  it("names the composer's account on the trigger and dots it with its accent color", async () => {
    const screen = await mountPicker({
      ...multiAccount,
      selectedProviderInstanceId: "codex_work",
      providerInstances: [CODEX_ACCOUNTS[0]!, { ...CODEX_ACCOUNTS[1]!, accentColor: "#16a34a" }],
    });
    try {
      const trigger = page.getByRole("button", { name: "Change model and reasoning" }).element();
      const dot = trigger.querySelector<HTMLElement>("[data-accent]");
      expect(dot?.dataset.accent).toBe("#16a34a");
      // The account's name is written before the model.
      expect(trigger.textContent).toContain("Work");
    } finally {
      await screen.unmount();
    }
  });

  it("dots a lone account that has an accent color without naming it", async () => {
    const screen = await mountPicker({
      providerInstances: [{ ...CODEX_ACCOUNTS[0]!, accentColor: "#2563eb" }],
    });
    try {
      const tab = page.getByRole("tab", { name: "Codex", exact: true }).element();
      expect(tab.textContent).toBe("");
      expect(tab.querySelector<HTMLElement>("[data-accent]")?.dataset.accent).toBe("#2563eb");
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a started thread on its account and explains the closed sibling", async () => {
    const screen = await mountPicker({ ...multiAccount, lockedProvider: "codex" });
    try {
      const workTab = page.getByRole("tab", { name: "Codex · Work", exact: true });
      await expect.element(workTab).toHaveAttribute("aria-disabled", "true");
      await workTab.hover();
      await expect
        .element(
          page.getByText(
            "Codex · Work is unavailable in this thread. Start a new thread to switch accounts.",
          ),
        )
        .toBeInTheDocument();
      await workTab.click({ force: true });
      await expect
        .element(page.getByRole("tab", { name: "Codex", exact: true }))
        .toHaveAttribute("aria-selected", "true");
      expect(page.getByRole("tab", { name: "Claude" }).elements()).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });

  it("opens other providers for a handoff but keeps the thread's account", async () => {
    const screen = await mountPicker({
      ...multiAccount,
      boundProviderInstance: { provider: "codex", instanceId: "codex" },
    });
    try {
      // Another provider is pickable: choosing it hands the thread off.
      await expect
        .element(page.getByRole("tab", { name: "Claude" }))
        .not.toHaveAttribute("aria-disabled", "true");
      // A sibling account of the thread's own provider stays closed.
      await expect
        .element(page.getByRole("tab", { name: "Codex · Work", exact: true }))
        .toHaveAttribute("aria-disabled", "true");
    } finally {
      await screen.unmount();
    }
  });

  it("scrolls a crowded tab strip sideways and keeps the open tab in view", async () => {
    const providers: ProviderKind[] = [
      "codex",
      "claudeAgent",
      "cursor",
      "devin",
      "antigravity",
      "grok",
      "droid",
      "opencode",
      "pi",
      "omp",
    ];
    const screen = await mountPicker({
      providers: [...providers.map(readyProvider), WORK_ACCOUNT_STATUS],
      providerInstances: CODEX_ACCOUNTS,
      modelOptionsByProviderInstance: WORK_ACCOUNT_MODELS,
    });
    try {
      const strip = page.getByRole("tablist", { name: "Model sources" }).element();
      expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth);
      const isInView = (tab: Element) => {
        const tabRect = tab.getBoundingClientRect();
        const stripRect = strip.getBoundingClientRect();
        return tabRect.left >= stripRect.left - 1 && tabRect.right <= stripRect.right + 1;
      };
      // The shortcut to provider settings sits outside the strip and never scrolls away.
      const addProviders = page.getByRole("button", { name: "Add providers" }).element();
      expect(strip.contains(addProviders)).toBe(false);

      // A vertical mouse wheel scrolls the strip sideways.
      strip.dispatchEvent(
        new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true }),
      );
      expect(strip.scrollLeft).toBeGreaterThan(0);

      // Walking the tabs with the keyboard brings each newly opened one into view.
      strip.scrollLeft = 0;
      for (let step = 0; step < 9; step += 1) {
        await userEvent.keyboard("{Tab}");
      }
      const openTab = strip.querySelector('[aria-selected="true"]')!;
      await vi.waitFor(() => expect(isInView(openTab)).toBe(true));
      expect(strip.scrollLeft).toBeGreaterThan(0);
    } finally {
      await screen.unmount();
    }
  });

  it("offers a started thread only its own account's starred presets", async () => {
    const screen = await mountPicker({ ...multiAccount, lockedProvider: "codex" }, undefined, [
      { provider: "codex", model: GPT_5_4, effort: null, fastMode: null, thinking: null },
      {
        provider: "codex",
        instanceId: "codex_work",
        model: GPT_5_WORK,
        effort: null,
        fastMode: null,
        thinking: null,
      },
    ]);
    try {
      await page.getByRole("tab", { name: "Starred" }).click();
      await expect.element(page.getByRole("menuitem", { name: /GPT-5\.4/u })).toBeVisible();
      expect(page.getByRole("menuitem", { name: /GPT-5 Work/u }).elements()).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });

  it("invites the user to set up an account that is not signed in", async () => {
    const screen = await mountPicker({
      ...multiAccount,
      providers: [
        readyProvider("codex"),
        {
          ...WORK_ACCOUNT_STATUS,
          authStatus: "unauthenticated",
          message: "Run codex login.",
        },
        readyProvider("claudeAgent"),
      ],
    });
    try {
      await page.getByRole("tab", { name: "Codex · Work", exact: true }).click();
      await expect
        .element(page.getByText("Open provider setup to sign in to this account."))
        .toBeVisible();
      await expect.element(page.getByRole("button", { name: "Open provider setup" })).toBeVisible();
      // Its catalog is not offered while it cannot run.
      expect(page.getByRole("menuitem", { name: /GPT-5 Work/u }).elements()).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });

  it("names the account on each starred preset", async () => {
    const onProviderModelChange = vi.fn();
    const screen = await mountPicker({ ...multiAccount, onProviderModelChange }, undefined, [
      { provider: "codex", model: GPT_5_4, effort: null, fastMode: null, thinking: null },
      {
        provider: "codex",
        instanceId: "codex_work",
        model: GPT_5_WORK,
        effort: null,
        fastMode: null,
        thinking: null,
      },
    ]);
    try {
      await expect.element(page.getByRole("menuitem", { name: /GPT-5\.4.*Codex/u })).toBeVisible();
      await page.getByRole("menuitem", { name: /GPT-5 Work.*Work/u }).click();
      expect(onProviderModelChange).toHaveBeenCalledWith("codex", GPT_5_WORK, {
        instanceId: "codex_work",
      });
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

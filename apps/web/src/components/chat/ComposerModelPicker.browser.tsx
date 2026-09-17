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
      providers={[readyProvider("codex"), readyProvider("claudeAgent")]}
      modelOptionsByProvider={MODEL_OPTIONS_BY_PROVIDER}
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
      expect(page.getByRole("menuitem", { name: /GPT-5\.5/u }).elements()).toHaveLength(0);
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

  it("keeps a started thread on its provider", async () => {
    const screen = await mountPicker({ lockedProvider: "codex" }, undefined, [
      { provider: "claudeAgent", model: SONNET, effort: null, fastMode: null, thinking: null },
    ]);
    try {
      expect(page.getByRole("tab", { name: "Claude" }).elements()).toHaveLength(0);
      await page.getByRole("tab", { name: "Starred" }).click();
      expect(page.getByRole("menuitem", { name: /Claude Sonnet/u }).elements()).toHaveLength(0);
      await expect.element(page.getByText(/1 starred from other providers/u)).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});

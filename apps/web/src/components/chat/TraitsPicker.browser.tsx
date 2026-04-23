import "../../index.css";

import {
  type ModelSelection,
  ClaudeModelOptions,
  CodexModelOptions,
  DEFAULT_MODEL_BY_PROVIDER,
  type OpenCodeModelOptions,
  type ProviderModelDescriptor,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { page } from "vitest/browser";
import { useCallback } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { TraitsPicker } from "./TraitsPicker";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  ComposerThreadDraftState,
  useComposerDraftStore,
  useComposerThreadDraft,
  useEffectiveComposerModelState,
} from "../../composerDraftStore";

// ── Claude TraitsPicker tests ─────────────────────────────────────────

const CLAUDE_THREAD_ID = ThreadId.makeUnsafe("thread-claude-traits");

function ClaudeTraitsPickerHarness(props: {
  model: string;
  fallbackModelSelection: ModelSelection | null;
}) {
  const prompt = useComposerThreadDraft(CLAUDE_THREAD_ID).prompt;
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const { modelOptions, selectedModel } = useEffectiveComposerModelState({
    threadId: CLAUDE_THREAD_ID,
    selectedProvider: "claudeAgent",
    threadModelSelection: props.fallbackModelSelection,
    projectModelSelection: null,
    customModelsByProvider: { codex: [], claudeAgent: [], gemini: [], opencode: [] },
  });
  const handlePromptChange = useCallback(
    (nextPrompt: string) => {
      setPrompt(CLAUDE_THREAD_ID, nextPrompt);
    },
    [setPrompt],
  );

  return (
    <TraitsPicker
      provider="claudeAgent"
      threadId={CLAUDE_THREAD_ID}
      model={selectedModel ?? props.model}
      prompt={prompt}
      modelOptions={modelOptions?.claudeAgent}
      onPromptChange={handlePromptChange}
    />
  );
}

async function mountClaudePicker(props?: {
  model?: string;
  prompt?: string;
  options?: ClaudeModelOptions;
  fallbackModelOptions?: {
    effort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultrathink";
    thinking?: boolean;
    fastMode?: boolean;
    contextWindow?: string;
  } | null;
  skipDraftModelOptions?: boolean;
}) {
  const model = props?.model ?? "claude-opus-4-6";
  const claudeOptions = !props?.skipDraftModelOptions ? props?.options : undefined;
  const draftsByThreadId: Record<ThreadId, ComposerThreadDraftState> = {
    [CLAUDE_THREAD_ID]: {
      prompt: props?.prompt ?? "",
      images: [],
      nonPersistedImageIds: [],
      persistedAttachments: [],
      assistantSelections: [],
      terminalContexts: [],
      queuedTurns: [],
      modelSelectionByProvider: props?.skipDraftModelOptions
        ? {}
        : {
            claudeAgent: {
              provider: "claudeAgent",
              model,
              ...(claudeOptions && Object.keys(claudeOptions).length > 0
                ? { options: claudeOptions }
                : {}),
            },
          },
      activeProvider: "claudeAgent",
      runtimeMode: null,
      interactionMode: null,
    },
  };
  useComposerDraftStore.setState({
    draftsByThreadId,
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
  });
  const host = document.createElement("div");
  document.body.append(host);
  const fallbackModelSelection =
    props?.fallbackModelOptions !== undefined
      ? ({
          provider: "claudeAgent",
          model,
          options: props.fallbackModelOptions ?? undefined,
        } satisfies ModelSelection)
      : null;
  const screen = await render(
    <ClaudeTraitsPickerHarness model={model} fallbackModelSelection={fallbackModelSelection} />,
    { container: host },
  );

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
  };
}

describe("TraitsPicker (Claude)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
    });
  });

  it("shows fast mode controls for Opus", async () => {
    await using _ = await mountClaudePicker();

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Fast Mode");
      expect(text).toContain("off");
      expect(text).toContain("on");
    });
  });

  it("shows context window controls for Opus models", async () => {
    await using _ = await mountClaudePicker();

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Context Window");
      expect(text).toContain("200k");
      expect(text).toContain("1M");
    });
  });

  it("hides fast mode controls for non-Opus models", async () => {
    await using _ = await mountClaudePicker({ model: "claude-sonnet-4-6" });

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").not.toContain("Fast Mode");
    });
  });

  it("shows only the provided effort options", async () => {
    await using _ = await mountClaudePicker({
      model: "claude-sonnet-4-6",
    });

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Low");
      expect(text).toContain("Medium");
      expect(text).toContain("High");
      expect(text).toContain("Max");
      expect(text).toContain("Ultrathink");
    });
  });

  it("shows Extra High for Claude Opus 4.7", async () => {
    await using _ = await mountClaudePicker({
      model: "claude-opus-4-7",
    });

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Extra High");
      expect(text).toContain("Max");
    });
  });

  it("shows a th  inking on/off dropdown for Haiku", async () => {
    await using _ = await mountClaudePicker({
      model: "claude-haiku-4-5",
      options: { thinking: true },
    });

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("Thinking On");
    });
    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Thinking");
      expect(text).toContain("On (default)");
      expect(text).toContain("Off");
    });
  });

  it("shows prompt-controlled Ultrathink state with disabled effort controls", async () => {
    await using _ = await mountClaudePicker({
      model: "claude-opus-4-6",
      options: { effort: "high" },
      prompt: "Ultrathink:\nInvestigate this",
    });

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("Ultrathink");
      expect(document.body.textContent ?? "").not.toContain("Ultrathink · Prompt");
    });
    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Effort");
      expect(text).toContain("Remove Ultrathink from the prompt to change effort.");
      expect(text).not.toContain("Fallback Effort");
    });
  });

  it("persists sticky claude model options when traits change", async () => {
    await using _ = await mountClaudePicker({
      model: "claude-opus-4-6",
      options: { effort: "medium", fastMode: false },
    });

    await page.getByRole("button").click();
    await page.getByRole("menuitemradio", { name: "Max" }).click();

    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider.claudeAgent,
    ).toMatchObject({
      provider: "claudeAgent",
      options: {
        effort: "max",
      },
    });
  });

  it("shows the non-default context window in the trigger label", async () => {
    await using _ = await mountClaudePicker({
      model: "claude-opus-4-6",
      options: { contextWindow: "1m" },
    });

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("1M");
    });
  });

  it("persists sticky claude context window when changed", async () => {
    await using _ = await mountClaudePicker({
      model: "claude-opus-4-6",
      options: { contextWindow: "200k" },
    });

    await page.getByRole("button").click();
    await page.getByRole("menuitemradio", { name: "1M" }).click();

    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider.claudeAgent,
    ).toMatchObject({
      provider: "claudeAgent",
      options: {
        contextWindow: "1m",
      },
    });
  });
});

// ── Codex TraitsPicker tests ──────────────────────────────────────────

async function mountCodexPicker(props: { model?: string; options?: CodexModelOptions }) {
  const threadId = ThreadId.makeUnsafe("thread-codex-traits");
  const model = props.model ?? DEFAULT_MODEL_BY_PROVIDER.codex;
  const draftsByThreadId: Record<ThreadId, ComposerThreadDraftState> = {
    [threadId]: {
      prompt: "",
      images: [],
      nonPersistedImageIds: [],
      persistedAttachments: [],
      assistantSelections: [],
      terminalContexts: [],
      queuedTurns: [],
      modelSelectionByProvider: {
        codex: {
          provider: "codex",
          model,
          ...(props.options ? { options: props.options } : {}),
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
    projectDraftThreadIdByProjectId: {
      [ProjectId.makeUnsafe("project-codex-traits")]: threadId,
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <TraitsPicker
      provider="codex"
      threadId={threadId}
      model={props.model ?? DEFAULT_MODEL_BY_PROVIDER.codex}
      prompt=""
      modelOptions={props.options}
      onPromptChange={() => {}}
    />,
    { container: host },
  );

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
  };
}

describe("TraitsPicker (Codex)", () => {
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

  it("shows fast mode controls", async () => {
    await using _ = await mountCodexPicker({
      options: { fastMode: false },
    });

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Fast Mode");
      expect(text).toContain("off");
      expect(text).toContain("on");
    });
  });

  it("shows Fast in the trigger label when fast mode is active", async () => {
    await using _ = await mountCodexPicker({
      options: { fastMode: true },
    });

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toMatch(/Medium\s*·\s*Fast/u);
    });
  });

  it("shows only the provided effort options", async () => {
    await using _ = await mountCodexPicker({
      options: { fastMode: false },
    });

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Low");
      expect(text).toContain("Medium");
      expect(text).toContain("High");
      expect(text).toContain("Extra High");
    });
  });

  it("closes after clicking the already-selected effort", async () => {
    await using _ = await mountCodexPicker({
      options: { reasoningEffort: "medium", fastMode: false },
    });

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("Effort");
    });

    await page.getByRole("menuitemradio", { name: "Medium" }).click();

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").not.toContain("Effort");
    });
  });

  it("persists sticky codex model options when traits change", async () => {
    await using _ = await mountCodexPicker({
      options: { fastMode: false },
    });

    await page.getByRole("button").click();
    await page.getByRole("menuitemradio", { name: "on" }).click();

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex).toMatchObject({
      provider: "codex",
      options: { fastMode: true },
    });
  });
});

// ── OpenCode TraitsPicker tests ───────────────────────────────────────

const OPENCODE_THREAD_ID = ThreadId.makeUnsafe("thread-opencode-traits");
const OPENCODE_RUNTIME_MODEL_WITH_REASONING: ProviderModelDescriptor = {
  slug: "openai/gpt-5.4",
  name: "GPT-5.4",
  upstreamProviderId: "openai",
  upstreamProviderName: "OpenAI",
  supportedReasoningEfforts: [
    { value: "none" },
    { value: "low" },
    { value: "medium" },
    { value: "high" },
    { value: "xhigh" },
  ],
  defaultReasoningEffort: "medium",
};

const OPENCODE_RUNTIME_MODEL_WITHOUT_DEFAULT: ProviderModelDescriptor = {
  slug: "opencode/gpt-5-nano",
  name: "GPT-5 Nano",
  upstreamProviderId: "opencode",
  upstreamProviderName: "OpenCode",
  supportedReasoningEfforts: [
    { value: "minimal" },
    { value: "low" },
    { value: "medium" },
    { value: "high" },
  ],
};

function OpenCodeTraitsPickerHarness(props: {
  model: string;
  runtimeModel?: ProviderModelDescriptor;
  fallbackModelSelection: ModelSelection | null;
}) {
  const prompt = useComposerThreadDraft(OPENCODE_THREAD_ID).prompt;
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const { modelOptions, selectedModel } = useEffectiveComposerModelState({
    threadId: OPENCODE_THREAD_ID,
    selectedProvider: "opencode",
    threadModelSelection: props.fallbackModelSelection,
    projectModelSelection: null,
    customModelsByProvider: { codex: [], claudeAgent: [], gemini: [], opencode: [] },
  });
  const handlePromptChange = useCallback(
    (nextPrompt: string) => {
      setPrompt(OPENCODE_THREAD_ID, nextPrompt);
    },
    [setPrompt],
  );

  return (
    <TraitsPicker
      provider="opencode"
      threadId={OPENCODE_THREAD_ID}
      model={selectedModel ?? props.model}
      runtimeModel={props.runtimeModel}
      prompt={prompt}
      modelOptions={modelOptions?.opencode}
      onPromptChange={handlePromptChange}
    />
  );
}

async function mountOpenCodePicker(props?: {
  model?: string;
  options?: OpenCodeModelOptions;
  runtimeModel?: ProviderModelDescriptor;
  fallbackModelOptions?: OpenCodeModelOptions | null;
}) {
  const model = props?.model ?? DEFAULT_MODEL_BY_PROVIDER.opencode;
  const draftsByThreadId: Record<ThreadId, ComposerThreadDraftState> = {
    [OPENCODE_THREAD_ID]: {
      prompt: "",
      images: [],
      nonPersistedImageIds: [],
      persistedAttachments: [],
      terminalContexts: [],
      queuedTurns: [],
      assistantSelections: [],
      modelSelectionByProvider: {
        opencode: {
          provider: "opencode",
          model,
          ...(props?.options ? { options: props.options } : {}),
        },
      },
      activeProvider: "opencode",
      runtimeMode: null,
      interactionMode: null,
    },
  };

  useComposerDraftStore.setState({
    draftsByThreadId,
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
  });
  const host = document.createElement("div");
  document.body.append(host);
  const fallbackModelSelection: ModelSelection = {
    provider: "opencode",
    model,
    ...(props?.fallbackModelOptions ? { options: props.fallbackModelOptions } : {}),
  };
  const screen = await render(
    <OpenCodeTraitsPickerHarness
      model={model}
      {...(props?.runtimeModel ? { runtimeModel: props.runtimeModel } : {})}
      fallbackModelSelection={fallbackModelSelection}
    />,
    { container: host },
  );

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };

  return {
    host,
    [Symbol.asyncDispose]: cleanup,
    cleanup,
  };
}

describe("TraitsPicker (OpenCode)", () => {
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

  it("does not render an empty traits trigger when the model exposes no controls", async () => {
    await using mounted = await mountOpenCodePicker({
      model: "openrouter/gpt-oss-120b:free",
    });

    await vi.waitFor(() => {
      expect(mounted.host.textContent ?? "").toBe("");
      expect(mounted.host.querySelector("button")).toBeNull();
    });
  });

  it("shows the runtime default thinking level in the trigger label", async () => {
    await using mounted = await mountOpenCodePicker({
      model: "openai/gpt-5.4",
      runtimeModel: OPENCODE_RUNTIME_MODEL_WITH_REASONING,
    });

    await vi.waitFor(() => {
      const text = mounted.host.textContent ?? "";
      expect(text).toContain("Medium");
      expect(text).not.toMatch(/\bThinking\b/u);
    });
  });

  it("falls back to the first runtime variant label when OpenCode does not expose a default", async () => {
    await using mounted = await mountOpenCodePicker({
      model: "opencode/gpt-5-nano",
      runtimeModel: OPENCODE_RUNTIME_MODEL_WITHOUT_DEFAULT,
    });

    await vi.waitFor(() => {
      const text = mounted.host.textContent ?? "";
      expect(text).toContain("Minimal");
      expect(text).not.toMatch(/\bThinking\b/u);
    });
  });

  it("persists sticky OpenCode variants when the thinking level changes", async () => {
    await using mounted = await mountOpenCodePicker({
      model: "openai/gpt-5.4",
      runtimeModel: OPENCODE_RUNTIME_MODEL_WITH_REASONING,
    });

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Variant");
      expect(text).toContain("High");
    });

    await page.getByRole("menuitemradio", { name: /^High$/u }).click();

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.opencode).toMatchObject({
      provider: "opencode",
      options: {
        variant: "high",
      },
    });

    await vi.waitFor(() => {
      expect(mounted.host.textContent ?? "").toContain("High");
    });
  });
});

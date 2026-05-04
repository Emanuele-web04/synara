import { DEFAULT_MODEL_BY_PROVIDER, ModelSelection, ThreadId } from "@t3tools/contracts";
import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { TraitsMenuContent } from "./TraitsPicker";
import { useComposerDraftStore } from "../../composerDraftStore";

async function mountMenu(props?: {
  activePlan?: boolean;
  interactionMode?: "default" | "plan";
  modelSelection?: ModelSelection;
  prompt?: string;
}) {
  const threadId = ThreadId.makeUnsafe("thread-compact-menu");
  const provider = props?.modelSelection?.provider ?? "claudeAgent";
  const draftsByThreadId = {} as ReturnType<
    typeof useComposerDraftStore.getState
  >["draftsByThreadId"];
  const model = props?.modelSelection?.model ?? DEFAULT_MODEL_BY_PROVIDER[provider];

  draftsByThreadId[threadId] = {
    prompt: props?.prompt ?? "",
    images: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    assistantSelections: [],
    terminalContexts: [],
    queuedTurns: [],
    modelSelectionByProvider: {
      [provider]: {
        provider,
        model,
        ...(props?.modelSelection?.options ? { options: props.modelSelection.options } : {}),
      },
    },
    activeProvider: provider,
    runtimeMode: null,
    interactionMode: null,
  };
  useComposerDraftStore.setState({
    draftsByThreadId,
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
  });
  const host = document.createElement("div");
  document.body.append(host);
  const onPromptChange = vi.fn();
  const providerOptions = props?.modelSelection?.options;
  const screen = await render(
    <CompactComposerControlsMenu
      activePlan={props?.activePlan ?? false}
      interactionMode={props?.interactionMode ?? "default"}
      planSidebarOpen={false}
      runtimeMode="approval-required"
      traitsMenuContent={
        <TraitsMenuContent
          provider={provider}
          threadId={threadId}
          model={model}
          prompt={props?.prompt ?? ""}
          modelOptions={providerOptions}
          onPromptChange={onPromptChange}
        />
      }
      onToggleInteractionMode={vi.fn()}
      onTogglePlanSidebar={vi.fn()}
      onToggleRuntimeMode={vi.fn()}
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

describe("CompactComposerControlsMenu", () => {
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
    await using _ = await mountMenu({
      modelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
    });

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Fast Mode");
      expect(text).toContain("Default");
      expect(text).toContain("Fast");
    });
  });

  it("hides fast mode controls for non-Opus Claude models", async () => {
    await using _ = await mountMenu({
      modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
    });

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").not.toContain("Fast Mode");
    });
  });

  it("shows only the provided effort options", async () => {
    await using _ = await mountMenu({
      modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
    });

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Low");
      expect(text).toContain("Medium");
      expect(text).toContain("High");
      expect(text).toContain("Max");
      expect(text).toContain("Ultrathink");
    });
  });

  it("shows a Claude thinking on/off section for Haiku", async () => {
    await using _ = await mountMenu({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-haiku-4-5",
        options: { thinking: true },
      },
    });

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Thinking");
      expect(text).toContain("On (default)");
      expect(text).toContain("Off");
    });
  });

  it("shows prompt-controlled Ultrathink messaging with disabled effort controls", async () => {
    await using _ = await mountMenu({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: { effort: "high" },
      },
      prompt: "Ultrathink:\nInvestigate this",
    });

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Effort");
      expect(text).toContain("Remove Ultrathink from the prompt to change effort.");
      expect(text).not.toContain("Fallback Effort");
    });
  });

  it("shows both build and plan mode options", async () => {
    await using _ = await mountMenu();

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Build");
      expect(text).toContain("Plan");
    });
  });

  it("shows the plan sidebar toggle when a plan is active", async () => {
    await using _ = await mountMenu({
      activePlan: true,
      interactionMode: "plan",
    });

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("Show plan sidebar");
    });
  });
});

// Accepting a multi-row composer prediction with Tab, in a composer that floats over a
// transcript following its end: the swap from ghost text to draft must not pass through a
// collapsed composer, or the reader at the end is left short of it.

import "../../index.css";

import type { LegendListRef } from "@legendapp/list/react";
import { ThreadId, TurnId } from "@synara/contracts";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { collapseExpandedComposerCursor } from "../../composer-logic";
import { useComposerPrediction } from "../../hooks/useComposerPrediction";
import {
  composerPredictionStore,
  shouldAcceptComposerPredictionOnTab,
  type ComposerPredictionTarget,
} from "../../lib/composerPrediction";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { composerTranscriptBottomInsetPx, useComposerOverlayHeight } from "./composerOverlay";
import {
  COMPOSER_EDITOR_PADDING_CLASS_NAME,
  COMPOSER_INPUT_SURFACE_CLASS_NAME,
  COMPOSER_SINGLE_ROW_EDITOR_CLASS_NAME,
  COMPOSER_SINGLE_ROW_SURFACE_CLASS_NAME,
} from "./composerPickerStyles";
import { useChatTranscriptScroll } from "./useChatTranscriptScroll";
import { useComposerSingleRow } from "./useComposerSingleRow";

const nativeApi = vi.hoisted(() => ({ suggestion: "" }));
vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({
    server: {
      generateComposerPrediction: async () => ({ suggestion: nativeApi.suggestion }),
    },
  }),
}));

const THREAD_ID = ThreadId.makeUnsafe("thread-accept");
const TARGET: ComposerPredictionTarget = {
  key: "accept-key",
  threadId: THREAD_ID,
  turnId: TurnId.makeUnsafe("turn-accept"),
};
const EMPTY_TIMELINE: [] = [];
// Wraps past the three rows the ghost shows at this width, so the draft is taller still.
const LONG_SUGGESTION =
  "ok go ahead with the first two steps, but leave the third out for now, I do not want to touch the production table until we have a backup. tell me when both are done so I can check, then rerun the migration dry run against staging and open the pull request";

const waitForFrames = (count = 3) =>
  new Promise<void>((resolve) => {
    const step = (left: number) =>
      left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1));
    step(count);
  });

function AcceptHarness() {
  const formRef = useRef<HTMLFormElement>(null);
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const listRef = useRef({
    scrollToEnd: async () => {
      const node = transcriptRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    },
    getScrollableNode: () => transcriptRef.current,
  } as unknown as LegendListRef);
  const [prompt, setPrompt] = useState("");
  const [cursor, setCursor] = useState(0);
  const prediction = useComposerPrediction({
    target: TARGET,
    canShow: prompt.length === 0,
    prompt,
  });
  const singleRow = useComposerSingleRow({
    formRef,
    eligible: true,
    prompt,
    prediction: prediction.ghost,
  });
  const { overlayRef, overlayHeightPx } = useComposerOverlayHeight();
  const insetPx = composerTranscriptBottomInsetPx(overlayHeightPx);
  useChatTranscriptScroll({
    activeThreadId: THREAD_ID,
    legendListRef: listRef,
    timelineEntries: EMPTY_TIMELINE,
    hasStreamingAssistantText: false,
    composerTranscriptInsetPx: insetPx,
    isInactiveSplitPane: false,
  });

  // The chat's Tab branch: accept on the editor's current state, write the full draft.
  const onCommandKeyDown = (key: string, event: KeyboardEvent) => {
    if (key !== "Tab") return false;
    const editor = editorRef.current;
    const visible = prediction.controller.readVisible();
    if (
      !editor ||
      !visible ||
      !shouldAcceptComposerPredictionOnTab({
        event,
        editorFocused: editor.isFocused(),
        snapshot: editor.readSnapshot(),
        prediction: visible,
        entry: prediction.controller.readEntry(visible.key),
      })
    ) {
      return false;
    }
    prediction.controller.accept(visible);
    setPrompt(visible.suggestion);
    setCursor(collapseExpandedComposerCursor(visible.suggestion, visible.suggestion.length));
    return true;
  };

  return (
    <div style={{ position: "relative", width: 640, height: 480 }}>
      <div data-testid="transcript" ref={transcriptRef} style={{ height: 480, overflow: "auto" }}>
        <div style={{ height: 2000, paddingBottom: insetPx }} />
      </div>
      <div ref={overlayRef} style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
        <form ref={formRef} data-testid="accept-form" data-layout={singleRow ? "row" : "block"}>
          <div
            data-chat-composer-surface=""
            className={`${COMPOSER_INPUT_SURFACE_CLASS_NAME} ${singleRow ? COMPOSER_SINGLE_ROW_SURFACE_CLASS_NAME : ""}`}
          >
            <div
              className={
                singleRow
                  ? COMPOSER_SINGLE_ROW_EDITOR_CLASS_NAME
                  : COMPOSER_EDITOR_PADDING_CLASS_NAME
              }
            >
              <ComposerPromptEditor
                ref={editorRef}
                value={prompt}
                cursor={cursor}
                terminalContexts={[]}
                disabled={false}
                placeholder="Ask for follow-up changes"
                prediction={prediction.ghost}
                singleLine={singleRow}
                onRemoveTerminalContext={() => {}}
                onPaste={() => {}}
                onChange={(nextValue, nextCursor) => {
                  setPrompt(nextValue);
                  setCursor(nextCursor);
                }}
                onCommandKeyDown={onCommandKeyDown}
              />
            </div>
            {/* The row keeps its controls beside the editor; the block adds a footer row. */}
            {singleRow ? (
              <button type="button" className="col-start-3 row-start-1">
                Send
              </button>
            ) : (
              <div style={{ height: 40 }}>
                <button type="button">Send</button>
              </div>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

const transcript = () => document.querySelector<HTMLElement>('[data-testid="transcript"]')!;
const gapFromEnd = () => {
  const node = transcript();
  return node.scrollHeight - node.clientHeight - node.scrollTop;
};
const ghostRows = () => {
  const ghost = document.querySelector<HTMLElement>('[data-testid="composer-prediction"]');
  if (!ghost) return 0;
  return Math.round(
    ghost.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(ghost).lineHeight),
  );
};

/** The composer layout of every frame painted until `stop`. */
function recordPaintedLayouts() {
  const form = document.querySelector<HTMLElement>('[data-testid="accept-form"]')!;
  const layouts: string[] = [];
  let frame = requestAnimationFrame(function sample() {
    layouts.push(form.getAttribute("data-layout") ?? "");
    frame = requestAnimationFrame(sample);
  });
  return {
    stop: () => {
      cancelAnimationFrame(frame);
      return layouts;
    },
  };
}

async function mountWithSuggestion(suggestion: string) {
  nativeApi.suggestion = suggestion;
  await render(<AcceptHarness />);
  await expect.poll(() => ghostRows()).toBeGreaterThan(0);
  await waitForFrames();
}

describe("accepting a composer prediction with Tab", () => {
  beforeEach(async () => {
    await page.viewport(800, 600);
    composerPredictionStore.setState({ entries: new Map(), settledKeys: new Set() });
  });
  afterEach(cleanup);

  it("keeps a reader at the end exactly at the end when a multi-row suggestion is accepted", async () => {
    await mountWithSuggestion(LONG_SUGGESTION);
    expect(ghostRows()).toBe(3);
    expect(document.querySelector('[data-testid="accept-form"]')!.getAttribute("data-layout")).toBe(
      "block",
    );
    transcript().scrollTop = transcript().scrollHeight;
    await waitForFrames();
    expect(gapFromEnd()).toBeLessThan(1);

    document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!.focus();
    const paintedLayouts = recordPaintedLayouts();
    await userEvent.keyboard("{Tab}");
    await expect
      .poll(() => document.querySelector('[data-testid="composer-editor"]')!.textContent)
      .toBe(LONG_SUGGESTION);
    await waitForFrames(6);

    // Never painted as the collapsed single row on the way from ghost to draft.
    expect(paintedLayouts.stop()).not.toContain("row");
    expect(gapFromEnd()).toBeLessThan(1);
    expect(document.querySelector('[data-testid="composer-prediction"]')).toBeNull();
    expect(composerPredictionStore.getState().entries.get(TARGET.key)?.status).toBe("done");
  });

  it("leaves a reader who scrolled up where they were", async () => {
    await mountWithSuggestion(LONG_SUGGESTION);
    transcript().scrollTop = 150;
    await waitForFrames();

    document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!.focus();
    await userEvent.keyboard("{Tab}");
    await expect
      .poll(() => document.querySelector('[data-testid="composer-editor"]')!.textContent)
      .toBe(LONG_SUGGESTION);
    await waitForFrames(6);

    expect(transcript().scrollTop).toBe(150);
  });

  it("accepts a one-row suggestion without moving the composer", async () => {
    await mountWithSuggestion("Rerun that test.");
    const form = document.querySelector<HTMLElement>('[data-testid="accept-form"]')!;
    expect(form.getAttribute("data-layout")).toBe("row");
    transcript().scrollTop = transcript().scrollHeight;
    await waitForFrames();
    const height = form.getBoundingClientRect().height;

    document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!.focus();
    await userEvent.keyboard("{Tab}");
    await expect
      .poll(() => document.querySelector('[data-testid="composer-editor"]')!.textContent)
      .toBe("Rerun that test.");
    await waitForFrames(6);

    expect(form.getAttribute("data-layout")).toBe("row");
    expect(form.getBoundingClientRect().height).toBeCloseTo(height, 1);
    expect(gapFromEnd()).toBeLessThan(1);
  });
});

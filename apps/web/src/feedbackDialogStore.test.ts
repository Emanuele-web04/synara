import { beforeEach, describe, expect, it } from "vitest";

import type { FeedbackThreadContext } from "./feedback";
import { useFeedbackDialogStore } from "./feedbackDialogStore";

const THREAD_CONTEXT: FeedbackThreadContext = {
  provider: "codex",
  model: "gpt-5.6-sol",
  projectKind: "project",
  environmentMode: "worktree",
  runtimeMode: "full-access",
  interactionMode: "default",
  sessionStatus: "running",
  latestTurnState: "error",
  messageCount: 12,
  activityCount: 8,
  hasPendingApproval: false,
  hasPendingUserInput: true,
  hasThreadError: true,
};

describe("feedbackDialogStore", () => {
  beforeEach(() => {
    useFeedbackDialogStore.setState({ isOpen: false, context: null });
  });

  it("opens with the thread context a caller supplies", () => {
    useFeedbackDialogStore.getState().openDialog(THREAD_CONTEXT);

    const state = useFeedbackDialogStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.context).toEqual(THREAD_CONTEXT);
  });

  it("stores no context when the caller supplies none", () => {
    useFeedbackDialogStore.getState().openDialog();

    const state = useFeedbackDialogStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.context).toBeNull();
  });

  it("drops a click event passed as the context instead of storing it", () => {
    // Sidebar menu rows wire the raw action into `onClick`, so React hands it a
    // MouseEvent-shaped value at runtime regardless of the declared type. Its
    // `view` self-reference is what made the submission body unserializable.
    const view: Record<string, unknown> = {};
    view.window = view;
    const clickEventLike = {
      type: "click",
      nativeEvent: {},
      view,
    } as unknown as FeedbackThreadContext;

    useFeedbackDialogStore.getState().openDialog(clickEventLike);

    const state = useFeedbackDialogStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.context).toBeNull();
  });

  it("clears the stored context when the dialog closes", () => {
    useFeedbackDialogStore.getState().openDialog(THREAD_CONTEXT);
    useFeedbackDialogStore.getState().setOpen(false);

    const state = useFeedbackDialogStore.getState();
    expect(state.isOpen).toBe(false);
    expect(state.context).toBeNull();
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import type { FeedbackCategory } from "./feedback";
import { useFeedbackDialogStore } from "./feedbackDialogStore";

describe("feedbackDialogStore", () => {
  beforeEach(() => useFeedbackDialogStore.setState({ isOpen: false, initialCategory: null }));

  it("opens an explicit category without retaining thread context", () => {
    useFeedbackDialogStore.getState().openDialog("bug");
    const state = useFeedbackDialogStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.initialCategory).toBe("bug");
    expect(state).not.toHaveProperty("context");
  });

  it("ignores a click event instead of retaining it as report data", () => {
    const view: Record<string, unknown> = {};
    view.window = view;
    useFeedbackDialogStore
      .getState()
      .openDialog({ type: "click", view } as unknown as FeedbackCategory);
    expect(useFeedbackDialogStore.getState().initialCategory).toBeNull();
    expect(useFeedbackDialogStore.getState()).not.toHaveProperty("context");
  });

  it("clears the initial category on close and reopens with no inferred category", () => {
    useFeedbackDialogStore.getState().openDialog("bug");
    useFeedbackDialogStore.getState().setOpen(false);
    expect(useFeedbackDialogStore.getState()).toMatchObject({
      isOpen: false,
      initialCategory: null,
    });
    useFeedbackDialogStore.getState().openDialog();
    expect(useFeedbackDialogStore.getState()).toMatchObject({
      isOpen: true,
      initialCategory: null,
    });
  });
});

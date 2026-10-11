import "../../index.css";
import { ApprovalRequestId, MessageId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { AsyncUserInputCard } from "./AsyncUserInputCard";

const prompt = {
  requestId: ApprovalRequestId.makeUnsafe("blocking-question"),
  createdAt: "2026-09-15T00:00:00Z",
  questions: [
    {
      id: "question",
      header: "Choose",
      question: "Which option?",
      multiSelect: false,
      options: [
        { label: "First", description: "First" },
        { label: "Second", description: "Second" },
      ],
    },
  ],
};

const props = () => ({
  pendingUserInputs: [prompt],
  answers: {},
  questionIndex: 0,
  submissionVersion: 0,
  isResponding: false,
  onToggleOption: vi.fn((_questionId: string, label: string) => ({
    selectedOptionLabels: [label],
  })),
  onAdvance: vi.fn(),
  onPrevious: vi.fn(),
  onCancel: vi.fn(),
});

describe("shared question form with blocking prompts", () => {
  it("offers Cancel with choices and stops pending auto-advance", async () => {
    const callbacks = props();
    const screen = await render(<ComposerPendingUserInputPanel {...callbacks} />);
    await expect.element(screen.getByRole("button", { name: /Second/ })).toBeVisible();
    // Synchronous DOM clicks: the 200ms single-select auto-advance must not
    // beat the input pipeline, or the cancel races question 2 rendering. An
    // awaited locator click would leave a task boundary the timer could slip
    // through under load.
    const choiceButton = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Second"),
    );
    expect(choiceButton, "Second choice button not found").toBeDefined();
    choiceButton!.click();
    const cancelButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Cancel",
    );
    expect(cancelButton, "Cancel button not found").toBeDefined();
    cancelButton!.click();
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(callbacks.onAdvance).not.toHaveBeenCalled();
  });

  it("keeps Cancel available when a question has no choices", async () => {
    const callbacks = props();
    const noChoicePrompt = {
      ...prompt,
      questions: [{ ...prompt.questions[0]!, options: [] }],
    };
    const screen = await render(
      <ComposerPendingUserInputPanel {...callbacks} pendingUserInputs={[noChoicePrompt]} />,
    );
    await screen.getByRole("button", { name: "Cancel" }).click();
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
  });

  it("preserves global digit shortcuts and advances with the newly selected answer", async () => {
    const callbacks = props();
    await render(<ComposerPendingUserInputPanel {...callbacks} />);
    await userEvent.keyboard("2");
    expect(callbacks.onToggleOption).toHaveBeenCalledExactlyOnceWith("question", "Second");
    await expect
      .poll(() => callbacks.onAdvance.mock.calls)
      .toEqual([[{ question: { selectedOptionLabels: ["Second"] } }]]);
  });

  it("cancels delayed choice advancement when a response starts", async () => {
    const callbacks = props();
    const screen = await render(<ComposerPendingUserInputPanel {...callbacks} />);
    await screen.getByRole("button", { name: /Second/ }).click();
    await screen.rerender(
      <ComposerPendingUserInputPanel {...callbacks} isResponding submissionVersion={1} />,
    );
    await expect.element(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(callbacks.onAdvance).not.toHaveBeenCalled();
  });

  it("does not consume shortcuts from an open async form", async () => {
    const callbacks = props();
    const screen = await render(
      <>
        <AsyncUserInputCard
          messageId={MessageId.makeUnsafe("async")}
          input={{ questions: [{ title: "Async question?", options: ["Only choice"] }] }}
          onRespond={vi.fn()}
        />
        <ComposerPendingUserInputPanel {...callbacks} />
      </>,
    );
    await screen.getByRole("button", { name: "1 question", exact: true }).click();
    await screen.getByRole("button", { name: /Only choice/ }).click();
    await userEvent.keyboard("2");
    expect(callbacks.onToggleOption).not.toHaveBeenCalled();
  });
});

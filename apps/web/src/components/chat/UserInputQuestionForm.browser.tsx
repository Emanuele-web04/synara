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

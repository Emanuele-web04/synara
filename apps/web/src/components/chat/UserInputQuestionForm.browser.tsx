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
    await screen.getByRole("button", { name: /Second/ }).click();
    await screen.getByRole("button", { name: "Cancel" }).click();
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

  it("submits the selected opaque value when two options share a label", async () => {
    const callbacks = props();
    const duplicateLabels = {
      ...prompt,
      questions: [
        {
          ...prompt.questions[0]!,
          allowCustomAnswer: false,
          options: [
            { label: "Continue", description: "First planner", value: "planner-a" },
            { label: "Continue", description: "Second planner", value: " planner-b " },
          ],
        },
      ],
    };
    const screen = await render(
      <ComposerPendingUserInputPanel {...callbacks} pendingUserInputs={[duplicateLabels]} />,
    );
    await screen.getByRole("button", { name: /Second planner/ }).click();
    await expect
      .poll(() => callbacks.onAdvance.mock.calls)
      .toEqual([[{ question: { selectedOptionLabels: [" planner-b "] } }]]);
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

it("lays out Arabic and Hebrew questions from the right while keeping navigation left-to-right", async () => {
  const callbacks = props();
  const arabic = {
    ...prompt.questions[0]!,
    question: "أي خيار تفضّل؟",
    options: [
      { label: "الخيار الأول", description: "وصف قصير" },
      { label: "English option", description: "Description" },
    ],
  };
  const hebrew = { ...arabic, id: "hebrew", question: "איזו אפשרות עדיפה?" };
  const screen = await render(
    <div dir="ltr" className="w-[28rem]">
      <ComposerPendingUserInputPanel
        {...callbacks}
        pendingUserInputs={[{ ...prompt, questions: [arabic, hebrew] }]}
      />
    </div>,
  );
  const question = screen.getByText(arabic.question).element();
  const previous = screen.getByRole("button", { name: "Previous question" }).element();
  const next = screen.getByRole("button", { name: "Next question" }).element();
  expect(getComputedStyle(question).direction).toBe("rtl");
  expect(getComputedStyle(previous).direction).toBe("ltr");
  expect(question.getBoundingClientRect().left).toBeGreaterThan(next.getBoundingClientRect().right);
  expect(previous.getBoundingClientRect().left).toBeLessThan(next.getBoundingClientRect().left);

  const rtlOption = screen.getByRole("button", { name: /الخيار الأول/ }).element();
  const english = screen.getByRole("button", { name: /English option/ }).element();
  expect(getComputedStyle(rtlOption).direction).toBe("rtl");
  expect(getComputedStyle(english).direction).toBe("ltr");
  expect(rtlOption.firstElementChild!.getBoundingClientRect().left).toBeGreaterThan(
    rtlOption.getBoundingClientRect().left + rtlOption.getBoundingClientRect().width / 2,
  );
  expect(english.firstElementChild!.getBoundingClientRect().right).toBeLessThan(
    english.getBoundingClientRect().left + english.getBoundingClientRect().width / 2,
  );
  expect(getComputedStyle(screen.getByRole("button", { name: "Cancel" }).element()).direction).toBe(
    "ltr",
  );

  await screen.rerender(
    <ComposerPendingUserInputPanel
      {...callbacks}
      questionIndex={1}
      pendingUserInputs={[{ ...prompt, questions: [arabic, hebrew] }]}
    />,
  );
  expect(getComputedStyle(screen.getByText(hebrew.question).element()).direction).toBe("rtl");
});

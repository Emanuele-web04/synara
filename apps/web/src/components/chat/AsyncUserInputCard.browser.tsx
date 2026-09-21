import "../../index.css";
import { MessageId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import { AsyncUserInputCard } from "./AsyncUserInputCard";

const messageId = MessageId.makeUnsafe("async-question");
const input = {
  questions: [
    { title: "When does the bug happen?", options: ["On launch", "On reconnect"] },
    { title: "Any other details?" },
  ],
};

describe("AsyncUserInputCard", () => {
  it("reopens after rollback even when this client has an optimistic accepted answer", async () => {
    const questions = [{ title: "Which option?", options: ["A", "B"] }];
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const screen = await render(
      <AsyncUserInputCard messageId={messageId} input={{ questions }} onRespond={onRespond} />,
    );
    await screen.getByRole("button", { name: "1 question", exact: true }).click();
    await screen.getByRole("button", { name: "Send answer" }).click();
    await expect.element(screen.getByText("Answered", { exact: true })).toBeVisible();
    await screen.rerender(
      <AsyncUserInputCard
        messageId={messageId}
        input={{ questions, responseSequence: 10 }}
        onRespond={onRespond}
      />,
    );
    await expect.element(screen.getByText("Answered", { exact: true })).not.toBeInTheDocument();
    await screen.getByRole("button", { name: /B/ }).click();
    await screen.getByRole("button", { name: "Send answer" }).click();
    expect(onRespond).toHaveBeenLastCalledWith(messageId, ["B"]);
  });
  it("requires an explicit submission, allows free text, and prevents double clicks", async () => {
    let accept!: () => void;
    const onRespond = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    const screen = await render(
      <div className="max-w-xl p-4">
        <AsyncUserInputCard messageId={messageId} input={input} onRespond={onRespond} />
        <textarea aria-label="Conversation composer" />
      </div>,
    );
    const capsule = screen.getByRole("button", { name: "2 questions", exact: true });
    await expect.element(capsule).toHaveAttribute("aria-expanded", "false");
    await expect.element(screen.getByRole("form")).not.toBeInTheDocument();
    await capsule.click();
    await expect
      .element(screen.getByRole("button", { name: /On launch/ }))
      .toHaveAttribute("aria-pressed", "true");
    expect(onRespond).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: /On reconnect/ }).click();
    await screen.getByRole("button", { name: "Next", exact: true }).click();
    await expect.element(screen.getByRole("button", { name: "Send answer" })).toBeDisabled();
    await screen
      .getByRole("textbox", { name: "Answer: Any other details?" })
      .fill("Only after waking from sleep");
    await screen
      .getByRole("textbox", { name: "Conversation composer" })
      .fill("Keep checking the logs.");
    await capsule.click();
    await expect.element(capsule).toHaveAttribute("aria-expanded", "false");
    await capsule.click();
    await expect
      .element(screen.getByRole("textbox", { name: "Answer: Any other details?" }))
      .toHaveValue("Only after waking from sleep");
    await screen.getByRole("button", { name: "Previous question" }).click();
    await expect
      .element(screen.getByRole("button", { name: /On reconnect/ }))
      .toHaveAttribute("aria-pressed", "true");
    await screen.getByRole("button", { name: "Next", exact: true }).click();
    await screen.getByRole("button", { name: "Send answer" }).click();
    await expect.element(screen.getByRole("button", { name: "Submitting…" })).toBeDisabled();
    expect(onRespond).toHaveBeenCalledExactlyOnceWith(messageId, [
      "On reconnect",
      "Only after waking from sleep",
    ]);
    accept();
    await expect.element(screen.getByText("Answered", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByRole("textbox", { name: "Conversation composer" }))
      .toHaveValue("Keep checking the logs.");
  });

  it("restores an answered card and keeps rejected submissions editable", async () => {
    const onRespond = vi.fn().mockRejectedValue(new Error("Connection interrupted"));
    const screen = await render(
      <AsyncUserInputCard
        messageId={messageId}
        input={{ questions: [{ title: "More details?" }] }}
        onRespond={onRespond}
      />,
    );
    await screen.getByRole("button", { name: "1 question", exact: true }).click();
    await screen.getByRole("textbox").fill("Custom answer");
    await screen.getByRole("button", { name: "Send answer" }).click();
    await expect.element(screen.getByRole("alert")).toHaveTextContent("Connection interrupted");
    await expect.element(screen.getByRole("textbox")).toHaveValue("Custom answer");
    await screen.rerender(
      <AsyncUserInputCard
        messageId={messageId}
        input={{
          questions: [{ title: "More details?" }],
          response: { messageId: MessageId.makeUnsafe("answer"), answers: ["Answered elsewhere"] },
        }}
        onRespond={onRespond}
      />,
    );
    await expect.element(screen.getByText("Answered elsewhere")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Send answer" }))
      .not.toBeInTheDocument();
  });

  it("keeps shortcuts local to the opened question and never submits a suggested choice", async () => {
    const onRespond = vi.fn();
    const screen = await render(
      <div>
        <AsyncUserInputCard
          messageId={messageId}
          input={{ questions: [{ title: "First?", options: ["Alpha", "Beta"] }] }}
          onRespond={onRespond}
        />
        <AsyncUserInputCard
          messageId={MessageId.makeUnsafe("second")}
          input={{ questions: [{ title: "Second?", options: ["Gamma", "Delta"] }] }}
          onRespond={onRespond}
        />
        <textarea aria-label="Conversation composer" />
      </div>,
    );
    await screen.getByRole("button", { name: "1 question", exact: true }).nth(0).click();
    await screen.getByRole("button", { name: "1 question", exact: true }).nth(1).click();
    await screen.getByRole("button", { name: /Alpha/ }).click();
    await userEvent.keyboard("2");
    await expect
      .element(screen.getByRole("button", { name: /Beta/ }))
      .toHaveAttribute("aria-pressed", "true");
    await expect
      .element(screen.getByRole("button", { name: /Gamma/ }))
      .toHaveAttribute("aria-pressed", "true");
    await screen.getByRole("textbox", { name: "Conversation composer" }).fill("123");
    await expect
      .element(screen.getByRole("button", { name: /Beta/ }))
      .toHaveAttribute("aria-pressed", "true");
    expect(onRespond).not.toHaveBeenCalled();
  });
});

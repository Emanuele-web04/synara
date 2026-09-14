import "../../index.css";
import { MessageId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { AsyncUserInputCard } from "./AsyncUserInputCard";

const messageId = MessageId.makeUnsafe("async-question");
const input = {
  questions: [
    { title: "When does the bug happen?", options: ["On launch", "On reconnect"] },
    { title: "Any other details?" },
  ],
};

describe("AsyncUserInputCard", () => {
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
    await expect
      .element(screen.getByRole("button", { name: "On launch" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(onRespond).not.toHaveBeenCalled();
    await expect.element(screen.getByRole("button", { name: "Send answer" })).toBeDisabled();
    await screen.getByRole("button", { name: "On reconnect" }).click();
    await screen
      .getByRole("textbox", { name: "Answer: Any other details?" })
      .fill("Only after waking from sleep");
    await screen
      .getByRole("textbox", { name: "Conversation composer" })
      .fill("Keep checking the logs.");
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
});

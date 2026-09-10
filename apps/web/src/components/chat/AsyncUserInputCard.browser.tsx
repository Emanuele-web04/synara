import "../../index.css";
import { EventId, MessageId } from "@synara/contracts";
import type { AsyncUserInputActivity } from "@synara/shared/asyncUserInput";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { AsyncUserInputCard } from "./AsyncUserInputCard";

const question: AsyncUserInputActivity = {
  id: EventId.makeUnsafe("question-1"), kind: "user-input.async", tone: "info",
  summary: "Question from Codex", createdAt: "2026-09-10T12:00:00.000Z", turnId: null,
  payload: { questions: [
    { title: "Which interaction triggers the problem?", options: ["Switching tabs", "Scrolling"] },
    { title: "What else should I know?", options: null },
  ] },
};

it("keeps suggested choices unsubmitted and accepts free text while work continues", async () => {
  let finish: () => void = () => {};
  const onRespond = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  await render(<div style={{ width: 560, padding: 16 }}><AsyncUserInputCard activity={question} onRespond={onRespond} /></div>);
  await expect.element(page.getByRole("button", { name: "Switching tabs" })).toHaveAttribute("aria-pressed", "true");
  expect(onRespond).not.toHaveBeenCalled();
  await page.getByLabelText("Or write your own answer").fill("Resizing the window");
  await page.getByLabelText("Your answer", { exact: true }).fill("Only with a long transcript");
  await page.getByRole("button", { name: "Submit answer" }).click();
  expect(onRespond).toHaveBeenCalledExactlyOnceWith({
    activityId: question.id, answers: ["Resizing the window", "Only with a long transcript"],
  });
  await expect.element(page.getByRole("button", { name: "Submitting…" })).toBeDisabled();
  finish();
  await expect.element(page.getByText("Answer submitted")).toBeVisible();
  await expect.element(page.getByText("Resizing the window")).toBeVisible();
});

it("restores submitted answers and never offers another submission after refresh", async () => {
  const onRespond = vi.fn();
  await render(<AsyncUserInputCard activity={{ ...question, payload: {
    ...question.payload, response: { answers: ["Scrolling", "After a reconnect"], messageId: MessageId.makeUnsafe("answer-1") },
  } }} onRespond={onRespond} />);
  await expect.element(page.getByText("Answer submitted")).toBeVisible();
  await expect.element(page.getByText("After a reconnect")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Submit answer" })).not.toBeInTheDocument();
  expect(onRespond).not.toHaveBeenCalled();
});

it("keeps the draft available when submission fails", async () => {
  const onRespond = vi.fn().mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValue(undefined);
  await render(<AsyncUserInputCard activity={question} onRespond={onRespond} />);
  await page.getByLabelText("Your answer", { exact: true }).fill("After a reconnect");
  await page.getByRole("button", { name: "Submit answer" }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Connection lost");
  await expect.element(page.getByLabelText("Your answer", { exact: true })).toHaveValue("After a reconnect");
  await page.getByRole("button", { name: "Submit answer" }).click();
  await expect.element(page.getByText("Answer submitted")).toBeVisible();
});

it.each([true, false])("reopens a rolled-back reply (rendered saved answer: %s)", async (renderSavedAnswer) => {
  const onRespond = vi.fn().mockResolvedValue(undefined);
  const screen = await render(<AsyncUserInputCard activity={question} onRespond={onRespond} />);
  await page.getByLabelText("Your answer", { exact: true }).fill("Original answer");
  await page.getByRole("button", { name: "Submit answer" }).click();
  await expect.element(page.getByText("Answer submitted")).toBeVisible();
  if (renderSavedAnswer) {
    await screen.rerender(<AsyncUserInputCard activity={{ ...question, payload: {
      ...question.payload, response: { answers: ["Switching tabs", "Original answer"], messageId: MessageId.makeUnsafe("answer-1") },
    } }} onRespond={onRespond} />);
  }
  await screen.rerender(<AsyncUserInputCard activity={{ ...question, payload: { ...question.payload } }} onRespond={onRespond} />);
  await expect.element(page.getByRole("button", { name: "Submit answer" })).toBeVisible();
  await page.getByLabelText("Your answer", { exact: true }).fill("Corrected answer");
  await page.getByRole("button", { name: "Submit answer" }).click();
  expect(onRespond).toHaveBeenLastCalledWith({ activityId: question.id, answers: ["Switching tabs", "Corrected answer"] });
  expect(onRespond).toHaveBeenCalledTimes(2);
});

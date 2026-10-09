// FILE: AssistantSelectionsSummaryChip.browser.tsx
// Purpose: Verifies that the selection chip lists quotes with their comments and removes them one at a time.

import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { type ChatAssistantSelectionAttachment } from "../../types";
import { AssistantSelectionsSummaryChip } from "./AssistantSelectionsSummaryChip";

const selections: ChatAssistantSelectionAttachment[] = [
  {
    type: "assistant-selection",
    id: "selection-1",
    assistantMessageId: "message-1",
    text: "how long a cached response is considered fresh",
    comment: "Fresh for whom?",
  },
  {
    type: "assistant-selection",
    id: "selection-2",
    assistantMessageId: "message-1",
    text: "must check for changes",
  },
];

describe("AssistantSelectionsSummaryChip", () => {
  it("opens a numbered list on click and removes one quote in the composer", async () => {
    const onRemove = vi.fn();
    const onRemoveSelection = vi.fn();
    const mounted = await render(
      <AssistantSelectionsSummaryChip
        selections={selections}
        onRemove={onRemove}
        onRemoveSelection={onRemoveSelection}
      />,
    );
    try {
      await page.getByRole("button", { name: "Show 2 selections" }).click();
      const list = page.getByRole("list");
      await expect.element(list).toBeVisible();
      expect(list.element().textContent).toContain("Fresh for whom?");
      expect(list.element().querySelectorAll("li")).toHaveLength(2);

      await page.getByRole("button", { name: "Remove selection 2" }).click();
      expect(onRemoveSelection).toHaveBeenCalledExactlyOnceWith("selection-2");
      expect(onRemove).not.toHaveBeenCalled();
    } finally {
      await mounted.unmount();
    }
  });

  it("is read-only in a sent message", async () => {
    const mounted = await render(<AssistantSelectionsSummaryChip selections={selections} />);
    try {
      await page.getByRole("button", { name: "Show 2 selections" }).click();
      await expect.element(page.getByRole("list")).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Remove selection 1" }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "Remove selections" }))
        .not.toBeInTheDocument();
    } finally {
      await mounted.unmount();
    }
  });
});

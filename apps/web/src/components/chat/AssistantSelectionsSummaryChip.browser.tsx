// Purpose: Browser regressions for the assistant-selection chip hover tooltip.
// Layer: Component interaction tests

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { AssistantSelectionsSummaryChip } from "./AssistantSelectionsSummaryChip";

const selections = [
  {
    type: "assistant-selection" as const,
    id: "sel-1",
    assistantMessageId: "assistant-1",
    text: "quoted passage",
    comment: "check this part",
  },
  {
    type: "assistant-selection" as const,
    id: "sel-2",
    assistantMessageId: "assistant-1",
    text: "quote without note",
  },
];

afterEach(async () => {
  document.body.innerHTML = "";
});

it("surfaces the linked note and the quote on hover", async () => {
  const screen = await render(<AssistantSelectionsSummaryChip selections={selections} />);
  try {
    await page.getByText("2 selections").hover();
    // Base UI's tooltip popup has no role="tooltip"; assert its rendered content
    // through the data-slot marker instead.
    const popup = page.getByText("check this part");
    await expect.element(popup).toBeVisible();
    await expect.element(page.getByText("quoted passage")).toBeVisible();
    await expect.element(page.getByText("quote without note")).toBeVisible();
    expect(document.querySelector('[data-slot="tooltip-popup"]')).not.toBeNull();
  } finally {
    await screen.unmount();
  }
});

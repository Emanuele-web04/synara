import "../../index.css";

import { page, userEvent } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { ComposerAssistantSelectionAttachment } from "../../composerDraftStore";
import { AssistantSelectionInlineMarkers } from "./AssistantSelectionInlineMarkers";
import { findTextRangeInElement } from "./chatSelectionActions";

const selections: ComposerAssistantSelectionAttachment[] = [
  {
    type: "assistant-selection",
    id: "sel-1",
    assistantMessageId: "assistant-1",
    text: "Cache TTL stays\nunchanged",
    comment: "Why not shorter?",
  },
  {
    type: "assistant-selection",
    id: "sel-2",
    assistantMessageId: "assistant-1",
    text: "process lifetime",
  },
];

function Harness(props: {
  selections: ReadonlyArray<ComposerAssistantSelectionAttachment>;
  onUpdateComment: (selectionId: string, comment: string) => void;
  onRemove: (selectionId: string) => void;
}) {
  return (
    <div
      ref={(element) => {
        harnessPane = element;
      }}
      style={{ position: "relative", width: 480, height: 320, overflow: "hidden" }}
    >
      <div data-assistant-message-id="assistant-1">
        <p>
          The <strong>Cache TTL</strong> stays
        </p>
        <p>unchanged, and the process lifetime is the same.</p>
      </div>
      <HarnessMarkers {...props} />
    </div>
  );
}

let harnessPane: HTMLDivElement | null = null;

function HarnessMarkers(props: Parameters<typeof Harness>[0]) {
  return <AssistantSelectionInlineMarkers container={harnessPane} {...props} />;
}

it("finds a quote across inline elements and block breaks", () => {
  const root = document.createElement("div");
  root.innerHTML = "<p>The <strong>Cache TTL</strong> stays</p><p>unchanged, really.</p>";
  document.body.append(root);
  try {
    expect(findTextRangeInElement(root, "Cache TTL stays\n\nunchanged")?.toString()).toBe(
      "Cache TTL staysunchanged",
    );
    expect(findTextRangeInElement(root, "not in the message")).toBeNull();
    expect(findTextRangeInElement(root, "  \n")).toBeNull();
  } finally {
    root.remove();
  }
});

it("labels each quote and edits or removes its comment from the label", async () => {
  const onUpdateComment = vi.fn();
  const onRemove = vi.fn();
  const screen = await render(
    <Harness selections={[]} onUpdateComment={onUpdateComment} onRemove={onRemove} />,
  );
  try {
    // The pane only exists after the first render; re-render so the markers see it.
    await screen.rerender(
      <Harness selections={selections} onUpdateComment={onUpdateComment} onRemove={onRemove} />,
    );
    await expect
      .element(page.getByRole("button", { name: "Edit comment for selection 1" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Edit comment for selection 2" }))
      .toBeVisible();
    expect(CSS.highlights.get("synara-assistant-selection")?.size).toBe(2);

    await page.getByRole("button", { name: "Edit comment for selection 1" }).click();
    const input = page.getByRole("textbox", { name: "Comment on selection" });
    await expect.element(input).toHaveTextContent("Why not shorter?");
    await input.fill("Make it ten minutes");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect(onUpdateComment).toHaveBeenCalledExactlyOnceWith("sel-1", "Make it ten minutes");
    await expect.element(input).not.toBeInTheDocument();

    // Clicking the highlighted text itself opens the same editor.
    await userEvent.click(page.getByText("unchanged, and the process lifetime is the same."), {
      position: { x: 160, y: 8 },
    });
    await expect.element(page.getByRole("textbox", { name: "Comment on selection" })).toBeVisible();
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    expect(onRemove).toHaveBeenCalledExactlyOnceWith("sel-2");
  } finally {
    await screen.unmount();
  }
  expect(CSS.highlights.has("synara-assistant-selection")).toBe(false);
});

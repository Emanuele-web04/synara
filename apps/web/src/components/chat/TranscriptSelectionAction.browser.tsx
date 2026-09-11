import "../../index.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { TRANSCRIPT_SELECTION_ACTION_HEIGHT_PX } from "./chatSelectionActions";
import { TranscriptSelectionActionLayer } from "./TranscriptSelectionActionLayer";

const action = {
  selection: {
    assistantMessageId: "assistant-1",
    text: "Cache TTL, snapshots, and process lifetime remain unchanged.",
  },
  left: 120,
  top: 320,
  placement: "top" as const,
};

function props() {
  return {
    action,
    defaultEnvMode: "local" as const,
    canUseWorktree: true,
    canAddToSide: true,
    onDismiss: vi.fn(),
    onAddToChat: vi.fn(),
    onAddToSide: vi.fn().mockResolvedValue(undefined),
    onNewChat: vi.fn().mockResolvedValue(undefined),
  };
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
});

it("shows the three segmented actions and routes the quote to Side", async () => {
  const callbacks = props();
  const screen = await render(<TranscriptSelectionActionLayer {...callbacks} />);
  try {
    const toolbar = page.getByRole("toolbar", { name: "Selection actions" });
    await expect.element(toolbar).toBeVisible();
    expect(toolbar.element().textContent).toBe("Add to ChatAdd to SideAdd to new Chat");
    expect(toolbar.element().querySelectorAll("svg")).toHaveLength(0);
    // Labels must never clip, and the rendered height must match the height the
    // layout reserves when placing the toolbar above the selection.
    for (const button of toolbar.element().querySelectorAll("button")) {
      expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth);
    }
    const bar = toolbar.element().firstElementChild!;
    expect(bar.getBoundingClientRect().height).toBe(TRANSCRIPT_SELECTION_ACTION_HEIGHT_PX);
    await page.getByRole("button", { name: "Add to Side", exact: true }).click();
    expect(callbacks.onAddToSide).toHaveBeenCalledExactlyOnceWith(action.selection);
  } finally {
    await screen.unmount();
  }
});

it("keeps the quote when the browser selection disappears and submits once", async () => {
  let finish: () => void = () => {};
  const callbacks = props();
  callbacks.onNewChat.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const screen = await render(<TranscriptSelectionActionLayer {...callbacks} />);
  try {
    await page.getByRole("button", { name: "Add to new Chat" }).click();
    await screen.rerender(<TranscriptSelectionActionLayer {...callbacks} action={null} />);
    const input = page.getByRole("textbox", { name: "Message for new chat" });
    await expect.element(input).toHaveFocus();
    await expect.element(page.getByText("1 selection")).toBeVisible();
    await input.fill("Explain the cache lifetime");
    await page.getByRole("button", { name: "Local", exact: true }).click();
    await page.getByRole("menuitem", { name: "New worktree", exact: true }).click();
    await page.getByRole("button", { name: "Send to new chat" }).click();
    await expect.element(page.getByRole("button", { name: "Send to new chat" })).toBeDisabled();
    expect(callbacks.onNewChat).toHaveBeenCalledExactlyOnceWith(
      action.selection,
      "Explain the cache lifetime",
      "worktree",
      "send",
    );
    finish();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});

it("retains the mini-composer text and environment when creation fails", async () => {
  const callbacks = props();
  callbacks.onNewChat.mockRejectedValue(new Error("Worktree creation unavailable"));
  const screen = await render(<TranscriptSelectionActionLayer {...callbacks} />);
  try {
    await page.getByRole("button", { name: "Add to new Chat" }).click();
    const input = page.getByRole("textbox", { name: "Message for new chat" });
    await input.fill("Keep this message");
    await userEvent.keyboard("{Enter}");
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Worktree creation unavailable");
    await expect.element(input).toHaveTextContent("Keep this message");
    await expect.element(page.getByRole("button", { name: "Local", exact: true })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});

it("fits the composer in a narrow viewport and disables Worktree outside Git projects", async () => {
  await page.viewport(360, 480);
  const screen = await render(
    <TranscriptSelectionActionLayer
      {...props()}
      action={{ ...action, left: 8, top: 8 }}
      canUseWorktree={false}
    />,
  );
  try {
    await page.getByRole("button", { name: "Add to new Chat" }).click();
    await page.getByRole("button", { name: "Local", exact: true }).click();
    await expect
      .element(page.getByRole("menuitem", { name: "New worktree", exact: true }))
      .not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    const rect = page.getByRole("dialog").element().getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(8);
    expect(rect.right).toBeLessThanOrEqual(352);
    expect(rect.top).toBeGreaterThanOrEqual(8);
    expect(rect.bottom).toBeLessThanOrEqual(472);
  } finally {
    await screen.unmount();
    await page.viewport(1280, 720);
  }
});

it.each(["", "Let me add more context"])(
  "opens the full composer with the quote and draft %j without sending",
  async (prompt) => {
    const callbacks = props();
    const screen = await render(<TranscriptSelectionActionLayer {...callbacks} />);
    try {
      await page.getByRole("button", { name: "Add to new Chat" }).click();
      if (prompt) await page.getByRole("textbox", { name: "Message for new chat" }).fill(prompt);
      await page.getByRole("button", { name: "Local", exact: true }).click();
      await page.getByRole("menuitem", { name: "New worktree", exact: true }).click();
      await page.getByRole("button", { name: "Open in chat", exact: true }).click();
      expect(callbacks.onNewChat).toHaveBeenCalledExactlyOnceWith(
        action.selection,
        prompt,
        "worktree",
        "compose",
      );
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  },
);

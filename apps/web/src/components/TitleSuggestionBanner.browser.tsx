import "../index.css";

import { ThreadId } from "@synara/contracts";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({ dispatch: vi.fn(), toast: vi.fn(), available: true }));
vi.mock("../nativeApi", () => ({
  ensureNativeApi: () => {
    if (!harness.available) throw new Error("Native API not found");
    return { orchestration: { dispatchCommand: harness.dispatch } };
  },
}));
vi.mock("./ui/toast", () => ({ toastManager: { add: harness.toast } }));

import { TitleSuggestionSlot } from "./TitleSuggestionBanner";
import { TitleRefreshModePicker } from "./TitleRefreshModePicker";

const threadId = ThreadId.makeUnsafe("title-refresh-browser-thread");
beforeEach(() => {
  harness.available = true;
  harness.dispatch.mockReset().mockResolvedValue(undefined);
  harness.toast.mockReset();
});
afterEach(() => {
  document.body.innerHTML = "";
});

it("accepts the shown candidate and pins the chosen title", async () => {
  const view = await render(
    <TitleSuggestionSlot threadId={threadId} candidate="  Clear title  " />,
  );
  try {
    await page.getByRole("button", { name: "Use title" }).click();
    await vi.waitFor(() =>
      expect(harness.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thread.meta.update",
          threadId,
          title: "Clear title",
          pendingSuggestedTitle: null,
          manualTitlePinned: true,
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(harness.toast).toHaveBeenCalledWith({ type: "success", title: "Thread renamed" }),
    );
  } finally {
    await view.unmount();
  }
});

it("dismisses the candidate without renaming or changing the manual pin", async () => {
  const view = await render(<TitleSuggestionSlot threadId={threadId} candidate="Candidate" />);
  try {
    await page.getByRole("button", { name: "Dismiss" }).click();
    await vi.waitFor(() => expect(harness.dispatch).toHaveBeenCalledTimes(1));
    const command = harness.dispatch.mock.calls[0]![0];
    expect(command).toMatchObject({
      type: "thread.meta.update",
      threadId,
      pendingSuggestedTitle: null,
    });
    expect(command).not.toHaveProperty("title");
    expect(command).not.toHaveProperty("manualTitlePinned");
  } finally {
    await view.unmount();
  }
});

it.each([
  ["Use title", "Could not apply suggestion"],
  ["Dismiss", "Could not dismiss suggestion"],
])("keeps a failed %s action retryable", async (label, errorTitle) => {
  harness.dispatch.mockRejectedValueOnce(new Error("Connection interrupted"));
  const view = await render(<TitleSuggestionSlot threadId={threadId} candidate="Candidate" />);
  try {
    const button = page.getByRole("button", { name: label });
    await button.click();
    await vi.waitFor(() =>
      expect(harness.toast).toHaveBeenCalledWith({
        type: "error",
        title: errorTitle,
        description: "Connection interrupted",
      }),
    );
    await expect.element(page.getByText("Candidate", { exact: true })).toBeVisible();
    await button.click();
    await vi.waitFor(() => expect(harness.dispatch).toHaveBeenCalledTimes(2));
  } finally {
    await view.unmount();
  }
});

it.each([
  ["Use title", "Could not apply suggestion"],
  ["Dismiss", "Could not dismiss suggestion"],
])("reports an unavailable connection for %s", async (label, errorTitle) => {
  harness.available = false;
  const view = await render(<TitleSuggestionSlot threadId={threadId} candidate="Candidate" />);
  try {
    await page.getByRole("button", { name: label }).click();
    await vi.waitFor(() =>
      expect(harness.toast).toHaveBeenCalledWith({
        type: "error",
        title: errorTitle,
        description: "Native API not found",
      }),
    );
    expect(harness.dispatch).not.toHaveBeenCalled();
  } finally {
    await view.unmount();
  }
});

it("selects explicit title modes and restores inherited policy", async () => {
  const changed = vi.fn();
  function Picker() {
    const [value, setValue] = useState<"off" | "suggested" | "automatic" | null>(null);
    return (
      <TitleRefreshModePicker
        value={value}
        onChange={(mode) => {
          setValue(mode);
          changed(mode);
        }}
      />
    );
  }
  const view = await render(<Picker />);
  try {
    for (const [label, mode] of [
      ["Off", "off"],
      ["Suggested", "suggested"],
      ["Automatic", "automatic"],
      ["Inherit", null],
    ] as const) {
      await page.getByRole("radio", { name: label, exact: true }).click();
      expect(changed).toHaveBeenLastCalledWith(mode);
      await expect
        .element(page.getByRole("radio", { name: label, exact: true }))
        .toHaveAttribute("aria-checked", "true");
    }
  } finally {
    await view.unmount();
  }
});

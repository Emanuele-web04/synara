import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderRuntimeEvent } from "@synara/contracts";
import { CursorActivity, cursorRuntimeActivity, cursorToolActivity } from "./cursorActivity.ts";

const tick = () => vi.advanceTimersByTimeAsync(80);
afterEach(() => vi.useRealTimers());

describe("cursor activity", () => {
  it("shows live work, then thinking, without waiting on the badge backend", async () => {
    vi.useFakeTimers();
    const labels: Array<string | null> = [];
    const activity = new CursorActivity(async (text) => {
      labels.push(text);
      await new Promise(() => {});
    });
    activity.setOwner("owner");
    let finish!: () => void;
    const work = activity.during(
      "owner",
      "Scrolling",
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await tick();
    expect(labels).toEqual(["Scrolling"]);
    finish();
    await work;
    await tick();
    expect(labels).toEqual(["Scrolling", "Thinking"]);
    activity.setOwner(null);
    await tick();
    expect(labels.at(-1)).toBeNull();
    activity.dispose();
  });

  it("coalesces brief calls and repeated token events", async () => {
    vi.useFakeTimers();
    const publish = vi.fn(async () => {});
    const activity = new CursorActivity(publish);
    activity.setOwner("owner");
    await activity.during("owner", "Clicking", async () => {});
    for (let i = 0; i < 100; i++) activity.setRuntime("owner", "Thinking");
    await tick();
    expect(publish.mock.calls).toEqual([["Thinking"]]);
    activity.dispose();
  });

  it("ignores other threads and keeps pending work from overwriting a new owner", async () => {
    vi.useFakeTimers();
    const labels: Array<string | null> = [];
    const activity = new CursorActivity(async (text) => {
      labels.push(text);
    });
    activity.setOwner("a");
    let finish!: () => void;
    const work = activity.during(
      "a",
      "Typing",
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    activity.setOwner("b");
    activity.setRuntime("a", "Waiting for you");
    activity.setRuntime("b", "Needs approval");
    await tick();
    finish();
    await work;
    await tick();
    expect(labels).toEqual(["Needs approval"]);
    activity.dispose();
  });

  it("keeps a pending question visible until its response arrives", async () => {
    vi.useFakeTimers();
    const labels: Array<string | null> = [];
    const activity = new CursorActivity(async (text) => {
      labels.push(text);
    });
    activity.setOwner("owner");
    activity.setRuntime("owner", "Waiting for you");
    activity.setRuntime("owner", "Responding");
    activity.setRuntime("owner", "Thinking");
    await tick();
    expect(labels).toEqual(["Waiting for you"]);
    activity.setRuntime("owner", "Thinking", true);
    await tick();
    expect(labels.at(-1)).toBe("Thinking");
    activity.dispose();
  });

  it("handles errors and disposal without failing input or publishing late labels", async () => {
    vi.useFakeTimers();
    const publish = vi.fn(async () => {
      throw new Error("badge unavailable");
    });
    const activity = new CursorActivity(publish);
    activity.setOwner("a");
    await expect(
      activity.during("a", "Typing", async () => {
        throw new Error("input failed");
      }),
    ).rejects.toThrow("input failed");
    await tick();
    expect(publish).toHaveBeenCalledWith("Needs attention");
    activity.setRuntime("a", "Thinking");
    activity.dispose();
    await tick();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("uses concise labels for actual events, without showing private content", () => {
    expect(cursorToolActivity("computer_scroll").length).toBeLessThanOrEqual(20);
    const event = (type: string, payload = {}) => ({ type, payload }) as ProviderRuntimeEvent;
    expect(cursorRuntimeActivity(event("user-input.requested"))).toBe("Waiting for you");
    expect(cursorRuntimeActivity(event("request.opened"))).toBe("Needs approval");
    expect(
      cursorRuntimeActivity(
        event("content.delta", { streamKind: "reasoning_text", delta: "private reasoning" }),
      ),
    ).toBe("Thinking");
    expect(cursorRuntimeActivity(event("session.exited"))).toBeUndefined();
  });

  it("labels the registered cursor tool and never echoes unknown tool names", () => {
    const expected = {
      computer_screenshot: "Capturing screen",
      computer_get_state: "Reading screen",
      computer_get_screen_size: "Measuring screen",
      computer_list_windows: "Finding window",
      computer_click: "Clicking",
      computer_double_click: "Double-clicking",
      computer_triple_click: "Triple-clicking",
      computer_right_click: "Right-clicking",
      computer_move_cursor: "Moving cursor",
      computer_drag: "Dragging",
      computer_scroll: "Scrolling",
      computer_type_text: "Typing",
      computer_press_key: "Pressing key",
      computer_hotkey: "Pressing shortcut",
      computer_set_value: "Setting field",
      computer_perform_action: "Activating control",
      computer_launch_app: "Opening app",
      computer_activate_window: "Activating window",
      computer_wait: "Waiting for screen",
      computer_read_clipboard: "Reading clipboard",
      computer_write_clipboard: "Writing clipboard",
      computer_paste: "Pasting",
      computer_run: "Running sequence",
    } as const;
    for (const [tool, label] of Object.entries(expected)) {
      expect(cursorToolActivity(tool)).toBe(label);
      expect(label.length).toBeLessThanOrEqual(20);
    }
    expect(cursorToolActivity("computer_move")).toBe("Working");
    expect(cursorToolActivity("unknown tool containing private text")).toBe("Working");
  });
});

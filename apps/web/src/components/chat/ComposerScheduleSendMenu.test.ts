// FILE: ComposerScheduleSendMenu.test.ts
// Purpose: Locks down scheduled composer timer labels and countdown formatting.
// Layer: Web chat composer tests

import { describe, expect, it } from "vitest";

import {
  formatScheduledComposerCountdown,
  scheduledComposerDispatchLabel,
} from "./ComposerScheduleSendMenu";

describe("formatScheduledComposerCountdown", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(formatScheduledComposerCountdown(4_200)).toBe("5s");
    expect(formatScheduledComposerCountdown(62_000)).toBe("1m 2s");
    expect(formatScheduledComposerCountdown(5 * 60 * 60 * 1_000)).toBe("5h");
  });

  it("clamps elapsed timers to zero", () => {
    expect(formatScheduledComposerCountdown(-1)).toBe("0s");
  });
});

describe("scheduledComposerDispatchLabel", () => {
  it("labels timer dispatch directions", () => {
    expect(scheduledComposerDispatchLabel("new")).toBe("New chat");
    expect(scheduledComposerDispatchLabel("queue")).toBe("Queue");
    expect(scheduledComposerDispatchLabel("steer")).toBe("Steer");
  });
});

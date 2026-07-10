import type { AutomationSchedule } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  automationLifecycleState,
  canPauseAutomation,
  isOneTimeSchedule,
} from "./automationStatus";

const daily = { type: "daily", timeOfDay: "09:00" } as AutomationSchedule;
const once = { type: "once", runAt: "2026-06-23T00:00:00.000Z" } as AutomationSchedule;
const manual = { type: "manual" } as AutomationSchedule;

describe("automationLifecycleState", () => {
  it("recurring schedules are active when enabled and paused when disabled", () => {
    expect(automationLifecycleState({ schedule: daily, enabled: true, nextRunAt: null })).toBe(
      "active",
    );
    expect(automationLifecycleState({ schedule: daily, enabled: false, nextRunAt: null })).toBe(
      "paused",
    );
  });

  it("manual automations follow the enabled flag like recurring ones", () => {
    expect(automationLifecycleState({ schedule: manual, enabled: true, nextRunAt: null })).toBe(
      "active",
    );
    expect(automationLifecycleState({ schedule: manual, enabled: false, nextRunAt: null })).toBe(
      "paused",
    );
  });

  it("one-time automations are scheduled before firing and done after", () => {
    expect(
      automationLifecycleState({
        schedule: once,
        enabled: true,
        nextRunAt: "2026-06-23T00:00:00.000Z",
      }),
    ).toBe("scheduled");
    // After firing the server clears nextRunAt and disables the automation.
    expect(automationLifecycleState({ schedule: once, enabled: false, nextRunAt: null })).toBe(
      "done",
    );
  });

  it("one-time automations are never paused (a disabled or run-less once reads as done)", () => {
    expect(automationLifecycleState({ schedule: once, enabled: true, nextRunAt: null })).toBe(
      "done",
    );
    expect(
      automationLifecycleState({
        schedule: once,
        enabled: false,
        nextRunAt: "2026-06-23T00:00:00.000Z",
      }),
    ).toBe("done");
  });
});

describe("canPauseAutomation", () => {
  it("is true for recurring and manual schedules, false for one-time", () => {
    expect(canPauseAutomation({ schedule: daily })).toBe(true);
    expect(canPauseAutomation({ schedule: manual })).toBe(true);
    expect(canPauseAutomation({ schedule: once })).toBe(false);
  });
});

describe("isOneTimeSchedule", () => {
  it("only 'once' is one-time", () => {
    expect(isOneTimeSchedule(once)).toBe(true);
    expect(isOneTimeSchedule(daily)).toBe(false);
    expect(isOneTimeSchedule(manual)).toBe(false);
  });
});

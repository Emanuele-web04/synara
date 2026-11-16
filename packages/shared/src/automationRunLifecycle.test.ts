import { AutomationRunStatus } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  ACTIVE_AUTOMATION_RUN_STATUSES,
  AUTOMATION_RUN_TRANSITIONS,
  TERMINAL_AUTOMATION_RUN_STATUSES,
  automationRunStatusesLeadingTo,
  canTransitionAutomationRun,
  isActiveAutomationRunStatus,
  isTerminalAutomationRunStatus,
} from "./automationRunLifecycle";

const statuses = AutomationRunStatus.literals;

describe("automationRunLifecycle", () => {
  it("places every contract status in exactly one partition", () => {
    // Adding a status without deciding whether a run can still leave it is the bug this
    // module exists to prevent.
    expect(
      [...ACTIVE_AUTOMATION_RUN_STATUSES, ...TERMINAL_AUTOMATION_RUN_STATUSES].toSorted(),
    ).toEqual([...statuses].toSorted());
    for (const status of statuses) {
      expect(isActiveAutomationRunStatus(status)).toBe(!isTerminalAutomationRunStatus(status));
    }
  });

  it("lets nothing leave a terminal status", () => {
    for (const from of TERMINAL_AUTOMATION_RUN_STATUSES) {
      expect(AUTOMATION_RUN_TRANSITIONS[from]).toEqual([]);
      for (const to of statuses) {
        expect(canTransitionAutomationRun(from, to)).toBe(false);
      }
    }
  });

  it("lets every active status settle, and never loop onto itself", () => {
    for (const from of ACTIVE_AUTOMATION_RUN_STATUSES) {
      expect(canTransitionAutomationRun(from, from)).toBe(false);
      for (const to of ["succeeded", "failed", "cancelled", "interrupted"] as const) {
        expect(canTransitionAutomationRun(from, to)).toBe(true);
      }
    }
  });

  it("only skips a run that has not started", () => {
    expect(automationRunStatusesLeadingTo("skipped")).toEqual(["pending", "claimed"]);
  });

  it("resumes a run from an approval wait and back", () => {
    expect(canTransitionAutomationRun("running", "waiting-for-approval")).toBe(true);
    expect(canTransitionAutomationRun("waiting-for-approval", "running")).toBe(true);
  });
});

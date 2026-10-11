import { AutomationMode, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  automationContinuationThreadId,
  automationContinuesThread,
  automationOwnsItsThread,
  automationRequiresTargetThread,
} from "./automationMode";

const threadId = ThreadId.makeUnsafe("thread-automation");

describe("automationMode", () => {
  it("groups every thread-continuing mode together", () => {
    // Adding a mode without deciding this is the bug these predicates exist to prevent.
    expect(AutomationMode.literals.filter(automationContinuesThread)).toEqual([
      "heartbeat",
      "dedicated",
    ]);
    expect(AutomationMode.literals.filter(automationOwnsItsThread)).toEqual(["dedicated"]);
    expect(AutomationMode.literals.filter(automationRequiresTargetThread)).toEqual(["heartbeat"]);
  });

  it("resolves the thread the next run continues", () => {
    expect(automationContinuationThreadId({ mode: "heartbeat", targetThreadId: threadId })).toBe(
      threadId,
    );
    expect(automationContinuationThreadId({ mode: "dedicated", targetThreadId: threadId })).toBe(
      threadId,
    );
    // A dedicated automation has no thread until its first run creates one.
    expect(automationContinuationThreadId({ mode: "dedicated", targetThreadId: null })).toBeNull();
    // A stale target thread on a standalone automation must never resurrect continuation.
    expect(
      automationContinuationThreadId({ mode: "standalone", targetThreadId: threadId }),
    ).toBeNull();
  });
});

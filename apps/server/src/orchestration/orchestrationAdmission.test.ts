import { describe, expect, it } from "vitest";
import {
  ORCHESTRATION_COMMAND_CONTROL_RESERVE,
  ORCHESTRATION_COMMAND_QUEUE_CAPACITY,
  isQuiescingCommandAdmissible,
  orchestrationCommandLane,
  usesReservedCommandAdmission,
} from "./orchestrationAdmission.ts";

describe("orchestration command admission policy", () => {
  it("reserves part of the bounded admission capacity for lifecycle commands", () => {
    expect(ORCHESTRATION_COMMAND_QUEUE_CAPACITY).toBe(256);
    expect(ORCHESTRATION_COMMAND_CONTROL_RESERVE).toBe(32);
  });

  it.each([
    "thread.turn.interrupt",
    "thread.session.stop",
    "thread.task.stop",
    "thread.task.background",
    "thread.approval.respond",
    "thread.user-input.respond",
    "thread.message.assistant.complete",
  ] as const)("gives %s reserved control admission during quiesce", (type) => {
    expect(usesReservedCommandAdmission(type)).toBe(true);
    expect(orchestrationCommandLane(type)).toBe("control");
    expect(isQuiescingCommandAdmissible(type)).toBe(true);
  });

  it.each([
    "thread.turn.start",
    "thread.create",
    "thread.checkpoint.revert",
    "thread.conversation.rollback",
  ] as const)("prioritizes %s without allowing it to consume lifecycle capacity", (type) => {
    expect(usesReservedCommandAdmission(type)).toBe(false);
    expect(orchestrationCommandLane(type)).toBe("user");
    expect(isQuiescingCommandAdmissible(type)).toBe(false);
  });

  it("allows settlement diagnostics to quiesce without control priority or reserve", () => {
    expect(orchestrationCommandLane("thread.activity.append")).toBe("normal");
    expect(usesReservedCommandAdmission("thread.activity.append")).toBe(false);
    expect(isQuiescingCommandAdmissible("thread.activity.append")).toBe(true);
    expect(isQuiescingCommandAdmissible("project.create")).toBe(false);
  });
});

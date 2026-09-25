import { describe, expect, it } from "vitest";

import {
  classifyTerminalTurnApplicability,
  isStartedTurnApplicable,
} from "./terminalTurnApplicability.ts";

describe("isStartedTurnApplicable", () => {
  it("accepts the first start and a repeated start for the active turn", () => {
    expect(isStartedTurnApplicable({ activeTurnId: null, eventTurnId: "turn-first" })).toBe(true);
    expect(isStartedTurnApplicable({ activeTurnId: "turn-first", eventTurnId: "turn-first" })).toBe(
      true,
    );
  });
});

describe("classifyTerminalTurnApplicability", () => {
  it("accepts an explicit terminal event when no turn is active", () => {
    expect(
      classifyTerminalTurnApplicability({
        activeTurnId: null,
        eventTurnId: "turn-finished",
      }),
    ).toEqual({
      applicable: true,
      resolvedTurnId: "turn-finished",
      reason: "no-active-turn",
    });
  });

  it("accepts an unscoped terminal event when no turn is active", () => {
    expect(
      classifyTerminalTurnApplicability({
        activeTurnId: null,
        eventTurnId: undefined,
      }),
    ).toEqual({
      applicable: true,
      resolvedTurnId: undefined,
      reason: "no-active-turn",
    });
  });
});

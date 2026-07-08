import { TurnId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { resolveStableMessageTurnId } from "./messageTurnId.ts";

describe("resolveStableMessageTurnId", () => {
  it("keeps the existing turn id when a later event carries a different one", () => {
    expect(
      resolveStableMessageTurnId({
        existingTurnId: TurnId.makeUnsafe("turn-original"),
        incomingTurnId: TurnId.makeUnsafe("turn-later"),
      }),
    ).toBe("turn-original");
  });

  it("uses the incoming turn id when the message has no previous turn", () => {
    expect(
      resolveStableMessageTurnId({
        existingTurnId: null,
        incomingTurnId: TurnId.makeUnsafe("turn-incoming"),
      }),
    ).toBe("turn-incoming");
  });

  it("returns null when no turn id is available", () => {
    expect(
      resolveStableMessageTurnId({
        existingTurnId: undefined,
        incomingTurnId: undefined,
      }),
    ).toBeNull();
  });
});

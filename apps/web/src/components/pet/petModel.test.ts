// FILE: petModel.test.ts
// Purpose: Guards global pet animation resolution against persistent gesture loops.
// Layer: Web unit tests
// Exports: Vitest cases for petModel helpers

import { describe, expect, it } from "vitest";

import {
  PET_STATE_ROWS,
  resolveGlobalPetAnimation,
  resolvePetAnimation,
  shouldLoopPetAnimation,
} from "./petModel";

describe("petModel", () => {
  it("falls back to idle after a completed turn instead of looping a wave", () => {
    expect(
      resolvePetAnimation({
        sessionStatus: "ready",
        latestTurnState: "completed",
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        error: null,
      }),
    ).toBe("idle");
  });

  it("keeps the classic idle pose for active work", () => {
    expect(
      resolvePetAnimation({
        sessionStatus: "running",
        orchestrationStatus: "running",
        latestTurnState: "running",
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        error: null,
      }),
    ).toBe("idle");
  });

  it("keeps background running work on the classic idle pose", () => {
    expect(
      resolveGlobalPetAnimation([
        {
          sessionStatus: "ready",
          latestTurnState: "completed",
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          error: null,
        },
        {
          sessionStatus: "running",
          orchestrationStatus: "running",
          latestTurnState: "running",
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          error: null,
        },
      ]),
    ).toBe("idle");
  });

  it("keeps failed background threads from making the global pet cry", () => {
    expect(
      resolveGlobalPetAnimation([
        {
          sessionStatus: "error",
          latestTurnState: "error",
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          error: "failed turn",
        },
      ]),
    ).toBe("idle");
  });

  it("uses a stable visible frame for the classic pose", () => {
    expect(PET_STATE_ROWS.idle).toMatchObject({ row: 0, frames: 1 });
  });

  it("keeps durable activity states animating but makes gesture poses one-shot", () => {
    expect(shouldLoopPetAnimation("idle")).toBe(true);
    expect(shouldLoopPetAnimation("review")).toBe(true);
    expect(shouldLoopPetAnimation("running")).toBe(true);
    expect(shouldLoopPetAnimation("waving")).toBe(false);
    expect(shouldLoopPetAnimation("jumping")).toBe(false);
  });
});

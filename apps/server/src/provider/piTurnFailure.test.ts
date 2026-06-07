import { describe, expect, it } from "vitest";

import { classifyPiTurnFailure } from "./piTurnFailure.ts";

describe("classifyPiTurnFailure", () => {
  it("treats Pi abort messages as interrupted turns", () => {
    expect(classifyPiTurnFailure("Error: Request was aborted.")).toEqual({
      state: "interrupted",
      stopReason: "aborted",
    });
  });

  it("keeps real Pi failures failed", () => {
    expect(classifyPiTurnFailure("Model provider returned a 500")).toEqual({
      state: "failed",
      stopReason: "error",
    });
  });
});

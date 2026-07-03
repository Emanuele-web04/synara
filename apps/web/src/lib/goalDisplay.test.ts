import { describe, expect, it } from "vitest";

import { deriveCodexNativeGoalDisplay, parseCodexNativeGoalCommandText } from "./goalDisplay";

describe("goalDisplay", () => {
  it("parses Codex native goal commands for composer display", () => {
    expect(parseCodexNativeGoalCommandText("/goal Explore docs --budget 1000")).toEqual({
      kind: "set",
      objective: "Explore docs",
    });
    expect(parseCodexNativeGoalCommandText("/goal clear")).toEqual({ kind: "clear" });
    expect(parseCodexNativeGoalCommandText("/goal status")).toBeNull();
    expect(parseCodexNativeGoalCommandText("hello /goal explore")).toBeNull();
  });

  it("derives the latest active Codex native goal from user messages", () => {
    expect(
      deriveCodexNativeGoalDisplay([
        { id: "m1", role: "user", text: "/goal Explore docs" },
        { id: "m2", role: "assistant", text: "Goal set." },
      ]),
    ).toEqual({ objective: "Explore docs", commandMessageId: "m1" });

    expect(
      deriveCodexNativeGoalDisplay([
        { id: "m1", role: "user", text: "/goal Explore docs" },
        { id: "m2", role: "user", text: "/goal clear" },
      ]),
    ).toBeNull();
  });
});

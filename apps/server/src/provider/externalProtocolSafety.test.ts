import { describe, expect, it } from "vitest";
import {
  externalToolCallEvidence,
  externalAgentEnvironment,
  hasKnownExternalPlanStatuses,
  isKnownExternalPermissionKind,
} from "./externalProtocolSafety.ts";

describe("external ACP evidence", () => {
  it("does not promote a title into a command", () => {
    const result = externalToolCallEvidence({
      toolCallId: "t",
      title: "Ran: rm -rf /",
      command: "rm -rf /",
      detail: "rm -rf /",
      data: { command: "rm -rf /" },
    });
    expect(result.command).toBeUndefined();
    expect(result.data.command).toBeUndefined();
    expect(result.detail).toBeUndefined();
  });
  it("uses structured input instead of a contradictory title", () => {
    const result = externalToolCallEvidence({
      toolCallId: "t",
      command: "invented",
      data: { rawInput: { command: "git status" }, command: "invented" },
    });
    expect(result.command).toBe("git status");
    expect(result.data.command).toBe("git status");
  });
  it("preserves executable/argument evidence", () => {
    expect(
      externalToolCallEvidence({
        toolCallId: "t",
        data: { rawInput: { executable: "git", args: ["status", "--short"] } },
      }).command,
    ).toBe("git status --short");
  });
  it("fails closed for absent, other, or new permission kinds", () => {
    for (const value of [undefined, null, "other", "unknown", "new_kind"])
      expect(isKnownExternalPermissionKind(value)).toBe(false);
    expect(isKnownExternalPermissionKind("execute")).toBe(true);
  });
  it("rejects unknown and absent plan statuses", () => {
    for (const status of [undefined, "failed", "future"])
      expect(hasKnownExternalPlanStatuses({ update: { entries: [{ status }] } })).toBe(false);
  });
  it("accepts the protocol plan states without inventing a state", () => {
    expect(
      hasKnownExternalPlanStatuses({
        update: {
          entries: [{ status: "pending" }, { status: "in_progress" }, { status: "completed" }],
        },
      }),
    ).toBe(true);
  });
});

it("passes explicit credentials without inheriting unrelated server secrets", () => {
  expect(
    externalAgentEnvironment(
      { TOKEN: "selected", PATH: "/selected" },
      {
        Path: "/ambient",
        HOME: "/home",
        OPENAI_API_KEY: "ambient",
        DATABASE_URL: "private",
        SYNARA_TOKEN: "server",
      },
    ),
  ).toEqual({ HOME: "/home", PATH: "/selected", TOKEN: "selected" });
});

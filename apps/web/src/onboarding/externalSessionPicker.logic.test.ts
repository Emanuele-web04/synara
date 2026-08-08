import type { ProjectId, ServerExternalSessionSummary } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  filterExternalSessions,
  resolveSessionProjectId,
  shortenSessionCwd,
  sortExternalSessions,
} from "./externalSessionPicker.logic";

function session(
  overrides: Partial<ServerExternalSessionSummary> & { sessionId: string },
): ServerExternalSessionSummary {
  return {
    provider: "claudeAgent",
    title: overrides.sessionId,
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("filterExternalSessions", () => {
  const sessions = [
    session({
      sessionId: "s-1",
      title: "Fix login bug",
      firstPrompt: "the auth flow breaks",
      cwd: "/Users/dev/webapp",
    }),
    session({
      sessionId: "s-2",
      title: "Refactor billing",
      gitBranch: "feat/billing-v2",
      cwd: "/Users/dev/api",
    }),
  ];

  it("returns everything for a blank query", () => {
    expect(filterExternalSessions(sessions, "  ")).toEqual(sessions);
  });

  it("matches tokens across title, first prompt, cwd, and branch", () => {
    expect(filterExternalSessions(sessions, "auth webapp").map((s) => s.sessionId)).toEqual([
      "s-1",
    ]);
    expect(filterExternalSessions(sessions, "billing-v2").map((s) => s.sessionId)).toEqual(["s-2"]);
    expect(filterExternalSessions(sessions, "LOGIN").map((s) => s.sessionId)).toEqual(["s-1"]);
    expect(filterExternalSessions(sessions, "login api")).toEqual([]);
  });
});

describe("sortExternalSessions", () => {
  it("orders sessions newest first", () => {
    const sorted = sortExternalSessions([
      session({ sessionId: "old", updatedAt: "2026-08-01T10:00:00.000Z" }),
      session({ sessionId: "new", updatedAt: "2026-08-06T10:00:00.000Z" }),
    ]);
    expect(sorted.map((s) => s.sessionId)).toEqual(["new", "old"]);
  });
});

describe("resolveSessionProjectId", () => {
  const projects = [
    { id: "p-1" as ProjectId, cwd: "/Users/dev/webapp" },
    { id: "p-2" as ProjectId, cwd: "/Users/dev/api/" },
  ];

  it("matches by normalized workspace root", () => {
    expect(resolveSessionProjectId({ cwd: "/Users/dev/webapp/" }, projects)).toBe("p-1");
    expect(resolveSessionProjectId({ cwd: "/Users/dev/api" }, projects)).toBe("p-2");
  });

  it("returns null for missing or unknown cwds", () => {
    expect(resolveSessionProjectId({}, projects)).toBeNull();
    expect(resolveSessionProjectId({ cwd: "/Users/dev/other" }, projects)).toBeNull();
  });
});

describe("shortenSessionCwd", () => {
  it("collapses the home directory prefix", () => {
    expect(shortenSessionCwd("/Users/dev/webapp", "/Users/dev")).toBe("~/webapp");
    expect(shortenSessionCwd("/Users/dev", "/Users/dev")).toBe("~");
    expect(shortenSessionCwd("/opt/other", "/Users/dev")).toBe("/opt/other");
    expect(shortenSessionCwd("/Users/dev/webapp", null)).toBe("/Users/dev/webapp");
  });
});

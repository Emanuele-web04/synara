import { describe, expect, it } from "vitest";

import {
  parseRecoverableCreationPlan,
  redactCreationPlanForPurgedCaller,
  recordCreatedWorktreeInPlan,
} from "./operationPlan.ts";

describe("agent gateway operation plans", () => {
  it("drops local workspace and caller payload data when only deterministic ids remain useful", () => {
    const planJson = JSON.stringify([
      {
        workspaceRoot: "/private/repository",
        environment: "local",
        newBranch: null,
        plannedWorktreePath: null,
        ownershipPreflightPassed: false,
        spec: { prompt: "private caller prompt" },
        projectId: "private-project",
        ids: {
          threadId: "agent:local-child",
          compensateCommandId: "agent:local-child:delete",
        },
      },
    ]);

    const redacted = redactCreationPlanForPurgedCaller({
      planJson,
      operationId: "gateway:create:local",
    });
    expect(JSON.parse(redacted)).toEqual([
      {
        workspaceRoot: "",
        environment: "local",
        newBranch: null,
        plannedWorktreePath: null,
        ownershipPreflightPassed: false,
        worktreeOwnership: null,
        ids: {
          threadId: "agent:local-child",
          compensateCommandId: "agent:local-child:delete",
        },
      },
    ]);
    expect(redacted).not.toContain("private caller prompt");
    expect(redacted).not.toContain("private-project");
    expect(redacted).not.toContain("/private/repository");
  });

  it("does not accept legacy name/path assertions as destructive ownership proof", () => {
    const [entry] = parseRecoverableCreationPlan(
      JSON.stringify([
        {
          workspaceRoot: "/repo",
          environment: "worktree",
          newBranch: "agent/legacy",
          plannedWorktreePath: "/worktrees/legacy",
          ownershipPreflightPassed: true,
          worktreeOwnership: {
            operationId: "gateway:create:legacy",
            path: "/worktrees/legacy",
            branch: "agent/legacy",
            recordedAt: "2026-07-19T00:00:00.000Z",
          },
          ids: {
            threadId: "agent:legacy-child",
            compensateCommandId: "agent:legacy-child:delete",
          },
        },
      ]),
      "gateway:create:legacy",
    );

    expect(entry?.worktreeOwnership).toBeNull();
  });

  it("records detached worktree ownership without inventing a branch", () => {
    const operationId = "gateway:create:detached";
    const planJson = recordCreatedWorktreeInPlan({
      planJson: JSON.stringify([
        {
          workspaceRoot: "/repo",
          environment: "worktree",
          worktreeRef: "0123456789abcdef",
          newBranch: null,
          plannedWorktreePath: "/worktrees/detached",
          ownershipPreflightPassed: true,
          ids: {
            threadId: "agent:detached-child",
            compensateCommandId: "agent:detached-child:delete",
          },
        },
      ]),
      operationId,
      index: 0,
      workspaceRoot: "/repo",
      path: "/worktrees/detached",
      branch: null,
      token: "detached-owner",
      gitDir: "/repo/.git/worktrees/detached",
      head: "0123456789abcdef",
      recordedAt: "2026-07-20T00:00:00.000Z",
    });

    expect(parseRecoverableCreationPlan(planJson, operationId)[0]).toMatchObject({
      worktreeRef: "0123456789abcdef",
      newBranch: null,
      worktreeOwnership: { branch: null, head: "0123456789abcdef" },
    });
  });
});

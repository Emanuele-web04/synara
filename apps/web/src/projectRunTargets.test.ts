import { ProjectId, WorktreeWorkspaceId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { buildWorkspaceProjectRunInput, selectPrimaryProjectRunCommand } from "./projectRunTargets";

describe("selectPrimaryProjectRunCommand", () => {
  it("prefers a saved regular project script over discovered dev", () => {
    const selected = selectPrimaryProjectRunCommand({
      project: {
        cwd: "/repo",
        scripts: [
          {
            id: "serve",
            name: "Serve",
            command: "pnpm serve",
            icon: "play",
            runOnWorktreeCreate: false,
          },
        ],
      },
      discoveredTargets: [
        {
          cwd: "/repo",
          relativePath: "",
          packageJsonPath: "/repo/package.json",
          scripts: [{ name: "dev", command: "pnpm run dev" }],
        },
      ],
    });

    expect(selected).toMatchObject({
      source: "saved",
      label: "Serve",
      command: "pnpm serve",
      cwd: "/repo",
    });
  });

  it("prefers discovered dev over start", () => {
    const selected = selectPrimaryProjectRunCommand({
      project: { cwd: "/repo", scripts: [] },
      discoveredTargets: [
        {
          cwd: "/repo",
          relativePath: "",
          packageJsonPath: "/repo/package.json",
          scripts: [
            { name: "start", command: "npm run start" },
            { name: "dev", command: "npm run dev" },
          ],
        },
      ],
    });

    expect(selected).toMatchObject({
      source: "discovered",
      label: "dev",
      command: "npm run dev",
    });
  });

  it("falls back to discovered start when dev is unavailable", () => {
    const selected = selectPrimaryProjectRunCommand({
      project: { cwd: "/repo", scripts: [] },
      discoveredTargets: [
        {
          cwd: "/repo/apps/web",
          relativePath: "apps/web",
          packageJsonPath: "/repo/apps/web/package.json",
          scripts: [{ name: "start", command: "yarn start" }],
        },
      ],
    });

    expect(selected).toMatchObject({
      source: "discovered",
      label: "apps/web start",
      command: "yarn start",
      cwd: "/repo/apps/web",
    });
  });

  it("returns null when there is no saved or discovered run command", () => {
    const selected = selectPrimaryProjectRunCommand({
      project: { cwd: "/repo", scripts: [] },
      discoveredTargets: [
        {
          cwd: "/repo",
          relativePath: "",
          packageJsonPath: "/repo/package.json",
          scripts: [{ name: "build", command: "npm run build" }],
        },
      ],
    });

    expect(selected).toBeNull();
  });

  it("builds a workspace-scoped launch from project-owned configuration", () => {
    const runCommand = selectPrimaryProjectRunCommand({
      project: {
        cwd: "/repo",
        scripts: [
          {
            id: "serve",
            name: "Serve",
            command: "pnpm serve",
            icon: "play",
            runOnWorktreeCreate: false,
          },
        ],
      },
    });
    expect(runCommand).not.toBeNull();

    const input = buildWorkspaceProjectRunInput({
      project: { id: ProjectId.makeUnsafe("project-1"), cwd: "/repo" },
      workspace: {
        id: WorktreeWorkspaceId.makeUnsafe("workspace-1"),
        path: "/repo-worktrees/feature",
      },
      runCommand: runCommand!,
    });

    expect(input).toEqual({
      projectId: "project-1",
      workspaceId: "workspace-1",
      command: "pnpm serve",
      cwd: "/repo-worktrees/feature",
      env: {
        SYNARA_PROJECT_ROOT: "/repo",
        SYNARA_WORKTREE_PATH: "/repo-worktrees/feature",
      },
    });
  });

  it("runs a discovered command from the selected workspace rather than the source checkout", () => {
    const runCommand = selectPrimaryProjectRunCommand({
      project: { cwd: "/repo", scripts: [] },
      discoveredTargets: [
        {
          cwd: "/repo/apps/web",
          relativePath: "apps/web",
          packageJsonPath: "/repo/apps/web/package.json",
          scripts: [{ name: "dev", command: "bun run dev" }],
        },
      ],
    });
    expect(runCommand).not.toBeNull();

    const input = buildWorkspaceProjectRunInput({
      project: { id: ProjectId.makeUnsafe("project-1"), cwd: "/repo" },
      workspace: {
        id: WorktreeWorkspaceId.makeUnsafe("workspace-1"),
        path: "/repo-worktrees/feature",
      },
      runCommand: runCommand!,
      commandOverride: "  bun run preview  ",
    });

    expect(runCommand?.cwd).toBe("/repo/apps/web");
    expect(input).toMatchObject({
      workspaceId: "workspace-1",
      command: "bun run preview",
      cwd: "/repo-worktrees/feature",
    });
  });
});

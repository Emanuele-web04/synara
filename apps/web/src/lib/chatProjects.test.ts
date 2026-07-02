// FILE: chatProjects.test.ts
// Purpose: Verifies home chat-container project recognition across new and legacy roots.

import { ProjectId, type OrchestrationShellSnapshot } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useStore } from "../store";
import { ensureHomeChatProject, isHomeChatContainerProject } from "./chatProjects";

const NOW = "2026-06-26T21:00:00.000Z";

function makeShellProject(
  overrides: Partial<OrchestrationShellSnapshot["projects"][number]> = {},
): OrchestrationShellSnapshot["projects"][number] {
  return {
    id: ProjectId.makeUnsafe("project-home-existing"),
    kind: "chat",
    title: "Home",
    workspaceRoot: "/Users/tester",
    defaultModelSelection: null,
    scripts: [],
    isPinned: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeShellSnapshot(
  projects: OrchestrationShellSnapshot["projects"],
): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 1,
    projects,
    threads: [],
    updatedAt: NOW,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  useStore.setState({
    projects: [],
    threadIds: [],
    threads: [],
  });
});

describe("isHomeChatContainerProject", () => {
  it("matches the managed Documents/Synara general-chat root used by older drafts", () => {
    expect(
      isHomeChatContainerProject(
        {
          cwd: "/Users/tester/Documents/Synara",
          kind: "chat",
          name: "Home",
          remoteName: "Home",
        },
        {
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
        },
      ),
    ).toBe(true);
  });

  it("matches Codex-style date/slug chat workspaces under Documents/Synara", () => {
    expect(
      isHomeChatContainerProject(
        {
          cwd: "/Users/tester/Documents/Synara/2026-06-11/yes-it-takes-all-the-skills",
          kind: "chat",
          name: "Yes it takes",
          remoteName: "Yes it takes",
        },
        {
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
        },
      ),
    ).toBe(true);
  });

  it("keeps recognizing the legacy home-directory chat container during migration", () => {
    expect(
      isHomeChatContainerProject(
        {
          cwd: "/Users/tester",
          kind: "chat",
          name: "Home",
          remoteName: "Home",
        },
        {
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
        },
      ),
    ).toBe(true);
  });

  it("does not classify ordinary projects under Documents/Synara as home chat containers", () => {
    expect(
      isHomeChatContainerProject(
        {
          cwd: "/Users/tester/Documents/Synara",
          kind: "project",
          name: "Synara",
          remoteName: "Synara",
        },
        {
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
        },
      ),
    ).toBe(false);
  });

  it("does not classify ordinary projects under date/slug chat folders", () => {
    expect(
      isHomeChatContainerProject(
        {
          cwd: "/Users/tester/Documents/Synara/2026-06-11/yes-it-takes-all-the-skills",
          kind: "project",
          name: "yes-it-takes-all-the-skills",
          remoteName: "yes-it-takes-all-the-skills",
        },
        {
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
        },
      ),
    ).toBe(false);
  });

  it("recovers a stale duplicate when the snapshot shows an existing Home chat container", async () => {
    const existingProjectId = ProjectId.makeUnsafe("project-home-existing");
    const dispatchCommand = vi.fn(async (command: { type: string }) => {
      if (command.type === "project.create") {
        throw new Error(
          `Orchestration command invariant failed (project.create): Project '${existingProjectId}' already uses workspace root '/Users/tester'.`,
        );
      }
    });
    const getShellSnapshot = vi.fn(async () =>
      makeShellSnapshot([makeShellProject({ id: existingProjectId })]),
    );
    vi.stubGlobal("window", {
      nativeApi: {
        orchestration: {
          dispatchCommand,
          getShellSnapshot,
        },
      },
    });

    const projectId = await ensureHomeChatProject({
      homeDir: "/Users/tester",
      chatWorkspaceRoot: "/Users/tester/Documents/Synara",
    });

    expect(projectId).toBe(existingProjectId);
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "project.create",
        kind: "chat",
        workspaceRoot: "/Users/tester",
      }),
    );
    expect(dispatchCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "project.meta.update",
      }),
    );
  });

  it("normalizes a recognizable legacy Home duplicate before returning it", async () => {
    const existingProjectId = ProjectId.makeUnsafe("project-home-existing");
    const dispatchCommand = vi.fn(async (command: { type: string }) => {
      if (command.type === "project.create") {
        throw new Error(
          `Orchestration command invariant failed (project.create): Project '${existingProjectId}' already uses workspace root '/Users/tester'.`,
        );
      }
    });
    const getShellSnapshot = vi.fn(async () =>
      makeShellSnapshot([
        makeShellProject({
          id: existingProjectId,
          kind: "project",
          title: "Home",
        }),
      ]),
    );
    vi.stubGlobal("window", {
      nativeApi: {
        orchestration: {
          dispatchCommand,
          getShellSnapshot,
        },
      },
    });

    const projectId = await ensureHomeChatProject({
      homeDir: "/Users/tester",
      chatWorkspaceRoot: "/Users/tester/Documents/Synara",
    });

    expect(projectId).toBe(existingProjectId);
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "project.meta.update",
        projectId: existingProjectId,
        kind: "chat",
        title: "Home",
      }),
    );
  });

  it("does not convert an ordinary duplicate home-folder project into Home chat", async () => {
    const existingProjectId = ProjectId.makeUnsafe("project-home-existing");
    const duplicateError = new Error(
      `Orchestration command invariant failed (project.create): Project '${existingProjectId}' already uses workspace root '/Users/tester'.`,
    );
    const dispatchCommand = vi.fn(async (command: { type: string }) => {
      if (command.type === "project.create") {
        throw duplicateError;
      }
    });
    const getShellSnapshot = vi.fn(async () =>
      makeShellSnapshot([
        makeShellProject({
          id: existingProjectId,
          kind: "project",
          title: "tester",
        }),
      ]),
    );
    vi.stubGlobal("window", {
      nativeApi: {
        orchestration: {
          dispatchCommand,
          getShellSnapshot,
        },
      },
    });

    await expect(
      ensureHomeChatProject({
        homeDir: "/Users/tester",
        chatWorkspaceRoot: "/Users/tester/Documents/Synara",
      }),
    ).rejects.toThrow(duplicateError.message);
    expect(dispatchCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "project.meta.update",
      }),
    );
  });
});

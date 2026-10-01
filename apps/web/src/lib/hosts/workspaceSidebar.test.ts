import { describe, expect, it } from "vitest";
import { ProjectId, ThreadId } from "@synara/contracts";
import type { Project } from "../../types";
import type { WorkspaceSummary } from "./workspaceFrame";
import type { WorkspaceSession } from "./workspaceSessions";
import {
  mergeSidebarChats,
  mergeSidebarProjects,
  remoteSidebarProjects,
  workspaceActivityRows,
} from "./workspaceSidebar";

const project = (id = "same-project"): Project => ({
  id: ProjectId.makeUnsafe(id),
  kind: "project",
  name: "Synara",
  remoteName: "Synara",
  folderName: "synara",
  localName: null,
  cwd: "/workspace/synara",
  defaultModelSelection: null,
  expanded: true,
  scripts: [],
  createdAt: "2026-09-28T00:00:00Z",
});
const thread = (date: string, projectId = "same-project"): WorkspaceSummary["threads"][number] => ({
  id: ThreadId.makeUnsafe("same-thread"),
  projectId: ProjectId.makeUnsafe(projectId),
  title: "Same title",
  modelSelection: { provider: "codex", model: "fixture" },
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  session: null,
  createdAt: date,
  updatedAt: date,
  latestUserMessageAt: date,
  latestTurn: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  hasLiveTailWork: false,
  status: null,
});
const session = (environmentId = "mini"): WorkspaceSession => ({
  host: {
    hostId: environmentId,
    hostName: "Mac mini",
    wsPath: `/ws/remote/${environmentId}`,
    executionScope: {
      environmentId,
      accountAuthority: "https://account.example",
      userId: "alice",
      organizationId: "org",
      channel: "dev",
    },
  },
  summary: {
    state: "open",
    path: "/",
    projects: [{ ...project(), section: "projects" }],
    threads: [thread("2026-09-29T00:00:00Z")],
  },
});

describe("unified workspace sidebar", () => {
  it("keeps empty remote projects and technical containers out of Projects while retaining the active new project", () => {
    let host = session();
    host = {
      ...host,
      summary: {
        ...host.summary!,
        projects: [
          ...host.summary!.projects,
          { ...project("empty"), section: "projects" },
          { ...project("active-empty"), section: "projects" },
          { ...project("home"), kind: "chat", section: "chats" },
          { ...project("orphan"), kind: "chat", section: "projects", isPinned: true },
          { ...project("studio"), kind: "studio", section: "studio", isPinned: true },
          { ...project("hub"), kind: "group", section: "studio", isPinned: true },
        ],
        activeProjectId: "active-empty",
        threads: [...host.summary!.threads, thread("2026-09-29T01:00:00Z", "home")],
      },
    };
    expect(remoteSidebarProjects([host], "studio").map((entry) => entry.project.id)).toEqual([
      "studio",
      "hub",
    ]);
    expect(remoteSidebarProjects([host]).map((entry) => entry.project.id)).toEqual([
      "same-project",
      "active-empty",
    ]);
  });
  it("sorts across computers without conflating equal IDs, paths, or names and supports one manual order", () => {
    const remote = remoteSidebarProjects([session("mini"), session("other")]);
    const input = {
      localEnvironmentId: "book",
      projects: [project()],
      threads: [thread("2026-09-28T01:00:00Z")],
      remote,
      preferredOrder: [],
      sortOrder: "updated_at" as const,
    };
    const merged = mergeSidebarProjects(input);
    expect(merged).toHaveLength(3);
    expect(new Set(merged.map((entry) => entry.key)).size).toBe(3);
    expect(merged.map((entry) => entry.session?.host.hostId ?? "book")).toEqual([
      "mini",
      "other",
      "book",
    ]);
    const preferredOrder = [merged[0]!.key, merged[2]!.key, merged[1]!.key];
    expect(
      mergeSidebarProjects({ ...input, sortOrder: "manual", preferredOrder }).map(
        (entry) => entry.key,
      ),
    ).toEqual(preferredOrder);
  });
  it("mixes home chats by activity and keeps Studio separate", () => {
    let host = session();
    host = {
      ...host,
      summary: {
        ...host.summary!,
        projects: [
          { ...project(), kind: "chat", section: "chats" },
          { ...project("studio"), kind: "studio", section: "studio", isPinned: true },
          { ...project("hub"), kind: "group", section: "studio", isPinned: true },
        ],
        threads: [...host.summary!.threads, thread("2026-09-29T01:00:00Z", "studio")],
      },
    };
    const rows = mergeSidebarChats({
      localEnvironmentId: "book",
      threads: [thread("2026-09-28T01:00:00Z")],
      sessions: [host],
      section: "chats",
      sortOrder: "updated_at",
    });
    expect(rows.map((entry) => entry.session?.host.hostId ?? "book")).toEqual(["mini", "book"]);
    expect(new Set(rows.map((entry) => entry.key)).size).toBe(2);
  });
  it("keeps subagent families together and hides pinned and orphan remote chats", () => {
    const parent = thread("2026-09-29T00:00:00Z");
    const child = {
      ...parent,
      id: ThreadId.makeUnsafe("child"),
      parentThreadId: parent.id,
      updatedAt: "2026-09-29T03:00:00Z",
    };
    const host: WorkspaceSession = {
      ...session(),
      summary: {
        ...session().summary!,
        projects: [{ ...project(), kind: "chat", section: "chats" }],
        threads: [
          parent,
          child,
          {
            ...parent,
            id: ThreadId.makeUnsafe("orphan"),
            parentThreadId: ThreadId.makeUnsafe("missing"),
          },
          { ...parent, id: ThreadId.makeUnsafe("pinned"), isPinned: true },
        ],
      },
    };
    const input = {
      localEnvironmentId: "book",
      threads: [thread("2026-09-29T01:00:00Z")],
      sessions: [host],
      section: "chats" as const,
      sortOrder: "updated_at" as const,
    };
    expect(mergeSidebarChats(input).map((entry) => entry.thread.id)).toEqual([
      "same-thread",
      "same-thread",
    ]);
    const rows = mergeSidebarChats({
      ...input,
      selectedByEnvironment: new Map([["mini", child.id]]),
    });
    expect(
      rows.map((entry) => [entry.session?.host.hostId ?? "book", entry.thread.id, entry.depth]),
    ).toEqual([
      ["book", "same-thread", 0],
      ["mini", "same-thread", 0],
      ["mini", "child", 1],
    ]);
    expect(rows[2]!.rootKey).toBe(rows[1]!.key);
  });
  it("qualifies Activity rows and parent references while preserving original routing identity", () => {
    let first = session("mini");
    first = {
      ...first,
      summary: {
        ...first.summary!,
        threads: [
          thread("2026-09-29T00:00:00Z"),
          {
            ...thread("2026-09-29T01:00:00Z"),
            id: ThreadId.makeUnsafe("child"),
            parentThreadId: ThreadId.makeUnsafe("same-thread"),
          },
        ],
      },
    };
    const activity = workspaceActivityRows([first, session("other")]);
    expect(activity.threads).toHaveLength(3);
    expect(new Set(activity.threads.map((row) => row.id)).size).toBe(3);
    expect(activity.threads[1]!.parentThreadId).toBe(activity.threads[0]!.id);
    expect(activity.remoteById.get(activity.threads[0]!.id)?.thread.id).toBe("same-thread");
    expect(activity.remoteById.get(activity.threads[2]!.id)?.session?.host.hostId).toBe("other");
    expect(activity.projectById.size).toBe(2);
  });
});

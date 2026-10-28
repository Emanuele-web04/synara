import { describe, expect, it } from "vitest";
import { ProjectId, ThreadId } from "@synara/contracts";
import type { Project } from "../../types";
import type { WorkspaceSummary } from "./workspaceFrame";
import type { WorkspaceSession } from "./workspaceSessions";
import {
  deriveWorkspaceProjectThreadRows,
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
  pendingBackgroundWorkCount: 0,
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
  it("hides remote subagents and pinned chats while revealing the selected child’s root", () => {
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
    const roots = Array.from({ length: 6 }, (_, index) => ({
      ...parent,
      id: ThreadId.makeUnsafe(`root-${index}`),
      updatedAt: `2026-09-29T0${index}:00:00Z`,
    }));
    const result = deriveWorkspaceProjectThreadRows({
      entry: {
        key: "mini-project",
        project: host.summary!.projects[0]!,
        threads: [...roots, { ...child, parentThreadId: roots[0]!.id }],
        session: host,
      },
      sortOrder: "updated_at",
      activeThreadId: child.id,
      extraPages: 0,
    });
    expect(result.visibleEntries.map(({ row }) => row.thread.id)).toEqual([
      "root-5",
      "root-4",
      "root-3",
      "root-2",
      "root-1",
      "root-0",
    ]);
    expect(result.canShowMore).toBe(false);
  });
  it("keeps optimistic Done and Undo scoped to their owner without changing authoritative timestamps", () => {
    const baseThread = thread("2026-09-29T00:00:00Z");
    const completedAt = "2026-09-29T01:00:00Z";
    const first: WorkspaceSession = {
      ...session("mini"),
      summary: {
        ...session("mini").summary!,
        threads: [{ ...baseThread, settledAt: null, settledOverride: true }],
      },
    };
    const second: WorkspaceSession = {
      ...session("other"),
      summary: {
        ...session("other").summary!,
        threads: [{ ...baseThread, settledAt: completedAt, settledOverride: false }],
      },
    };
    const activity = workspaceActivityRows([first, second]);
    const [done, undone] = activity.threads;
    expect(activity.settledOverrideByThreadId).toEqual(
      new Map([
        [done!.id, true],
        [undone!.id, false],
      ]),
    );
    expect(activity.settledOverrideByThreadId.has(baseThread.id)).toBe(false);
    expect(done!.settledAt).toBeNull();
    expect(undone!.settledAt).toBe(completedAt);
    expect(activity.remoteById.get(done!.id)?.session).toBe(first);
    expect(activity.remoteById.get(undone!.id)?.session).toBe(second);
    expect(
      workspaceActivityRows([session("mini"), session("other")]).settledOverrideByThreadId.size,
    ).toBe(0);
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

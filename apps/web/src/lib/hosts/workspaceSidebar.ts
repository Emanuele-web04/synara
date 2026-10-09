import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "../../appSettings";
import {
  buildProjectThreadTree,
  getProjectSortTimestamp,
  getUnpinnedThreadsForSidebar,
  getVisibleSidebarEntriesForPreview,
  resolveSidebarThreadListPaging,
  sortThreadsForSidebar,
} from "../../components/Sidebar.logic";
import type { Project, SidebarThreadSummary } from "../../types";
import { checkoutKey } from "../projectCatalog/model";
import type { WorkspaceSummary } from "./workspaceFrame";
import type { WorkspaceSession } from "./workspaceSessions";
import { ProjectId, ThreadId } from "@synara/contracts";

export interface WorkspaceProjectEntry {
  readonly key: string;
  readonly project: WorkspaceSummary["projects"][number];
  readonly threads: readonly WorkspaceSummary["threads"][number][];
  readonly session: WorkspaceSession | null;
}

export interface WorkspaceThreadEntry {
  readonly key: string;
  readonly depth?: number;
  readonly rootKey?: string;
  readonly thread: WorkspaceSummary["threads"][number];
  readonly session: WorkspaceSession | null;
}

export function workspaceThreadKey(environmentId: string, threadId: string): string {
  return JSON.stringify([environmentId, threadId]);
}

/** Shared paging keeps remote project rows and keyboard destinations in the same order. */
export function deriveWorkspaceProjectThreadRows(input: {
  entry: WorkspaceProjectEntry;
  sortOrder: SidebarThreadSortOrder;
  activeThreadId?: ThreadId | undefined;
  extraPages: number;
}) {
  const threads = getUnpinnedThreadsForSidebar(
    input.entry.threads,
    input.entry.threads.filter((thread) => thread.isPinned).map((thread) => thread.id),
  );
  const rows = buildProjectThreadTree({
    threads: sortThreadsForSidebar(threads, input.sortOrder),
    forceVisibleThreadId: input.activeThreadId,
  });
  const paging = resolveSidebarThreadListPaging({
    totalCount: rows.length,
    baseLimit: 5,
    pageSize: 5,
    requestedExtraPages: input.extraPages,
  });
  const { visibleEntries } = getVisibleSidebarEntriesForPreview({
    entries: rows.map((row) => ({ rowId: row.thread.id, rootRowId: row.rootThreadId, row })),
    activeEntryId: input.activeThreadId,
    previewLimit: paging.previewLimit,
  });
  return {
    visibleEntries,
    paging,
    canShowMore: paging.canShowMore && visibleEntries.length < rows.length,
  };
}

export function remoteSidebarProjects(
  sessions: readonly WorkspaceSession[],
  section: "projects" | "studio" = "projects",
): WorkspaceProjectEntry[] {
  return sessions.flatMap((session) => {
    const environmentId = session.host.executionScope.environmentId;
    const threadsByProject = new Map<string, WorkspaceSummary["threads"][number][]>();
    for (const thread of session.summary?.threads ?? []) {
      if (thread.archivedAt) continue;
      const threads = threadsByProject.get(thread.projectId) ?? [];
      threads.push(thread);
      threadsByProject.set(thread.projectId, threads);
    }
    return (session.summary?.projects ?? []).flatMap((project) => {
      const threads = threadsByProject.get(project.id) ?? [];
      // Connecting a computer doesn't import its entire empty project catalog into navigation.
      if (
        project.section !== section ||
        project.kind === "chat" ||
        (!threads.length && !project.isPinned && session.summary?.activeProjectId !== project.id)
      )
        return [];
      return [
        { key: checkoutKey({ environmentId, projectId: project.id }), project, threads, session },
      ];
    });
  });
}

export function mergeSidebarProjects(input: {
  localEnvironmentId: string;
  projects: readonly Project[];
  threads: readonly SidebarThreadSummary[];
  remote: readonly WorkspaceProjectEntry[];
  sortOrder: SidebarProjectSortOrder;
  preferredOrder: readonly string[];
}): WorkspaceProjectEntry[] {
  const localThreads = new Map<string, WorkspaceSummary["threads"][number][]>();
  for (const thread of input.threads) {
    const threads = localThreads.get(thread.projectId) ?? [];
    threads.push({ ...thread, status: null });
    localThreads.set(thread.projectId, threads);
  }
  const entries: WorkspaceProjectEntry[] = [
    ...input.projects.map((project) => ({
      key: checkoutKey({ environmentId: input.localEnvironmentId, projectId: project.id }),
      project: { ...project, section: "projects" as const },
      threads: localThreads.get(project.id) ?? [],
      session: null,
    })),
    ...input.remote,
  ];
  const order = new Map(input.preferredOrder.map((key, index) => [key, index]));
  const fallbackOrder = new Map(entries.map((entry, index) => [entry.key, index]));
  const sortOrder = input.sortOrder;
  const timestamps = new Map(
    entries.map((entry) => [
      entry.key,
      getProjectSortTimestamp(
        entry.project,
        entry.threads,
        sortOrder === "manual" ? "updated_at" : sortOrder,
      ),
    ]),
  );
  return entries.toSorted((a, b) => {
    const pinned = Number(Boolean(b.project.isPinned)) - Number(Boolean(a.project.isPinned));
    if (pinned) return pinned;
    if (sortOrder === "manual") {
      const aIndex = order.get(a.key);
      const bIndex = order.get(b.key);
      if (aIndex !== undefined || bIndex !== undefined)
        return (aIndex ?? Number.MAX_SAFE_INTEGER) - (bIndex ?? Number.MAX_SAFE_INTEGER);
      // Preserve local manual order; every connected row can be moved in the same list.
      return fallbackOrder.get(a.key)! - fallbackOrder.get(b.key)!;
    }
    const left = timestamps.get(a.key)!;
    const right = timestamps.get(b.key)!;
    return (
      (left === right ? 0 : left > right ? -1 : 1) ||
      a.project.name.localeCompare(b.project.name) ||
      a.key.localeCompare(b.key)
    );
  });
}

export function mergeSidebarChats(input: {
  localEnvironmentId: string;
  threads: readonly SidebarThreadSummary[];
  sessions: readonly WorkspaceSession[];
  section: "chats" | "studio";
  sortOrder: SidebarThreadSortOrder;
  selectedByEnvironment?: ReadonlyMap<string, ThreadId>;
}): WorkspaceThreadEntry[] {
  const roots: (WorkspaceSummary["threads"][number] & { rows: WorkspaceThreadEntry[] })[] = [];
  const append = (
    environmentId: string,
    threads: readonly WorkspaceSummary["threads"][number][],
    session: WorkspaceSession | null,
  ) => {
    const rows = buildProjectThreadTree({
      threads: sortThreadsForSidebar(threads, input.sortOrder),
      forceVisibleThreadId: input.selectedByEnvironment?.get(environmentId),
    });
    let family: WorkspaceThreadEntry[] = [];
    for (const row of rows) {
      if (row.depth === 0) {
        family = [];
        roots.push({ ...row.thread, rows: family });
      }
      family.push({
        key: workspaceThreadKey(environmentId, row.thread.id),
        rootKey: workspaceThreadKey(environmentId, row.rootThreadId),
        depth: row.depth,
        thread: row.thread,
        session,
      });
    }
  };
  append(
    input.localEnvironmentId,
    input.threads.map((thread) => ({ ...thread, status: null })),
    null,
  );
  for (const session of input.sessions) {
    const projectIds = new Set(
      session.summary?.projects
        .filter((project) => project.section === input.section)
        .map((project) => project.id),
    );
    const sectionThreads = (session.summary?.threads ?? []).filter(
      (thread) => !thread.archivedAt && projectIds.has(thread.projectId),
    );
    append(
      session.host.executionScope.environmentId,
      getUnpinnedThreadsForSidebar(
        sectionThreads,
        sectionThreads.filter((thread) => thread.isPinned).map((thread) => thread.id),
      ),
      session,
    );
  }
  // Sort roots across computers while keeping revealed subagent families together.
  return sortThreadsForSidebar(roots, input.sortOrder).flatMap((root) => root.rows);
}

/** Activity presentation uses scoped keys; mutations still belong to the original runtime. */
export function workspaceActivityRows(sessions: readonly WorkspaceSession[]) {
  const projectById = new Map<ProjectId, Project>();
  const remoteById = new Map<ThreadId, WorkspaceThreadEntry>();
  const threads: SidebarThreadSummary[] = [];
  for (const session of sessions) {
    const environmentId = session.host.executionScope.environmentId;
    const threadKey = (id: string) =>
      ThreadId.makeUnsafe(`workspace:${JSON.stringify([environmentId, id])}`);
    const projectKey = (id: string) =>
      ProjectId.makeUnsafe(`workspace:${checkoutKey({ environmentId, projectId: id })}`);
    const projects = (session.summary?.projects ?? []).filter(
      (project) => project.section !== "studio",
    );
    const projectIds = new Set(projects.map((project) => project.id));
    for (const project of projects) {
      projectById.set(projectKey(project.id), {
        ...project,
        id: projectKey(project.id),
        name: project.name,
        remoteName: project.name,
        folderName: project.name,
        localName: null,
        expanded: true,
        scripts: [],
        defaultModelSelection: null,
      });
    }
    for (const thread of session.summary?.threads ?? []) {
      if (thread.archivedAt || !projectIds.has(thread.projectId)) continue;
      const id = threadKey(thread.id);
      remoteById.set(id, { key: id, thread, session });
      threads.push({
        ...thread,
        id,
        projectId: projectKey(thread.projectId),
        ...(thread.parentThreadId ? { parentThreadId: threadKey(thread.parentThreadId) } : {}),
      });
    }
  }
  return { threads, projectById, remoteById };
}

// FILE: SidebarGroupsSurface.browser.tsx
// Purpose: Verifies the Groups sidebar surface — empty state, group expansion,
//          coordinator row ordering, and legacy Studio container adoption.
// Layer: Browser UI test

import "../index.css";

import { ProjectId, ThreadId, type ProjectAgentSummary } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  dispatchCommand: vi.fn(async (_command: unknown) => ({ sequence: 1 })),
  listSummaries: vi.fn(
    async (): Promise<{ summaries: ProjectAgentSummary[] }> => ({ summaries: [] }),
  ),
}));

const api = {
  projectAgent: {
    listSummaries: harness.listSummaries,
    onEvent: () => () => {},
  },
  orchestration: { dispatchCommand: harness.dispatchCommand },
};

vi.mock("../nativeApi", () => ({
  readNativeApi: () => api,
  ensureNativeApi: () => api,
  readNativeApiServerCapability: () => false,
  onNativeApiServerCapabilitiesChange: () => () => {},
}));

import { useStore } from "../store";
import { usePinnedProjectAgentsStore } from "../pinnedProjectAgentsStore";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { useProjectAgentSummariesStore } from "./chat/project/useProjectAgentSummaries";
import { isGroupContainerProject } from "../lib/groupProjects";
import type { Project, SidebarThreadSummary } from "../types";
import { SidebarProvider } from "./ui/sidebar";
import {
  resetStudioAdoptionDispatchedIdsForTests,
  SidebarGroupsSurface,
} from "./SidebarGroupsSurface";
import type { SidebarDerivedProjectData } from "./Sidebar.logic";

const GROUPS_ROOT = "/Users/tester/Groups";
const GROUP_A_ID = ProjectId.makeUnsafe("group-a");
const GROUP_B_ID = ProjectId.makeUnsafe("group-b");
const STUDIO_ID = ProjectId.makeUnsafe("studio-legacy");
const THREAD_A = ThreadId.makeUnsafe("thread-a");

function makeGroupProject(input: {
  id: ProjectId;
  kind: Project["kind"];
  name: string;
  cwd: string;
  expanded?: boolean;
}): Project {
  return {
    id: input.id,
    kind: input.kind,
    name: input.name,
    remoteName: input.name,
    folderName: input.name,
    localName: null,
    cwd: input.cwd,
    defaultModelSelection: null,
    expanded: input.expanded ?? false,
    scripts: [],
  };
}

function makeThreadSummary(
  id: ThreadId,
  projectId: ProjectId,
  title: string,
): SidebarThreadSummary {
  return {
    id,
    projectId,
    title,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    latestUserMessageAt: null,
    lastVisitedAt: null,
    archivedAt: null,
    sidechatSourceThreadId: null,
  } as unknown as SidebarThreadSummary;
}

function projectData(thread: SidebarThreadSummary): SidebarDerivedProjectData {
  return {
    allProjectThreadCount: 1,
    projectThreads: [thread],
    orderedProjectThreadIds: [thread.id],
    visibleEntries: [{ kind: "thread", rowId: thread.id, rootRowId: thread.id, thread, depth: 0 }],
    threadListExtraPages: 0,
    canShowMoreThreads: false,
    canShowLessThreads: false,
    activeEntryId: null,
    projectStatus: null,
  };
}

function emptyProjectData(): SidebarDerivedProjectData {
  return {
    allProjectThreadCount: 0,
    projectThreads: [],
    orderedProjectThreadIds: [],
    visibleEntries: [],
    threadListExtraPages: 0,
    canShowMoreThreads: false,
    canShowLessThreads: false,
    activeEntryId: null,
    projectStatus: null,
  };
}

const PATHS = {
  homeDir: "/Users/tester",
  chatWorkspaceRoot: "/Users/tester/Chats",
  studioWorkspaceRoot: "/Users/tester/Studio",
  groupsWorkspaceRoot: GROUPS_ROOT,
};

function Harness(props: { threadsHydrated: boolean; callbacks: Callbacks }) {
  const projects = useStore((state) => state.projects);
  const groupProjects = projects.filter((project) => isGroupContainerProject(project, PATHS));
  return (
    <SidebarProvider>
      <SidebarGroupsSurface
        groupProjects={groupProjects}
        projectSidebarDataById={props.callbacks.dataById}
        threadsHydrated={props.threadsHydrated}
        visualActiveThreadId={null}
        threadSortOrder="updated_at"
        onThreadSortOrderChange={() => {}}
        renderThreadRow={(thread) => (
          <li key={thread.id} data-testid={`thread-row-${thread.id}`}>
            {thread.title}
          </li>
        )}
        renderListSectionHeader={(label) => <div data-testid="section-header">{label}</div>}
        renderPinnedThreadsSection={() => null}
        onOpenThread={props.callbacks.onOpenThread}
        onOpenGroupSettings={props.callbacks.onOpenGroupSettings}
        onProjectContextMenu={props.callbacks.onProjectContextMenu}
      />
    </SidebarProvider>
  );
}

interface Callbacks {
  dataById: ReadonlyMap<ProjectId, SidebarDerivedProjectData>;
  onOpenThread: (threadId: ThreadId) => void;
  onOpenGroupSettings: (projectId: ProjectId, mode: "onboarding" | "edit") => void;
  onProjectContextMenu: (projectId: ProjectId, position: { x: number; y: number }) => void;
}

function makeCallbacks(
  dataById: ReadonlyMap<ProjectId, SidebarDerivedProjectData> = new Map(),
): Callbacks {
  return {
    dataById,
    onOpenThread: vi.fn(),
    onOpenGroupSettings: vi.fn(),
    onProjectContextMenu: vi.fn(),
  };
}

async function waitForText(text: string): Promise<HTMLElement> {
  let found: HTMLElement | null = null;
  await vi.waitFor(
    () => {
      found =
        Array.from(document.querySelectorAll<HTMLElement>("*")).find(
          (el) => el.children.length === 0 && el.textContent?.trim() === text,
        ) ?? null;
      expect(found, document.body.innerHTML.slice(0, 2500)).not.toBeNull();
    },
    { timeout: 5000 },
  );
  return found!;
}

async function mount(props: { projects: Project[]; threadsHydrated: boolean }) {
  const callbacks = makeCallbacks(
    new Map(
      props.projects.map((project) => [
        project.id,
        project.id === GROUP_A_ID
          ? projectData(makeThreadSummary(THREAD_A, GROUP_A_ID, "Chat one"))
          : emptyProjectData(),
      ]),
    ),
  );
  useStore.setState({ projects: props.projects, threadsHydrated: props.threadsHydrated });
  if (mountedRoot) {
    await mountedRoot.unmount();
    mountedRoot = null;
  }
  mountedRoot = await render(
    <Harness threadsHydrated={props.threadsHydrated} callbacks={callbacks} />,
  );
  return { mounted: mountedRoot, callbacks };
}

let mountedRoot: { unmount(): void | Promise<void> } | null = null;

describe("SidebarGroupsSurface", () => {
  beforeEach(() => {
    harness.dispatchCommand.mockClear();
    harness.listSummaries.mockReset();
    harness.listSummaries.mockResolvedValue({ summaries: [] });
    resetStudioAdoptionDispatchedIdsForTests();
    useStore.setState({ projects: [], threadsHydrated: true });
    useProjectAgentSummariesStore.setState({ summariesByProjectId: new Map(), loaded: true });
    usePinnedProjectAgentsStore.setState({ pinnedProjectAgentIds: [] });
    useWorkspacePathsStore.setState(PATHS);
  });

  afterEach(async () => {
    await mountedRoot?.unmount();
    mountedRoot = null;
  });

  it("shows the Groups empty state before and after hydration", async () => {
    await mount({ projects: [], threadsHydrated: false });
    await waitForText("Loading groups…");

    await mount({ projects: [], threadsHydrated: true });
    await waitForText("No groups yet");
  });

  it("expands a group row to reveal its coordinator row first, then chats", async () => {
    const group = makeGroupProject({
      id: GROUP_A_ID,
      kind: "group",
      name: "Team Alpha",
      cwd: `${GROUPS_ROOT}/team-alpha`,
    });
    await mount({ projects: [group], threadsHydrated: true });

    let groupButton: HTMLButtonElement | null = null;
    await vi.waitFor(
      () => {
        groupButton =
          Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")).find(
            (button) => button.textContent?.includes("Team Alpha"),
          ) ?? null;
        expect(groupButton).not.toBeNull();
      },
      { timeout: 5000 },
    );
    expect(groupButton!.getAttribute("aria-expanded")).toBe("false");

    // Children stay mounted but inert while collapsed.
    const collapsedCoordinatorRow = await waitForText("Set up coordinator");
    expect(collapsedCoordinatorRow.closest("[inert]")).not.toBeNull();

    groupButton!.click();
    await vi.waitFor(() => {
      expect(
        useStore.getState().projects.find((project) => project.id === GROUP_A_ID)?.expanded,
      ).toBe(true);
    });

    const coordinatorRow = await waitForText("Set up coordinator");
    expect(coordinatorRow.closest("[inert]")).toBeNull();
    await waitForText("Chat one");

    // Coordinator row precedes the chat rows.
    const threadRow = document.querySelector<HTMLElement>(`[data-testid="thread-row-${THREAD_A}"]`);
    expect(threadRow).not.toBeNull();
    expect(
      coordinatorRow.compareDocumentPosition(threadRow!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("labels a configured coordinator and opens its thread", async () => {
    const coordinatorThreadId = ThreadId.makeUnsafe("coordinator-thread");
    const group = makeGroupProject({
      id: GROUP_A_ID,
      kind: "group",
      name: "Team Alpha",
      cwd: `${GROUPS_ROOT}/team-alpha`,
      expanded: true,
    });
    harness.listSummaries.mockResolvedValue({
      summaries: [
        {
          projectId: GROUP_A_ID,
          configured: true,
          coordinatorName: "Team lead",
          coordinatorThreadId,
          coordinatorIcon: null,
          coordinatorColor: null,
          coordinatorStatus: "idle",
          revision: 1,
        },
      ],
    });
    const { callbacks } = await mount({ projects: [group], threadsHydrated: true });

    const coordinatorRow = await waitForText("Team lead");
    coordinatorRow.click();
    await vi.waitFor(() => {
      expect(callbacks.onOpenThread).toHaveBeenCalledWith(coordinatorThreadId);
    });
  });

  it("activates the coordinator row from the keyboard", async () => {
    const coordinatorThreadId = ThreadId.makeUnsafe("coordinator-thread");
    const group = makeGroupProject({
      id: GROUP_A_ID,
      kind: "group",
      name: "Team Alpha",
      cwd: `${GROUPS_ROOT}/team-alpha`,
      expanded: true,
    });
    harness.listSummaries.mockResolvedValue({
      summaries: [
        {
          projectId: GROUP_A_ID,
          configured: true,
          coordinatorName: "Team lead",
          coordinatorThreadId,
          coordinatorIcon: null,
          coordinatorColor: null,
          coordinatorStatus: "idle",
          revision: 1,
        },
      ],
    });
    const { callbacks } = await mount({ projects: [group], threadsHydrated: true });

    const label = await waitForText("Team lead");
    const coordinatorRow = label.closest<HTMLElement>('[role="button"]');
    expect(coordinatorRow).not.toBeNull();
    coordinatorRow!.focus();
    coordinatorRow!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    coordinatorRow!.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await vi.waitFor(() => {
      expect(callbacks.onOpenThread).toHaveBeenCalledWith(coordinatorThreadId);
    });
    expect(callbacks.onOpenThread).toHaveBeenCalledTimes(2);
  });

  it("shows just the coordinator row in an expanded group with no chats", async () => {
    const group = makeGroupProject({
      id: GROUP_B_ID,
      kind: "group",
      name: "Empty Team",
      cwd: `${GROUPS_ROOT}/empty-team`,
      expanded: true,
    });
    await mount({ projects: [group], threadsHydrated: true });

    const coordinatorRow = await waitForText("Set up coordinator");
    expect(coordinatorRow.closest("[inert]")).toBeNull();
    // The coordinator starts a group's threads — no per-group new-chat affordance
    // and no empty-list placeholder row below it.
    expect(
      Array.from(document.querySelectorAll<HTMLElement>("*")).find(
        (el) => el.children.length === 0 && el.textContent?.trim() === "New group chat",
      ),
    ).toBeUndefined();
    expect(
      Array.from(document.querySelectorAll<HTMLElement>("*")).find(
        (el) => el.children.length === 0 && el.textContent?.trim() === "No group chats yet",
      ),
    ).toBeUndefined();
    expect(
      document.querySelector<HTMLButtonElement>('button[aria-label*="New group chat"]'),
    ).toBeNull();
  });

  it("adopts the legacy Studio container by retitling it Groups once across remounts", async () => {
    const legacyStudio = makeGroupProject({
      id: STUDIO_ID,
      kind: "studio",
      name: "Studio",
      cwd: "/Users/tester/Studio",
    });
    await mount({ projects: [legacyStudio], threadsHydrated: true });

    await vi.waitFor(() => {
      expect(harness.dispatchCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "project.meta.update",
          projectId: STUDIO_ID,
          title: "Groups",
        }),
      );
    });

    // The adoption marks the id for the session, so unmounting and remounting the
    // surface must not re-dispatch the rename.
    await mount({ projects: [legacyStudio], threadsHydrated: true });

    const calls = harness.dispatchCommand.mock.calls as ReadonlyArray<[unknown]>;
    const renameCalls = calls.filter(
      (call) => (call[0] as { type?: string } | undefined)?.type === "project.meta.update",
    );
    expect(renameCalls).toHaveLength(1);
  });
});

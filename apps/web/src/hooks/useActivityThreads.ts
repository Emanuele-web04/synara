// FILE: useActivityThreads.ts
// Purpose: The thread lists the sidebar's Activity view, its unread bell, and the Inbox
//          read, so every surface agrees on which threads count.
// Layer: Web hook over the normalized store
// Exports: useActivityThreads

import { useMemo } from "react";

import { useCoordinatorThreadIds } from "../components/chat/project/useProjectAgentSummaries";
import {
  excludeHiddenProjectAgentCoordinatorThreads,
  partitionSidebarThreadsByProjectIds,
} from "../components/Sidebar.logic";
import { collectGroupProjectIds } from "../lib/groupProjects";
import { useStore, type AppState } from "../store";
import { createSidebarThreadSummariesSelector, isSidebarThreadVisible } from "../storeSelectors";
import type { SidebarThreadSummary } from "../types";
import { useWorkspacePathsStore } from "../workspacePathsStore";

interface ActivityThreads {
  readonly sidebarThreads: readonly SidebarThreadSummary[];
  /** Every thread except hidden Group coordinators. */
  readonly displaySidebarThreads: readonly SidebarThreadSummary[];
  readonly groupProjectIdSet: ReturnType<typeof collectGroupProjectIds>;
  readonly groupThreads: readonly SidebarThreadSummary[];
  /** Activity, its unread bell, and the Inbox read this list, so a badge can never point
   *  at a row the lists are hiding. */
  readonly visibleNonGroupThreads: readonly SidebarThreadSummary[];
  /** Activity keeps snoozed rows accessible in its separate section. */
  readonly activityNonGroupThreads: readonly SidebarThreadSummary[];
}

type ActivityThreadInputs = readonly [
  sidebarThreads: readonly SidebarThreadSummary[],
  coordinatorThreadIds: ReadonlySet<string>,
  projects: AppState["projects"],
  homeDir: string | null,
  chatWorkspaceRoot: string | null,
  studioWorkspaceRoot: string | null,
  groupsWorkspaceRoot: string | null,
  hideAutomationRunThreads: boolean,
];

// Shared by every caller, so the sidebar and the Inbox (mounted together) read one set of
// lists: the selector returns the same array for both, and the derivation below runs once
// per change instead of once per caller.
const selectSidebarThreads = createSidebarThreadSummariesSelector();
let lastDerived: {
  readonly inputs: ActivityThreadInputs;
  readonly result: ActivityThreads;
} | null = null;

function deriveActivityThreads(inputs: ActivityThreadInputs): ActivityThreads {
  if (lastDerived && inputs.every((input, index) => input === lastDerived?.inputs[index])) {
    return lastDerived.result;
  }
  const [
    sidebarThreads,
    coordinatorThreadIds,
    projects,
    homeDir,
    chatWorkspaceRoot,
    studioWorkspaceRoot,
    groupsWorkspaceRoot,
    hideAutomationRunThreads,
  ] = inputs;
  const displaySidebarThreads = excludeHiddenProjectAgentCoordinatorThreads(
    sidebarThreads,
    coordinatorThreadIds,
  );
  const groupProjectIdSet = collectGroupProjectIds(projects, {
    homeDir,
    chatWorkspaceRoot,
    studioWorkspaceRoot,
    groupsWorkspaceRoot,
  });
  const { nonGroupThreads, groupThreads } = partitionSidebarThreadsByProjectIds(
    displaySidebarThreads,
    groupProjectIdSet,
  );
  const result: ActivityThreads = {
    sidebarThreads,
    displaySidebarThreads,
    groupProjectIdSet,
    groupThreads,
    visibleNonGroupThreads: nonGroupThreads.filter((thread) =>
      isSidebarThreadVisible(thread, { hideAutomationRunThreads }),
    ),
    activityNonGroupThreads: nonGroupThreads.filter((thread) =>
      isSidebarThreadVisible(thread, { hideAutomationRunThreads, includeSnoozed: true }),
    ),
  };
  lastDerived = { inputs, result };
  return result;
}

/** Callers pass the automation-run visibility setting they already read. */
export function useActivityThreads({
  hideAutomationRunThreads,
}: {
  readonly hideAutomationRunThreads: boolean;
}): ActivityThreads {
  const projects = useStore((store) => store.projects);
  const homeDir = useWorkspacePathsStore((store) => store.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((store) => store.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspacePathsStore((store) => store.studioWorkspaceRoot);
  const groupsWorkspaceRoot = useWorkspacePathsStore((store) => store.groupsWorkspaceRoot);
  const sidebarThreads = useStore(selectSidebarThreads);
  const coordinatorThreadIds = useCoordinatorThreadIds();
  return useMemo(
    () =>
      deriveActivityThreads([
        sidebarThreads,
        coordinatorThreadIds,
        projects,
        homeDir,
        chatWorkspaceRoot,
        studioWorkspaceRoot,
        groupsWorkspaceRoot,
        hideAutomationRunThreads,
      ]),
    [
      chatWorkspaceRoot,
      coordinatorThreadIds,
      groupsWorkspaceRoot,
      hideAutomationRunThreads,
      homeDir,
      projects,
      sidebarThreads,
      studioWorkspaceRoot,
    ],
  );
}

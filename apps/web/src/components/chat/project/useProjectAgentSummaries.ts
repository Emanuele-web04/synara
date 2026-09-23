import {
  type ProjectAgentOverview,
  type ProjectAgentStreamEvent,
  type ProjectAgentSummary,
  type ProjectId,
} from "@synara/contracts";
import { useEffect } from "react";
import { create } from "zustand";

import { readNativeApi } from "~/nativeApi";
import { projectAgentOverviewConfigured } from "./projectAgentOverview.logic";

type ProjectAgentSummariesState = {
  summariesByProjectId: ReadonlyMap<ProjectId, ProjectAgentSummary>;
  loaded: boolean;
  setSummaries: (summaries: readonly ProjectAgentSummary[]) => void;
  applySummary: (summary: ProjectAgentSummary) => void;
  applyOverview: (overview: ProjectAgentOverview) => void;
  applyEvent: (event: ProjectAgentStreamEvent) => void;
};

function summaryFromOverview(
  overview: ProjectAgentOverview,
  previous?: ProjectAgentSummary,
): ProjectAgentSummary {
  return {
    projectId: overview.projectId,
    configured: projectAgentOverviewConfigured(overview),
    coordinatorName: overview.config?.coordinatorName ?? null,
    coordinatorThreadId: overview.config?.coordinatorThreadId ?? null,
    coordinatorIcon: overview.config?.coordinatorIcon ?? null,
    coordinatorColor: overview.config?.coordinatorColor ?? null,
    coordinatorStatus: overview.coordinatorStatus,
    revision: overview.config?.revision ?? 0,
    pausedAt: overview.config?.pausedAt ?? null,
    archivedAt: overview.config?.archivedAt ?? null,
    // The overview has no member-index field; only listSummaries knows it.
    memberThreadIds: previous?.memberThreadIds,
    linkedProjectIds: overview.linkedProjectIds,
    // The goal text the dialog writes lives on the config; the authorized goal
    // row is a separate signal — either one counts as "has a goal".
    hasGoal: overview.goal !== null || (overview.config?.goal?.trim().length ?? 0) > 0,
    instructionsConfigured: previous?.instructionsConfigured,
  };
}

export const useProjectAgentSummariesStore = create<ProjectAgentSummariesState>((set) => ({
  summariesByProjectId: new Map(),
  loaded: false,
  setSummaries: (summaries) =>
    set({
      loaded: true,
      summariesByProjectId: new Map(
        summaries.map((summary) => [summary.projectId, summary] as const),
      ),
    }),
  applySummary: (summary) =>
    set((current) => {
      const next = new Map(current.summariesByProjectId);
      next.set(summary.projectId, summary);
      return { summariesByProjectId: next, loaded: true };
    }),
  applyOverview: (overview) =>
    set((current) => {
      const next = new Map(current.summariesByProjectId);
      next.set(
        overview.projectId,
        summaryFromOverview(overview, current.summariesByProjectId.get(overview.projectId)),
      );
      return { summariesByProjectId: next, loaded: true };
    }),
  // Effects (the debounced re-list) stay out of the `set` updaters — a state
  // updater must be pure; scheduling inside one fires on every re-evaluation
  // and can loop the refresh it was meant to coalesce.
  applyEvent: (event) => {
    if (event.type === "snapshot") {
      set((current) => {
        const next = new Map(current.summariesByProjectId);
        next.set(
          event.overview.projectId,
          summaryFromOverview(
            event.overview,
            current.summariesByProjectId.get(event.overview.projectId),
          ),
        );
        return { summariesByProjectId: next };
      });
      return;
    }
    if (event.type === "config-upserted") {
      set((current) => {
        const previous = current.summariesByProjectId.get(event.config.projectId);
        const next = new Map(current.summariesByProjectId);
        next.set(event.config.projectId, {
          projectId: event.config.projectId,
          configured: projectAgentOverviewConfigured({ config: event.config }),
          coordinatorName: event.config.coordinatorName,
          coordinatorThreadId: event.config.coordinatorThreadId,
          coordinatorIcon: event.config.coordinatorIcon ?? null,
          coordinatorColor: event.config.coordinatorColor ?? null,
          coordinatorStatus:
            previous?.coordinatorStatus && previous.coordinatorStatus !== "unconfigured"
              ? previous.coordinatorStatus
              : "idle",
          revision: event.config.revision,
          pausedAt: event.config.pausedAt ?? null,
          archivedAt: event.config.archivedAt ?? null,
          memberThreadIds: previous?.memberThreadIds,
          linkedProjectIds: previous?.linkedProjectIds,
          hasGoal: (event.config.goal?.trim().length ?? 0) > 0 || previous?.hasGoal === true,
          instructionsConfigured: previous?.instructionsConfigured,
        });
        return { summariesByProjectId: next, loaded: true };
      });
      return;
    }
    if (event.type === "goal-upserted") {
      set((current) => {
        const previous = current.summariesByProjectId.get(event.goal.projectId);
        if (!previous?.configured) return current;
        const next = new Map(current.summariesByProjectId);
        next.set(event.goal.projectId, {
          ...previous,
          pausedAt: previous.pausedAt ?? null,
          archivedAt: previous.archivedAt ?? null,
          coordinatorStatus:
            event.goal.status === "paused"
              ? "paused"
              : event.goal.status === "active"
                ? "running"
                : event.goal.status === "stopped"
                  ? "stopped"
                  : previous.coordinatorStatus,
          hasGoal: event.goal.status === "active" || event.goal.status === "paused",
        });
        return { summariesByProjectId: next };
      });
      // A goal stop can't see config.goal here — the debounced re-list lands
      // the authoritative union of both goal signals.
      scheduleProjectAgentSummariesRefresh();
      return;
    }
    if (event.type === "document-head-updated") {
      // instructions.md content feeds the "Write instructions" chip state.
      if (event.head.logicalPath === "instructions.md") {
        scheduleProjectAgentSummariesRefresh();
      }
      return;
    }
    if (event.type === "task-upserted" || event.type === "thread-index-upserted") {
      // Task assignments and index writes change member threads; a coalesced
      // re-list picks them up. activity-appended no longer refreshes — group
      // activity lands dozens of rows per turn and none of them change the
      // summary row.
      scheduleProjectAgentSummariesRefresh();
    }
  },
}));

let summariesLoadPromise: Promise<void> | null = null;

export function coordinatorThreadIdSet(
  summaries: Iterable<ProjectAgentSummary>,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const summary of summaries) {
    if (summary.configured && summary.coordinatorThreadId) {
      ids.add(summary.coordinatorThreadId);
    }
  }
  return ids;
}

// One Set per summaries-map reference: returning a fresh Set each render used to churn
// every downstream memo dep even when no coordinator id changed.
const coordinatorThreadIdSetCache = new WeakMap<
  ReadonlyMap<ProjectId, ProjectAgentSummary>,
  ReadonlySet<string>
>();

function cachedCoordinatorThreadIdSet(
  summariesByProjectId: ReadonlyMap<ProjectId, ProjectAgentSummary>,
): ReadonlySet<string> {
  const cached = coordinatorThreadIdSetCache.get(summariesByProjectId);
  if (cached) return cached;
  const next = coordinatorThreadIdSet(summariesByProjectId.values());
  coordinatorThreadIdSetCache.set(summariesByProjectId, next);
  return next;
}

const SUMMARIES_REFRESH_DEBOUNCE_MS = 400;
let summariesRefreshTimer: ReturnType<typeof setTimeout> | null = null;

// Summaries feed the sidebar's configured/status affordances even for projects
// whose panel is closed, where no open project-agent subscription patches them
// through. The always-on automation stream schedules one coalesced re-list.
function scheduleProjectAgentSummariesRefresh() {
  if (summariesRefreshTimer !== null) return;
  summariesRefreshTimer = setTimeout(() => {
    summariesRefreshTimer = null;
    void loadProjectAgentSummaries();
  }, SUMMARIES_REFRESH_DEBOUNCE_MS);
}

export async function loadProjectAgentSummaries(): Promise<void> {
  if (summariesLoadPromise) return summariesLoadPromise;
  summariesLoadPromise = (async () => {
    const api = readNativeApi();
    if (!api?.projectAgent?.listSummaries) {
      useProjectAgentSummariesStore.getState().setSummaries([]);
      return;
    }
    try {
      const result = await api.projectAgent.listSummaries({});
      useProjectAgentSummariesStore.getState().setSummaries(result.summaries);
    } catch {
      useProjectAgentSummariesStore.getState().setSummaries([]);
    }
  })().finally(() => {
    summariesLoadPromise = null;
  });
  return summariesLoadPromise;
}

export function useProjectAgentSummaries() {
  const summariesByProjectId = useProjectAgentSummariesStore((state) => state.summariesByProjectId);
  const loaded = useProjectAgentSummariesStore((state) => state.loaded);
  const applyOverview = useProjectAgentSummariesStore((state) => state.applyOverview);
  const applyEvent = useProjectAgentSummariesStore((state) => state.applyEvent);

  useEffect(() => {
    void loadProjectAgentSummaries();
    const api = readNativeApi();
    if (!api?.projectAgent) return;
    const unsubscribe = api.projectAgent.onEvent((event) => {
      applyEvent(event);
    });
    const unsubscribeAutomation =
      api.automation?.onEvent((event) => {
        if (
          event.type === "snapshot" ||
          event.type === "definition-upserted" ||
          event.type === "run-upserted"
        ) {
          scheduleProjectAgentSummariesRefresh();
        }
      }) ?? (() => {});
    return () => {
      unsubscribe();
      unsubscribeAutomation();
    };
  }, [applyEvent]);

  return {
    summariesByProjectId,
    loaded,
    applyOverview,
    refresh: loadProjectAgentSummaries,
    summaryFor: (projectId: ProjectId | null | undefined) =>
      projectId ? (summariesByProjectId.get(projectId) ?? null) : null,
    coordinatorThreadIds: cachedCoordinatorThreadIdSet(summariesByProjectId),
  };
}

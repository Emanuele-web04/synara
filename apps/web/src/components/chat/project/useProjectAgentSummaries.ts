import {
  type ProjectAgentOverview,
  type ProjectAgentStreamEvent,
  type ProjectAgentSummary,
  type ProjectId,
} from "@synara/contracts";
import { useEffect } from "react";
import { create } from "zustand";

import { readNativeApi } from "~/nativeApi";

type ProjectAgentSummariesState = {
  summariesByProjectId: ReadonlyMap<ProjectId, ProjectAgentSummary>;
  loaded: boolean;
  setSummaries: (summaries: readonly ProjectAgentSummary[]) => void;
  applySummary: (summary: ProjectAgentSummary) => void;
  applyOverview: (overview: ProjectAgentOverview) => void;
  applyEvent: (event: ProjectAgentStreamEvent) => void;
};

function summaryFromOverview(overview: ProjectAgentOverview): ProjectAgentSummary {
  return {
    projectId: overview.projectId,
    configured: overview.configured,
    coordinatorName: overview.config?.coordinatorName ?? null,
    coordinatorThreadId: overview.config?.coordinatorThreadId ?? null,
    coordinatorIcon: overview.config?.coordinatorIcon ?? null,
    coordinatorColor: overview.config?.coordinatorColor ?? null,
    coordinatorStatus: overview.coordinatorStatus,
    revision: overview.config?.revision ?? 0,
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
      next.set(overview.projectId, summaryFromOverview(overview));
      return { summariesByProjectId: next, loaded: true };
    }),
  applyEvent: (event) =>
    set((current) => {
      if (event.type === "snapshot") {
        const next = new Map(current.summariesByProjectId);
        next.set(event.overview.projectId, summaryFromOverview(event.overview));
        return { summariesByProjectId: next };
      }
      if (event.type === "config-upserted") {
        const previous = current.summariesByProjectId.get(event.config.projectId);
        const next = new Map(current.summariesByProjectId);
        next.set(event.config.projectId, {
          projectId: event.config.projectId,
          configured: true,
          coordinatorName: event.config.coordinatorName,
          coordinatorThreadId: event.config.coordinatorThreadId,
          coordinatorIcon: event.config.coordinatorIcon ?? null,
          coordinatorColor: event.config.coordinatorColor ?? null,
          coordinatorStatus:
            previous?.coordinatorStatus && previous.coordinatorStatus !== "unconfigured"
              ? previous.coordinatorStatus
              : "idle",
          revision: event.config.revision,
        });
        return { summariesByProjectId: next, loaded: true };
      }
      if (event.type === "goal-upserted") {
        const previous = current.summariesByProjectId.get(event.goal.projectId);
        if (!previous?.configured) return current;
        const next = new Map(current.summariesByProjectId);
        next.set(event.goal.projectId, {
          ...previous,
          coordinatorStatus:
            event.goal.status === "paused"
              ? "paused"
              : event.goal.status === "active"
                ? "running"
                : event.goal.status === "stopped"
                  ? "stopped"
                  : previous.coordinatorStatus,
        });
        return { summariesByProjectId: next };
      }
      return current;
    }),
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
    return () => {
      unsubscribe();
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

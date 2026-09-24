import {
  type ModelSelection,
  type ProjectActivity,
  type ProjectAgentDeleteGroupResult,
  type ProjectAgentOverview,
  type ProjectAgentStreamEvent,
  type ProjectAgentWorkerRouting,
  type ProjectDocumentHead,
  type ProjectDocumentRevision,
  type ProjectEvidence,
  type ProjectId,
  type ProjectTask,
  type ProjectThreadIndexEntry,
  type ThreadId,
} from "@synara/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { readNativeApi } from "~/nativeApi";
import {
  projectAgentOverviewWithConfig,
  projectAgentOverviewConfigured,
} from "./projectAgentOverview.logic";
import { useProjectAgentSummariesStore } from "./useProjectAgentSummaries";

export function useProjectAgent(input: {
  readonly projectId: ProjectId | null;
  readonly enabled: boolean;
}) {
  const [overview, setOverview] = useState<ProjectAgentOverview | null>(null);
  const [tasks, setTasks] = useState<ReadonlyArray<ProjectTask>>([]);
  const [activity, setActivity] = useState<ReadonlyArray<ProjectActivity>>([]);
  const [activityCursor, setActivityCursor] = useState<string | null>(null);
  const [documents, setDocuments] = useState<ReadonlyArray<ProjectDocumentHead>>([]);
  const [threads, setThreads] = useState<ReadonlyArray<ProjectThreadIndexEntry>>([]);
  const [error, setError] = useState<string | null>(null);
  // Mutations fail through `setError`, but the state value only lands on the next
  // render — callers that need the message synchronously (toasts) read the ref.
  const errorRef = useRef<string | null>(null);
  const reportError = useCallback((message: string | null) => {
    errorRef.current = message;
    setError(message);
  }, []);
  const readError = useCallback(() => errorRef.current, []);
  const [busy, setBusy] = useState(false);
  const projectIdRef = useRef(input.projectId);
  const loadGeneration = useRef(0);
  // Mirrors the rendered overview's configured flag so stream events can tell a
  // first-configure transition (load the lists) from a relink (index refresh only).
  const overviewConfiguredRef = useRef(false);
  projectIdRef.current = input.projectId;
  overviewConfiguredRef.current = projectAgentOverviewConfigured(overview);

  const stillCurrent = (projectId: ProjectId, generation: number) =>
    projectIdRef.current === projectId && loadGeneration.current === generation;

  const load = useCallback(async () => {
    const api = readNativeApi();
    const projectId = projectIdRef.current;
    const generation = ++loadGeneration.current;
    if (!api?.projectAgent || !projectId) {
      setOverview(null);
      setTasks([]);
      setActivity([]);
      setDocuments([]);
      setThreads([]);
      return;
    }
    try {
      const next = await api.projectAgent.getOverview({ projectId });
      if (!stillCurrent(projectId, generation)) return;
      setOverview(next);
      if (next.configured) {
        const [listed, activityPage, docs, index] = await Promise.all([
          api.projectAgent.listTasks({ projectId, includeArchived: true }),
          api.projectAgent.listActivity({ projectId }),
          api.projectAgent.listDocuments({ projectId }),
          api.projectAgent.listThreadIndex({ projectId }),
        ]);
        if (!stillCurrent(projectId, generation)) return;
        setTasks(listed.tasks);
        setActivity(activityPage.activity);
        setActivityCursor(activityPage.nextCursor);
        setDocuments(docs.documents);
        setThreads(index.threads);
      } else {
        setTasks([]);
        setActivity([]);
        setDocuments([]);
        setThreads([]);
      }
      reportError(null);
    } catch (cause) {
      if (!stillCurrent(projectId, generation)) return;
      reportError(cause instanceof Error ? cause.message : "Failed to load project coordinator.");
    }
  }, [reportError]);

  // `thread-index-upserted` events patch membership directly; a full re-list
  // still runs when config links/unlinks or task upserts could change it.
  // One refresh in flight at a time; a burst coalesces into a single
  // follow-up listing.
  const threadIndexRefreshRef = useRef({ inFlight: false, queued: false });
  const refreshThreadIndex = useCallback(() => {
    const api = readNativeApi();
    const projectId = projectIdRef.current;
    if (!api?.projectAgent || !projectId) return;
    const pending = threadIndexRefreshRef.current;
    if (pending.inFlight) {
      pending.queued = true;
      return;
    }
    pending.inFlight = true;
    const generation = loadGeneration.current;
    void (async () => {
      try {
        const index = await api.projectAgent.listThreadIndex({ projectId });
        if (projectIdRef.current === projectId && loadGeneration.current === generation) {
          setThreads(index.threads);
        }
      } catch {
        // A dropped refresh keeps the last index — the next event retries it.
      }
      pending.inFlight = false;
      if (pending.queued) {
        pending.queued = false;
        refreshThreadIndex();
      }
    })();
  }, []);

  useEffect(() => {
    if (!input.enabled || !input.projectId) {
      setOverview(null);
      setTasks([]);
      setActivity([]);
      return;
    }
    void load();
    const api = readNativeApi();
    const subscribedProjectId = input.projectId;
    if (!api?.projectAgent || !subscribedProjectId) return;
    void api.projectAgent.subscribe({ projectId: subscribedProjectId }).catch(() => undefined);
    const unsubscribeEvents = api.projectAgent.onEvent((event: ProjectAgentStreamEvent) => {
      const current = projectIdRef.current;
      if (!current) return;
      // Events stream for every subscribed project on the client — apply only this
      // project's events and only the slice each event actually changed.
      if (event.type === "snapshot") {
        if (event.overview.projectId === current) setOverview(event.overview);
        return;
      }
      if (event.type === "config-upserted") {
        if (event.config.projectId === current) {
          const wasConfigured = overviewConfiguredRef.current;
          setOverview((overview) =>
            overview && overview.projectId === current
              ? projectAgentOverviewWithConfig(overview, event.config)
              : overview,
          );
          if (wasConfigured) {
            refreshThreadIndex();
          } else {
            // First configure while the panel is open: the task/activity/document/
            // thread lists behind the overview only exist once loaded.
            void load();
          }
        }
        return;
      }
      if (event.type === "goal-upserted") {
        if (event.goal.projectId === current) {
          setOverview((overview) =>
            overview && overview.projectId === current
              ? { ...overview, goal: event.goal }
              : overview,
          );
        }
        return;
      }
      if (event.type === "digest-upserted") {
        if (event.digest.projectId === current) {
          setOverview((overview) =>
            overview && overview.projectId === current
              ? { ...overview, digest: event.digest }
              : overview,
          );
        }
        return;
      }
      if (event.type === "task-upserted") {
        if (event.task.projectId === current) {
          setTasks((tasks) => {
            const index = tasks.findIndex((task) => task.id === event.task.id);
            if (index === -1) return [...tasks, event.task];
            const next = [...tasks];
            next[index] = event.task;
            return next;
          });
          refreshThreadIndex();
        }
        return;
      }
      if (event.type === "thread-index-upserted") {
        if (event.projectId === current) {
          // The coordinator's own thread creations (e.g. a worker in a linked
          // repo) land here — merge rows so the Threads tab shows them without
          // waiting for the next full index listing.
          setThreads((threads) => {
            const next = [...threads];
            for (const entry of event.threads) {
              const index = next.findIndex((row) => row.threadId === entry.threadId);
              if (index === -1) {
                next.push(entry);
              } else {
                next[index] = entry;
              }
            }
            return next;
          });
        }
        return;
      }
      if (event.type === "activity-appended") {
        if (event.activity.projectId === current) {
          setActivity((activity) =>
            activity.some((entry) => entry.id === event.activity.id)
              ? activity
              : [event.activity, ...activity],
          );
        }
        return;
      }
      if (event.type === "document-head-updated") {
        if (event.head.projectId === current) {
          setDocuments((documents) => {
            const index = documents.findIndex(
              (document) => document.logicalPath === event.head.logicalPath,
            );
            if (index === -1) return [...documents, event.head];
            const next = [...documents];
            next[index] = event.head;
            return next;
          });
        }
        return;
      }
    });
    return () => {
      unsubscribeEvents();
      void api.projectAgent.unsubscribe({ projectId: subscribedProjectId }).catch(() => undefined);
    };
  }, [input.enabled, input.projectId, load, refreshThreadIndex]);

  const runMutation = useCallback(
    async (
      work: (
        api: NonNullable<ReturnType<typeof readNativeApi>>["projectAgent"],
        projectId: ProjectId,
      ) => Promise<void>,
    ) => {
      const api = readNativeApi();
      const projectId = projectIdRef.current;
      if (!api?.projectAgent || !projectId) return false;
      setBusy(true);
      try {
        await work(api.projectAgent, projectId);
        if (projectIdRef.current === projectId) await load();
        return true;
      } catch (cause) {
        if (projectIdRef.current === projectId) {
          reportError(cause instanceof Error ? cause.message : "Project action failed.");
        }
        return false;
      } finally {
        if (projectIdRef.current === projectId) setBusy(false);
      }
    },
    [load, reportError],
  );

  const configure = useCallback(
    async (input: {
      modelSelection: ModelSelection;
      coordinatorName?: string | undefined;
      workerRouting?: ProjectAgentWorkerRouting | undefined;
      limits?:
        | (ProjectAgentOverview["config"] extends infer C
            ? C extends { limits: infer L }
              ? L
              : never
            : never)
        | undefined;
      importedInstructions?: string | undefined;
      expectedRevision?: number | undefined;
      goal?: string | undefined;
      icon?: string | undefined;
      autoMemoryEnabled?: boolean | undefined;
      userDisplayName?: string | undefined;
      requestId?: string | undefined;
      libraryPath?: string | undefined;
      libraryRemoteUrl?: string | undefined;
      libraryPushOnChange?: boolean | undefined;
    }) =>
      runMutation(async (projectAgent, projectId) => {
        const overview = await projectAgent.configure({
          requestId: input.requestId ?? crypto.randomUUID(),
          projectId,
          coordinatorModelSelection: input.modelSelection,
          ...(input.coordinatorName ? { coordinatorName: input.coordinatorName } : {}),
          ...(input.workerRouting ? { workerRouting: input.workerRouting } : {}),
          ...(input.limits ? { limits: input.limits } : {}),
          ...(input.importedInstructions?.trim()
            ? { importedInstructions: input.importedInstructions }
            : {}),
          ...(input.expectedRevision !== undefined
            ? { expectedRevision: input.expectedRevision }
            : {}),
          ...(input.goal !== undefined ? { goal: input.goal } : {}),
          ...(input.icon !== undefined ? { icon: input.icon } : {}),
          ...(input.autoMemoryEnabled !== undefined
            ? { autoMemoryEnabled: input.autoMemoryEnabled }
            : {}),
          ...(input.userDisplayName?.trim()
            ? { userDisplayName: input.userDisplayName.trim() }
            : {}),
          ...(input.libraryPath !== undefined ? { libraryPath: input.libraryPath } : {}),
          ...(input.libraryRemoteUrl !== undefined
            ? { libraryRemoteUrl: input.libraryRemoteUrl }
            : {}),
          ...(input.libraryPushOnChange !== undefined
            ? { libraryPushOnChange: input.libraryPushOnChange }
            : {}),
        });
        useProjectAgentSummariesStore.getState().applyOverview(overview);
      }),
    [runMutation],
  );

  const linkProject = useCallback(
    async (linkedProjectId: ProjectId) =>
      runMutation(async (projectAgent, projectId) => {
        const overview = await projectAgent.linkProject({
          requestId: crypto.randomUUID(),
          projectId,
          linkedProjectId,
        });
        useProjectAgentSummariesStore.getState().applyOverview(overview);
      }),
    [runMutation],
  );

  const unlinkProject = useCallback(
    async (linkedProjectId: ProjectId) =>
      runMutation(async (projectAgent, projectId) => {
        const overview = await projectAgent.unlinkProject({
          requestId: crypto.randomUUID(),
          projectId,
          linkedProjectId,
        });
        useProjectAgentSummariesStore.getState().applyOverview(overview);
      }),
    [runMutation],
  );

  // Lifecycle ops share the same runMutation wrapper but take the input's
  // projectId so a settings dialog can act on any group, not just the one
  // currently bound to this hook.
  const groupControl = useCallback(
    async (
      projectId: ProjectId,
      call: (
        projectAgent: NonNullable<ReturnType<typeof readNativeApi>>["projectAgent"],
      ) => Promise<ProjectAgentOverview>,
    ) => {
      const api = readNativeApi();
      if (!api?.projectAgent) return null;
      setBusy(true);
      try {
        const overview = await call(api.projectAgent);
        useProjectAgentSummariesStore.getState().applyOverview(overview);
        if (projectIdRef.current === projectId) await load();
        return overview;
      } catch (cause) {
        if (projectIdRef.current === projectId) {
          setError(cause instanceof Error ? cause.message : "Group action failed.");
        }
        return null;
      } finally {
        if (projectIdRef.current === projectId) setBusy(false);
      }
    },
    [load],
  );

  const pauseGroup = useCallback(
    async (projectId: ProjectId) =>
      groupControl(projectId, (projectAgent) =>
        projectAgent.pauseGroup({ requestId: crypto.randomUUID(), projectId }),
      ),
    [groupControl],
  );

  const resumeGroup = useCallback(
    async (projectId: ProjectId) =>
      groupControl(projectId, (projectAgent) =>
        projectAgent.resumeGroup({ requestId: crypto.randomUUID(), projectId }),
      ),
    [groupControl],
  );

  const archiveGroup = useCallback(
    async (projectId: ProjectId) =>
      groupControl(projectId, (projectAgent) =>
        projectAgent.archiveGroup({ requestId: crypto.randomUUID(), projectId }),
      ),
    [groupControl],
  );

  const unarchiveGroup = useCallback(
    async (projectId: ProjectId) =>
      groupControl(projectId, (projectAgent) =>
        projectAgent.unarchiveGroup({ requestId: crypto.randomUUID(), projectId }),
      ),
    [groupControl],
  );

  const restartCoordinator = useCallback(
    async (projectId: ProjectId) =>
      groupControl(projectId, (projectAgent) =>
        projectAgent.restartCoordinator({ requestId: crypto.randomUUID(), projectId }),
      ),
    [groupControl],
  );

  const deleteGroup = useCallback(
    async (projectId: ProjectId, confirmName: string, options?: { requireEmpty?: boolean }) => {
      const api = readNativeApi();
      if (!api?.projectAgent) return null;
      setBusy(true);
      try {
        const result: ProjectAgentDeleteGroupResult = await api.projectAgent.deleteGroup({
          requestId: crypto.randomUUID(),
          projectId,
          confirmName,
          ...(options?.requireEmpty === true ? { requireEmpty: true } : {}),
        });
        return result;
      } catch (cause) {
        if (projectIdRef.current === projectId) {
          setError(cause instanceof Error ? cause.message : "Group action failed.");
        }
        return null;
      } finally {
        if (projectIdRef.current === projectId) setBusy(false);
      }
    },
    [],
  );

  const startGoal = useCallback(
    async (objective: string) =>
      runMutation(async (projectAgent, projectId) => {
        await projectAgent.startGoal({
          requestId: crypto.randomUUID(),
          projectId,
          objective,
        });
      }),
    [runMutation],
  );

  const pauseGoal = useCallback(async () => {
    const goal = overview?.goal;
    if (!goal) return;
    await runMutation(async (projectAgent, projectId) => {
      await projectAgent.pauseGoal({
        requestId: crypto.randomUUID(),
        projectId,
        goalId: goal.id,
        expectedRevision: goal.revision,
      });
    });
  }, [overview?.goal, runMutation]);

  const resumeGoal = useCallback(async () => {
    const goal = overview?.goal;
    if (!goal) return;
    await runMutation(async (projectAgent, projectId) => {
      await projectAgent.resumeGoal({
        requestId: crypto.randomUUID(),
        projectId,
        goalId: goal.id,
        expectedRevision: goal.revision,
      });
    });
  }, [overview?.goal, runMutation]);

  const stopGoal = useCallback(async () => {
    const goal = overview?.goal;
    if (!goal) return;
    await runMutation(async (projectAgent, projectId) => {
      await projectAgent.stopGoal({
        requestId: crypto.randomUUID(),
        projectId,
        goalId: goal.id,
        expectedRevision: goal.revision,
      });
    });
  }, [overview?.goal, runMutation]);

  const createTask = useCallback(
    async (title: string) => {
      const goal = overview?.goal;
      if (!goal) return;
      await runMutation(async (projectAgent, projectId) => {
        await projectAgent.createTask({
          requestId: crypto.randomUUID(),
          projectId,
          goalId: goal.id,
          title,
        });
      });
    },
    [overview?.goal, runMutation],
  );

  const acceptTask = useCallback(
    async (task: ProjectTask) =>
      runMutation(async (projectAgent, projectId) => {
        await projectAgent.updateTask({
          requestId: crypto.randomUUID(),
          projectId,
          taskId: task.id,
          expectedRevision: task.revision,
          accept: true,
        });
      }),
    [runMutation],
  );

  const archiveTask = useCallback(
    async (task: ProjectTask) =>
      runMutation(async (projectAgent, projectId) => {
        await projectAgent.updateTask({
          requestId: crypto.randomUUID(),
          projectId,
          taskId: task.id,
          expectedRevision: task.revision,
          archived: true,
        });
      }),
    [runMutation],
  );

  const updateTaskStatus = useCallback(
    async (task: ProjectTask, input: { status?: ProjectTask["status"]; archived?: boolean }) =>
      runMutation(async (projectAgent, projectId) => {
        await projectAgent.updateTask({
          requestId: crypto.randomUUID(),
          projectId,
          taskId: task.id,
          expectedRevision: task.revision,
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.archived !== undefined ? { archived: input.archived } : {}),
        });
      }),
    [runMutation],
  );

  const loadEvidence = useCallback(async (taskId: ProjectTask["id"]) => {
    const api = readNativeApi();
    const projectId = projectIdRef.current;
    if (!api?.projectAgent || !projectId) return [] as ReadonlyArray<ProjectEvidence>;
    const listed = await api.projectAgent.listEvidence({ projectId, taskId });
    return listed.evidence;
  }, []);

  const loadMoreActivity = useCallback(async () => {
    const api = readNativeApi();
    const projectId = projectIdRef.current;
    if (!api?.projectAgent || !projectId || !activityCursor) return;
    const page = await api.projectAgent.listActivity({ projectId, cursor: activityCursor });
    if (projectIdRef.current !== projectId) return;
    setActivity((current) => [...current, ...page.activity]);
    setActivityCursor(page.nextCursor);
  }, [activityCursor]);

  const excludeThread = useCallback(
    async (threadId: ThreadId, excluded: boolean) =>
      runMutation(async (projectAgent, projectId) => {
        await projectAgent.excludeThread({
          requestId: crypto.randomUUID(),
          projectId,
          threadId,
          excluded,
        });
      }),
    [runMutation],
  );

  const backfillSummaries = useCallback(
    async () =>
      runMutation(async (projectAgent, projectId) => {
        await projectAgent.backfillSummaries({
          requestId: crypto.randomUUID(),
          projectId,
        });
      }),
    [runMutation],
  );

  const refreshDigest = useCallback(
    async () =>
      runMutation(async (projectAgent, projectId) => {
        await projectAgent.refreshDigest({
          requestId: crypto.randomUUID(),
          projectId,
        });
      }),
    [runMutation],
  );

  const readDocument = useCallback(async (logicalPath: string, revision?: number) => {
    const api = readNativeApi();
    const projectId = projectIdRef.current;
    if (!api?.projectAgent || !projectId) return null;
    return api.projectAgent.readDocument({
      projectId,
      logicalPath,
      ...(revision ? { revision } : {}),
    });
  }, []);

  const writeDocument = useCallback(
    async (input: {
      logicalPath: string;
      content: string;
      expectedRevision?: number;
      importExternal?: boolean;
    }) => {
      const api = readNativeApi();
      const projectId = projectIdRef.current;
      if (!api?.projectAgent || !projectId) {
        throw new Error("Project coordinator is unavailable.");
      }
      return api.projectAgent.writeDocument({
        requestId: crypto.randomUUID(),
        projectId,
        logicalPath: input.logicalPath,
        content: input.content,
        ...(input.expectedRevision !== undefined
          ? { expectedRevision: input.expectedRevision }
          : {}),
        ...(input.importExternal ? { importExternal: true } : {}),
      });
    },
    [],
  );

  const exportDocuments = useCallback(
    async (logicalPaths: ReadonlyArray<string>, destinationDirectory: string) => {
      const api = readNativeApi();
      const projectId = projectIdRef.current;
      if (!api?.projectAgent || !projectId) return;
      await api.projectAgent.exportDocuments({
        requestId: crypto.randomUUID(),
        projectId,
        logicalPaths: [...logicalPaths],
        destinationDirectory,
      });
    },
    [],
  );

  return {
    overview,
    tasks,
    activity,
    activityCursor,
    documents,
    threads,
    error,
    busy,
    load,
    readError,
    configure,
    linkProject,
    unlinkProject,
    pauseGroup,
    resumeGroup,
    archiveGroup,
    unarchiveGroup,
    restartCoordinator,
    deleteGroup,
    startGoal,
    pauseGoal,
    resumeGoal,
    stopGoal,
    createTask,
    acceptTask,
    archiveTask,
    updateTaskStatus,
    loadEvidence,
    loadMoreActivity,
    excludeThread,
    backfillSummaries,
    refreshDigest,
    readDocument,
    writeDocument,
    exportDocuments,
    setError,
  };
}

export type LoadedDocument = Awaited<
  ReturnType<ReturnType<typeof useProjectAgent>["readDocument"]>
>;
export type SavedDocument = ProjectDocumentRevision;

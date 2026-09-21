import {
  type ModelSelection,
  type ProjectActivity,
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
  const [busy, setBusy] = useState(false);
  const projectIdRef = useRef(input.projectId);
  const loadGeneration = useRef(0);
  projectIdRef.current = input.projectId;

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
      setError(null);
    } catch (cause) {
      if (!stillCurrent(projectId, generation)) return;
      setError(cause instanceof Error ? cause.message : "Failed to load project coordinator.");
    }
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
    if (!api?.projectAgent) return;
    void api.projectAgent.subscribe({ projectId: input.projectId }).catch(() => undefined);
    const unsubscribe = api.projectAgent.onEvent((event: ProjectAgentStreamEvent) => {
      const current = projectIdRef.current;
      if (!current) return;
      if (event.type === "snapshot" && event.overview.projectId === current) {
        setOverview(event.overview);
        return;
      }
      void load();
    });
    return () => {
      unsubscribe();
    };
  }, [input.enabled, input.projectId, load]);

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
          setError(cause instanceof Error ? cause.message : "Project action failed.");
        }
        return false;
      } finally {
        if (projectIdRef.current === projectId) setBusy(false);
      }
    },
    [load],
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
        });
        useProjectAgentSummariesStore.getState().applyOverview(overview);
      }),
    [runMutation],
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
    configure,
    startGoal,
    pauseGoal,
    resumeGoal,
    stopGoal,
    createTask,
    acceptTask,
    archiveTask,
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

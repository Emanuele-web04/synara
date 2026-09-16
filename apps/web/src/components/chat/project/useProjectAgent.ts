import {
  type ModelSelection,
  type ProjectAgentOverview,
  type ProjectAgentStreamEvent,
  type ProjectId,
  type ProjectTask,
} from "@synara/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { readNativeApi } from "~/nativeApi";

export function useProjectAgent(input: {
  readonly projectId: ProjectId | null;
  readonly enabled: boolean;
}) {
  const [overview, setOverview] = useState<ProjectAgentOverview | null>(null);
  const [tasks, setTasks] = useState<ReadonlyArray<ProjectTask>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const projectIdRef = useRef(input.projectId);
  projectIdRef.current = input.projectId;

  const load = useCallback(async () => {
    const api = readNativeApi();
    const projectId = projectIdRef.current;
    if (!api?.projectAgent || !projectId) {
      setOverview(null);
      setTasks([]);
      return;
    }
    try {
      const next = await api.projectAgent.getOverview({ projectId });
      if (projectIdRef.current !== projectId) return;
      setOverview(next);
      if (next.configured) {
        const listed = await api.projectAgent.listTasks({ projectId, includeArchived: false });
        if (projectIdRef.current !== projectId) return;
        setTasks(listed.tasks);
      } else {
        setTasks([]);
      }
      setError(null);
    } catch (cause) {
      if (projectIdRef.current !== projectId) return;
      setError(cause instanceof Error ? cause.message : "Failed to load project coordinator.");
    }
  }, []);

  useEffect(() => {
    if (!input.enabled || !input.projectId) {
      setOverview(null);
      setTasks([]);
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

  const configure = useCallback(
    async (modelSelection: ModelSelection, coordinatorName?: string, importedInstructions?: string) => {
      const api = readNativeApi();
      const projectId = projectIdRef.current;
      if (!api?.projectAgent || !projectId) return;
      setBusy(true);
      try {
        const next = await api.projectAgent.configure({
          requestId: crypto.randomUUID(),
          projectId,
          coordinatorModelSelection: modelSelection,
          ...(coordinatorName ? { coordinatorName } : {}),
          ...(importedInstructions?.trim() ? { importedInstructions } : {}),
        });
        setOverview(next);
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Failed to configure coordinator.");
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const startGoal = useCallback(async (objective: string) => {
    const api = readNativeApi();
    const projectId = projectIdRef.current;
    if (!api?.projectAgent || !projectId) return;
    setBusy(true);
    try {
      await api.projectAgent.startGoal({
        requestId: crypto.randomUUID(),
        projectId,
        objective,
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to start goal.");
    } finally {
      setBusy(false);
    }
  }, [load]);

  const pauseGoal = useCallback(async () => {
    const api = readNativeApi();
    const projectId = projectIdRef.current;
    const goal = overview?.goal;
    if (!api?.projectAgent || !projectId || !goal) return;
    setBusy(true);
    try {
      await api.projectAgent.pauseGoal({
        requestId: crypto.randomUUID(),
        projectId,
        goalId: goal.id,
        expectedRevision: goal.revision,
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to pause goal.");
    } finally {
      setBusy(false);
    }
  }, [load, overview?.goal]);

  const acceptTask = useCallback(
    async (task: ProjectTask) => {
      const api = readNativeApi();
      const projectId = projectIdRef.current;
      if (!api?.projectAgent || !projectId) return;
      setBusy(true);
      try {
        await api.projectAgent.updateTask({
          requestId: crypto.randomUUID(),
          projectId,
          taskId: task.id,
          expectedRevision: task.revision,
          accept: true,
        });
        await load();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Failed to accept task.");
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  return { overview, tasks, error, busy, load, configure, startGoal, pauseGoal, acceptTask };
}

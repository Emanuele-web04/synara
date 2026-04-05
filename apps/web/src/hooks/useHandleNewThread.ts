import { type ProjectId, ThreadId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback } from "react";
import { type DraftThreadState, useComposerDraftStore } from "../composerDraftStore";
import {
  buildDraftThreadContextPatch,
  createActiveDraftThreadSnapshot,
  createActiveThreadSnapshot,
  createFreshDraftThreadSeed,
  resolveTerminalThreadCreationState,
  resolveThreadBootstrapPlan,
  type NewThreadOptions,
} from "../lib/threadBootstrap";
import { newCommandId, newThreadId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";

export function useHandleNewThread() {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const navigate = useNavigate();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const activeDraftThread = useComposerDraftStore((store) =>
    routeThreadId ? (store.draftThreadsByThreadId[routeThreadId] ?? null) : null,
  );

  const activeThread = routeThreadId
    ? threads.find((thread) => thread.id === routeThreadId)
    : undefined;
  const openChatThreadPage = useTerminalStateStore((store) => store.openChatThreadPage);
  const openTerminalThreadPage = useTerminalStateStore((store) => store.openTerminalThreadPage);

  const handleNewThread = useCallback(
    (projectId: ProjectId, options?: NewThreadOptions): Promise<void> => {
      const entryPoint = options?.entryPoint ?? "chat";
      const activateThreadEntryPoint = (threadId: ThreadId) => {
        if (entryPoint === "terminal") {
          openTerminalThreadPage(threadId, { terminalOnly: true });
          return;
        }
        openChatThreadPage(threadId);
      };
      const {
        clearProjectDraftThreadId,
        getDraftThread,
        getDraftThreadByProjectId,
        applyStickyState,
        setDraftThreadContext,
        setProjectDraftThreadId,
      } = useComposerDraftStore.getState();
      const storedDraftThread = getDraftThreadByProjectId(projectId, entryPoint);
      const latestActiveDraftThread: DraftThreadState | null = routeThreadId
        ? getDraftThread(routeThreadId)
        : null;
      const bootstrapPlan = resolveThreadBootstrapPlan({
        storedDraftThread,
        latestActiveDraftThread,
        entryPoint,
        projectId,
        routeThreadId,
      });
      const projectDefaultModelSelection =
        projects.find((project) => project.id === projectId)?.defaultModelSelection ?? null;
      const activeThreadSnapshot = createActiveThreadSnapshot(activeThread, projectId);
      const activeDraftThreadSnapshot = createActiveDraftThreadSnapshot(
        activeDraftThread,
        projectId,
      );
      const resolveCreationState = (
        targetThreadId: ThreadId,
        draftThread: DraftThreadState | null,
      ) =>
        resolveTerminalThreadCreationState({
          activeDraftThread: activeDraftThreadSnapshot,
          activeThread: activeThreadSnapshot,
          draftComposerState:
            useComposerDraftStore.getState().draftsByThreadId[targetThreadId] ?? null,
          draftThread,
          options,
          projectDefaultModelSelection,
          projectId,
        });
      // Terminal-first threads need a real orchestration thread immediately so
      // the sidebar can render them as durable rows instead of draft-only routes.
      const createTerminalThread = async (
        threadId: ThreadId,
        creationState: ReturnType<typeof resolveCreationState>,
      ): Promise<void> => {
        if (threads.some((thread) => thread.id === threadId)) {
          return;
        }
        const api = readNativeApi();
        if (!api) {
          return;
        }
        await api.orchestration.dispatchCommand({
          type: "thread.create",
          commandId: newCommandId(),
          threadId,
          projectId,
          title: "New terminal",
          modelSelection: creationState.modelSelection,
          runtimeMode: creationState.runtimeMode,
          interactionMode: creationState.interactionMode,
          branch: creationState.branch,
          worktreePath: creationState.worktreePath,
          createdAt: new Date().toISOString(),
        });
      };
      if (bootstrapPlan.kind === "stored") {
        return (async () => {
          let resolvedStoredDraftThread: DraftThreadState | null = bootstrapPlan.draftThread;
          const draftContextPatch = buildDraftThreadContextPatch(entryPoint, options);
          if (draftContextPatch) {
            setDraftThreadContext(bootstrapPlan.threadId, draftContextPatch);
            resolvedStoredDraftThread = getDraftThread(bootstrapPlan.threadId);
          }
          setProjectDraftThreadId(projectId, bootstrapPlan.threadId, { entryPoint });
          activateThreadEntryPoint(bootstrapPlan.threadId);
          if (routeThreadId === bootstrapPlan.threadId) {
            if (entryPoint === "terminal") {
              await createTerminalThread(
                bootstrapPlan.threadId,
                resolveCreationState(bootstrapPlan.threadId, resolvedStoredDraftThread),
              );
            }
            return;
          }
          await navigate({
            to: "/$threadId",
            params: { threadId: bootstrapPlan.threadId },
          });
          if (entryPoint === "terminal") {
            await createTerminalThread(
              bootstrapPlan.threadId,
              resolveCreationState(bootstrapPlan.threadId, resolvedStoredDraftThread),
            );
          }
        })();
      }

      clearProjectDraftThreadId(projectId, entryPoint);

      if (bootstrapPlan.kind === "route") {
        let resolvedActiveDraftThread: DraftThreadState | null = bootstrapPlan.draftThread;
        const draftContextPatch = buildDraftThreadContextPatch(entryPoint, options);
        if (draftContextPatch) {
          setDraftThreadContext(bootstrapPlan.threadId, draftContextPatch);
          resolvedActiveDraftThread = getDraftThread(bootstrapPlan.threadId);
        }
        setProjectDraftThreadId(projectId, bootstrapPlan.threadId, { entryPoint });
        activateThreadEntryPoint(bootstrapPlan.threadId);
        if (entryPoint === "terminal") {
          return createTerminalThread(
            bootstrapPlan.threadId,
            resolveCreationState(bootstrapPlan.threadId, resolvedActiveDraftThread),
          );
        }
        return Promise.resolve();
      }

      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      return (async () => {
        setProjectDraftThreadId(projectId, threadId, {
          ...createFreshDraftThreadSeed({
            createdAt,
            entryPoint,
            options,
          }),
        });
        activateThreadEntryPoint(threadId);
        applyStickyState(threadId);

        await navigate({
          to: "/$threadId",
          params: { threadId },
        });
        if (entryPoint === "terminal") {
          await createTerminalThread(
            threadId,
            resolveCreationState(threadId, getDraftThread(threadId)),
          );
        }
      })();
    },
    [
      activeDraftThread,
      activeThread,
      navigate,
      openChatThreadPage,
      openTerminalThreadPage,
      projects,
      routeThreadId,
      threads,
    ],
  );

  return {
    activeDraftThread,
    activeThread,
    handleNewThread,
    projects,
    routeThreadId,
  };
}

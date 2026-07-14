// FILE: useHandleNewCanvasDrawing.ts
// Purpose: Creates a durable Canvas thread and its project-local Excalidraw scene as one UI action.
// Layer: Web orchestration hook

import type { ProjectId, ThreadId } from "@synara/contracts";
import { getDefaultModel } from "@synara/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { toastManager } from "../components/ui/toast";
import { newCommandId, newThreadId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { getThreadsFromState } from "../threadDerivation";

const DRAWING_PROJECTION_CATCH_UP_ATTEMPTS = 8;
const DRAWING_PROJECTION_CATCH_UP_DELAY_MS = 50;

function waitForProjectionCatchUp(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, DRAWING_PROJECTION_CATCH_UP_DELAY_MS));
}

export function useHandleNewCanvasDrawing() {
  const navigate = useNavigate();

  const handleNewCanvasDrawing = useCallback(
    async (projectId: ProjectId): Promise<ThreadId | null> => {
      const api = readNativeApi();
      const state = useStore.getState();
      const project = state.projects.find((candidate) => candidate.id === projectId);
      if (!api || !project) {
        toastManager.add({
          type: "error",
          title: "Unable to create drawing",
          description: "The project is not available yet.",
        });
        return null;
      }

      const siblingCount = getThreadsFromState(state).filter(
        (thread) => thread.projectId === projectId && thread.surface === "canvas",
      ).length;
      const threadId = newThreadId();
      const title = siblingCount === 0 ? "Untitled drawing" : `Untitled drawing ${siblingCount + 1}`;
      let threadCreated = false;
      let drawingCreated = false;

      try {
        await api.orchestration.dispatchCommand({
          type: "thread.create",
          commandId: newCommandId(),
          threadId,
          projectId,
          surface: "canvas",
          title,
          modelSelection: { provider: "grok", model: getDefaultModel("grok") },
          runtimeMode: "full-access",
          interactionMode: "default",
          envMode: "local",
          branch: null,
          worktreePath: null,
          createdAt: new Date().toISOString(),
        });
        threadCreated = true;
        for (let attempt = 0; attempt < DRAWING_PROJECTION_CATCH_UP_ATTEMPTS; attempt += 1) {
          try {
            await api.canvas.createDrawing({ threadId });
            drawingCreated = true;
            break;
          } catch (error) {
            if (attempt === DRAWING_PROJECTION_CATCH_UP_ATTEMPTS - 1) throw error;
            await waitForProjectionCatchUp();
          }
        }
        await navigate({
          to: "/$threadId",
          params: { threadId },
          search: (previous) => ({ ...previous, view: "canvas" }),
        });
        return threadId;
      } catch (error) {
        if (drawingCreated) {
          await api.canvas
            .deleteDrawing({ threadId })
            .catch(() => undefined);
        } else if (threadCreated) {
          await api.orchestration
            .dispatchCommand({
              type: "thread.delete",
              commandId: newCommandId(),
              threadId,
            })
            .catch(() => undefined);
        }
        toastManager.add({
          type: "error",
          title: "Unable to create drawing",
          description: error instanceof Error ? error.message : "The drawing could not be created.",
        });
        return null;
      }
    },
    [navigate],
  );

  return { handleNewCanvasDrawing };
}

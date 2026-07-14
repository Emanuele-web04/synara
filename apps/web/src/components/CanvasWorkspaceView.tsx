// FILE: CanvasWorkspaceView.tsx
// Purpose: Editor-style Excalidraw workspace with project drawings and a persistent AI chat.
// Layer: Chat route presentation

import type {
  CanvasDrawingSnapshot,
  CanvasScene,
  ProjectId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import {
  convertToExcalidrawElements,
  Excalidraw,
  FONT_FAMILY,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import { useNavigate } from "@tanstack/react-router";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FiMessageSquare, FiPlus, FiTrash2 } from "react-icons/fi";

import { useHandleNewCanvasDrawing } from "~/hooks/useHandleNewCanvasDrawing";
import { useTheme } from "~/hooks/useTheme";
import { canvasAgentMutationTurnId, isCanvasAgentEditing } from "~/lib/canvasAgentState";
import { cn } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { createThreadSelector, createThreadShellsSelector } from "~/storeSelectors";
import { useStore } from "~/store";
import { ResizableChatPane, useResizableChatPane } from "./ResizableChatPane";
import { toastManager } from "./ui/toast";

type SaveState = "loading" | "saved" | "saving" | "conflict" | "error";
type PendingSceneChange =
  | { readonly kind: "serialized"; readonly scene: CanvasScene }
  | {
      readonly kind: "excalidraw";
      readonly elements: readonly unknown[];
      readonly appState: unknown;
      readonly files: unknown;
    };

const AUTOSAVE_DELAY_MS = 500;

function toCanvasScene(elements: readonly unknown[], appState: unknown, files: unknown): CanvasScene {
  return JSON.parse(
    serializeAsJSON(elements as never, appState as never, files as never, "database"),
  ) as CanvasScene;
}

function canonicalizeAgentElements(scene: CanvasScene): { scene: CanvasScene; changed: boolean } {
  const canonical: Array<Record<string, unknown>> = [];
  const shorthand: Array<Record<string, unknown>> = [];
  for (const element of scene.elements) {
    if (element.label !== undefined || element.version === undefined) {
      shorthand.push(element);
    } else {
      canonical.push(element);
    }
  }
  if (shorthand.length === 0) return { scene, changed: false };

  const converted = convertToExcalidrawElements(
    shorthand.map((element) =>
      element.label
        ? {
            ...element,
            label: { textAlign: "center", verticalAlign: "middle", ...element.label },
          }
        : element,
    ) as never,
    { regenerateIds: false },
  ).map((element) =>
    element.type === "text" ? { ...element, fontFamily: FONT_FAMILY.Excalifont } : element,
  );

  return {
    scene: { ...scene, elements: [...canonical, ...(converted as never)] },
    changed: true,
  };
}

function saveStateLabel(state: SaveState): string {
  switch (state) {
    case "loading":
      return "Loading";
    case "saving":
      return "Saving…";
    case "conflict":
      return "Reload required";
    case "error":
      return "Save failed";
    case "saved":
      return "Saved locally";
  }
}

export function CanvasWorkspaceView(props: {
  threadId: ThreadId;
  projectId: ProjectId;
  projectName: string;
  chatPanel: ReactNode;
}) {
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const { handleNewCanvasDrawing } = useHandleNewCanvasDrawing();
  const chatPane = useResizableChatPane({ storageKey: "synara.canvas.chatPane" });
  const thread = useStore(
    useMemo(() => createThreadSelector(props.threadId), [props.threadId]),
  );
  const threadShells = useStore(useMemo(() => createThreadShellsSelector(), []));
  const drawings = useMemo(
    () =>
      threadShells
        .filter(
          (candidate) =>
            candidate.projectId === props.projectId &&
            candidate.surface === "canvas" &&
            !candidate.archivedAt,
        )
        .toSorted((left, right) =>
          (right.updatedAt ?? right.createdAt).localeCompare(left.updatedAt ?? left.createdAt),
        ),
    [props.projectId, threadShells],
  );
  const agentEditing = isCanvasAgentEditing({
    latestTurn: thread?.latestTurn ?? null,
    activities: thread?.activities ?? [],
  });
  const mutationTurnId = canvasAgentMutationTurnId({
    latestTurn: thread?.latestTurn ?? null,
    activities: thread?.activities ?? [],
  });

  const excalidrawApiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const revisionRef = useRef<string | null>(null);
  const pendingSceneRef = useRef<PendingSceneChange | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const applyingRemoteSceneRef = useRef(false);
  const conflictRef = useRef(false);
  const lastReloadedMutationTurnIdRef = useRef<TurnId | null>(
    thread?.latestTurn?.state === "running" ? null : mutationTurnId,
  );
  const [initialScene, setInitialScene] = useState<CanvasScene | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("loading");

  const applySnapshot = useCallback(
    (snapshot: CanvasDrawingSnapshot) => {
      revisionRef.current = snapshot.revision;
      pendingSceneRef.current = null;
      conflictRef.current = false;
      applyingRemoteSceneRef.current = true;
      setInitialScene(snapshot.scene);
      const api = excalidrawApiRef.current;
      if (api) {
        api.updateScene({
          elements: snapshot.scene.elements as never,
          appState: snapshot.scene.appState as never,
        });
        if (snapshot.scene.files) {
          api.addFiles(Object.values(snapshot.scene.files) as never);
        }
      }
      requestAnimationFrame(() => {
        applyingRemoteSceneRef.current = false;
      });
      setSaveState("saved");
    },
    [],
  );

  const reloadDrawing = useCallback(async () => {
    const api = readNativeApi();
    if (!api) return;
    setSaveState("loading");
    try {
      let snapshot = await api.canvas.readDrawing({ threadId: props.threadId });
      const canonicalized = canonicalizeAgentElements(snapshot.scene);
      if (canonicalized.changed) {
        snapshot = await api.canvas.saveDrawing({
          threadId: props.threadId,
          scene: canonicalized.scene,
          expectedRevision: snapshot.revision,
        });
      }
      applySnapshot(snapshot);
    } catch (error) {
      setSaveState("error");
      toastManager.add({
        type: "error",
        title: "Unable to load drawing",
        description: error instanceof Error ? error.message : "The drawing could not be loaded.",
      });
    }
  }, [applySnapshot, props.threadId]);

  useEffect(() => {
    void reloadDrawing();
  }, [reloadDrawing]);

  const flushPendingSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (!pendingSceneRef.current || conflictRef.current) {
      return;
    }

    saveChainRef.current = saveChainRef.current.then(async () => {
      const api = readNativeApi();
      const pendingScene = pendingSceneRef.current;
      const expectedRevision = revisionRef.current;
      if (!api || !pendingScene || !expectedRevision) return;
      pendingSceneRef.current = null;
      setSaveState("saving");
      let scene: CanvasScene | null = null;
      try {
        scene =
          pendingScene.kind === "serialized"
            ? pendingScene.scene
            : toCanvasScene(pendingScene.elements, pendingScene.appState, pendingScene.files);
        const snapshot = await api.canvas.saveDrawing({
          threadId: props.threadId,
          scene,
          expectedRevision,
        });
        revisionRef.current = snapshot.revision;
        setSaveState("saved");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const conflicted = /revision|conflict/i.test(message);
        pendingSceneRef.current ??= scene ? { kind: "serialized", scene } : pendingScene;
        conflictRef.current = conflicted;
        setSaveState(conflicted ? "conflict" : "error");
      }

    });
  }, [props.threadId]);

  const handleSceneChange = useCallback(
    (elements: readonly unknown[], appState: unknown, files: unknown) => {
      if (applyingRemoteSceneRef.current || agentEditing || conflictRef.current) {
        return;
      }
      pendingSceneRef.current = { kind: "excalidraw", elements, appState, files };
      setSaveState("saving");
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(flushPendingSave, AUTOSAVE_DELAY_MS);
    },
    [agentEditing, flushPendingSave],
  );

  useEffect(() => {
    if (agentEditing) {
      flushPendingSave();
    }
  }, [agentEditing, flushPendingSave]);

  useEffect(() => {
    const currentState = thread?.latestTurn?.state ?? null;
    if (
      mutationTurnId &&
      currentState !== "running" &&
      lastReloadedMutationTurnIdRef.current !== mutationTurnId
    ) {
      lastReloadedMutationTurnIdRef.current = mutationTurnId;
      void (async () => {
        flushPendingSave();
        await saveChainRef.current;
        if (!pendingSceneRef.current && !conflictRef.current) {
          await reloadDrawing();
        }
      })();
    }
  }, [flushPendingSave, mutationTurnId, reloadDrawing, thread?.latestTurn?.state]);

  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      flushPendingSave();
    },
    [flushPendingSave],
  );

  const handleDelete = useCallback(async () => {
    if (!window.confirm(`Delete “${thread?.title ?? "this drawing"}”?`)) return;
    const api = readNativeApi();
    if (!api) return;
    const nextDrawing = drawings.find((drawing) => drawing.id !== props.threadId) ?? null;
    try {
      await api.canvas.deleteDrawing({ threadId: props.threadId });
      if (nextDrawing) {
        await navigate({
          to: "/$threadId",
          params: { threadId: nextDrawing.id },
          search: (previous) => ({ ...previous, view: "canvas" }),
        });
      } else {
        await navigate({ to: "/" });
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Unable to delete drawing",
        description: error instanceof Error ? error.message : "The drawing could not be deleted.",
      });
    }
  }, [drawings, navigate, props.threadId, thread?.title]);

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden" data-testid="canvas-workspace">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border/65 bg-[var(--color-background-surface)]">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/65 px-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] text-muted-foreground">Project</div>
            <div className="truncate text-[12px] font-medium">{props.projectName}</div>
          </div>
          <button
            type="button"
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            title="New AI drawing"
            aria-label="New AI drawing"
            onClick={() => void handleNewCanvasDrawing(props.projectId)}
          >
            <FiPlus className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          <div className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/65">
            Drawings
          </div>
          {drawings.map((drawing) => {
            const active = drawing.id === props.threadId;
            return (
              <button
                key={drawing.id}
                type="button"
                className={cn(
                  "flex h-8 w-full items-center rounded-md px-2 text-left text-[12px] transition-colors",
                  active ? "bg-muted font-medium text-foreground" : "text-foreground/75 hover:bg-muted/65",
                )}
                onClick={() =>
                  void navigate({
                    to: "/$threadId",
                    params: { threadId: drawing.id },
                    search: (previous) => ({ ...previous, view: "canvas" }),
                  })
                }
              >
                <span className="truncate">{drawing.title}</span>
              </button>
            );
          })}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col bg-background">
        <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border/65 px-3">
          <div className="min-w-0 flex-1 truncate text-[13px] font-medium">
            {thread?.title ?? "Drawing"}
          </div>
          {agentEditing ? (
            <span className="rounded-full bg-amber-500/12 px-2 py-1 text-[10px] font-medium text-amber-700 dark:text-amber-300">
              AI is editing · pan and zoom only
            </span>
          ) : null}
          {saveState === "conflict" ? (
            <button
              type="button"
              className="rounded-md border border-border px-2 py-1 text-[11px] hover:bg-muted"
              onClick={() => void reloadDrawing()}
            >
              Reload scene
            </button>
          ) : null}
          {saveState === "error" ? (
            <button
              type="button"
              className="rounded-md border border-border px-2 py-1 text-[11px] hover:bg-muted"
              onClick={flushPendingSave}
            >
              Retry save
            </button>
          ) : null}
          <span className="text-[10px] text-muted-foreground">{saveStateLabel(saveState)}</span>
          <button
            type="button"
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-pressed={chatPane.visible}
            title={chatPane.visible ? "Hide chat panel" : "Show chat panel"}
            aria-label={chatPane.visible ? "Hide chat panel" : "Show chat panel"}
            onClick={chatPane.toggleVisible}
          >
            <FiMessageSquare className="size-3.5" />
          </button>
          <button
            type="button"
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title="Delete drawing"
            aria-label="Delete drawing"
            onClick={() => void handleDelete()}
          >
            <FiTrash2 className="size-3.5" />
          </button>
        </header>
        <div className="relative min-h-0 flex-1" data-testid="excalidraw-canvas">
          {initialScene ? (
            <Excalidraw
              initialData={initialScene as never}
              excalidrawAPI={(api) => {
                excalidrawApiRef.current = api;
              }}
              onChange={handleSceneChange as never}
              viewModeEnabled={agentEditing}
              theme={resolvedTheme === "dark" ? "dark" : "light"}
              UIOptions={{ canvasActions: { loadScene: false } }}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Loading drawing…
            </div>
          )}
        </div>
      </main>

      <ResizableChatPane
        controller={chatPane}
        className="min-w-[20rem] max-w-[37.5rem] flex-col border-l border-border/65 bg-background"
      >
        {props.chatPanel}
      </ResizableChatPane>
    </div>
  );
}

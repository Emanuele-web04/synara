// FILE: CodeEditorPane.tsx
// Purpose: The editable file surface: lazy engine load with a plain-text
//          fallback, the configured save chord, and the shared props contract
//          used by the preview, file editor and diff editor panes. Stable and
//          Beta use the same native (Code OSS) engine.
// Layer: Web editor UI
// Exports: CodeEditorPane, CodeEditorPaneProps, EditorSurfaceBoundary,
//          EditorSurfaceRetry, PierreEnginePane, useCodeEditorSaveKeyDownHandler

import { Component, lazy, Suspense, useRef, type ReactNode, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { NATIVE_EDITOR_ON } from "~/betaFeatures";
import type { ChatFileReference } from "~/lib/chatReferences";
import { PanelStateMessage } from "../chat/PanelStateMessage";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { CodeEditHistoryControls, CodeEditHistoryState } from "./codeEditHistory";
import { reloadEditorAfterSave } from "./editorRecovery";
import { useCodeEditorSaveKeyDownHandler } from "./editorSaveShortcut";

export { useCodeEditorSaveKeyDownHandler };

const EditorSurface = lazy(() => import("./MonacoEditorSurface"));
export type EditorSurfaceComponent = typeof EditorSurface;
// The alternative engine stays lazy when native editing is enabled.
const PierreFilePane = lazy(() =>
  import("./PierreEditorPanes").then((module) => ({ default: module.PierreCodeEditorPane })),
);
const PierreDiffPane = lazy(() =>
  import("./PierreEditorPanes").then((module) => ({ default: module.PierreCodeDiffEditorPane })),
);
export const PIERRE_ENGINE_PANES = { file: PierreFilePane, diff: PierreDiffPane } as const;

/** Mounts the Pierre pane behind the same loading message as the native surface. */
export function PierreEnginePane(props: { loading: ReactNode; children: ReactNode }) {
  return <Suspense fallback={props.loading}>{props.children}</Suspense>;
}
export interface CodeEditorPaneProps {
  value: string;
  valueVersion: number;
  fileName: string;
  workspaceRoot?: string | null | undefined;
  resolvedTheme: "light" | "dark";
  onChange: (value: string) => void;
  onSave: () => void;
  onReferenceInChat?: ((reference: ChatFileReference) => void) | undefined;
  historyControlsRef?: RefObject<CodeEditHistoryControls | null> | undefined;
  onHistoryChange?: ((history: CodeEditHistoryState) => void) | undefined;
}

class EditorSurfaceErrorBoundary extends Component<
  { children: ReactNode; fallback: (retry: () => void) => ReactNode; onRetry: () => void },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback(this.props.onRetry) : this.props.children;
  }
}

/**
 * Keeps a draft editable when the engine chunk fails to load (offline, a stale
 * build). Retry flushes all native editor buffers before reloading the page:
 * recreating React.lazy alone cannot clear a browser's failed module import.
 */
export function EditorSurfaceBoundary(props: {
  children: (Surface: EditorSurfaceComponent) => ReactNode;
  fallback: (retry: () => void) => ReactNode;
  loading: ReactNode;
}) {
  const client = useQueryClient();
  const retrying = useRef(false);
  const retry = () => {
    if (retrying.current) return;
    retrying.current = true;
    void reloadEditorAfterSave(client)
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not reload the editor",
          description: error instanceof Error ? error.message : "Your draft is preserved.",
        });
      })
      .finally(() => {
        retrying.current = false;
      });
  };
  return (
    <EditorSurfaceErrorBoundary fallback={props.fallback} onRetry={retry}>
      <Suspense fallback={props.loading}>{props.children(EditorSurface)}</Suspense>
    </EditorSurfaceErrorBoundary>
  );
}

export function EditorSurfaceRetry(props: { message: string; onRetry: () => void }) {
  return (
    <PanelStateMessage density="compact" fill="flex" className="flex-col gap-2">
      <p>{props.message}</p>
      <Button type="button" size="sm" variant="outline" onClick={props.onRetry}>
        Retry
      </Button>
    </PanelStateMessage>
  );
}

export function CodeEditorPane(props: CodeEditorPaneProps) {
  const saveKeyDownHandler = useCodeEditorSaveKeyDownHandler(props.onSave);
  const loading = (
    <PanelStateMessage density="compact" fill="flex">
      <p>Loading editor…</p>
    </PanelStateMessage>
  );
  if (!NATIVE_EDITOR_ON) {
    return (
      <PierreEnginePane loading={loading}>
        <PierreFilePane {...props} />
      </PierreEnginePane>
    );
  }
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      onKeyDownCapture={saveKeyDownHandler}
    >
      <EditorSurfaceBoundary
        loading={loading}
        fallback={(retry) => (
          <>
            <EditorSurfaceRetry
              message="The editor could not load. Your draft is preserved; plain-text editing is available."
              onRetry={retry}
            />
            <textarea
              aria-label={`Edit ${props.fileName}`}
              className="min-h-0 flex-1 resize-none bg-transparent p-3 font-chat-code text-chat-code"
              value={props.value}
              onChange={(event) => props.onChange(event.currentTarget.value)}
            />
          </>
        )}
      >
        {(Surface) => <Surface {...props} />}
      </EditorSurfaceBoundary>
    </div>
  );
}

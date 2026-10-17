// FILE: CodeEditorPane.tsx
// Purpose: The editable file surface: lazy engine load with a plain-text
//          fallback, the configured save chord, and the shared props contract
//          used by the preview, file editor and diff editor panes.
// Layer: Web editor UI
// Exports: CodeEditorPane, CodeEditorPaneProps, EditorSurfaceBoundary,
//          useCodeEditorSaveKeyDownHandler

import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useQuery } from "@tanstack/react-query";
import type { ResolvedKeybindingsConfig } from "@synara/contracts";

import { isBrowserSaveChord } from "~/hooks/useWorkspaceFileEditorShortcuts";
import { isEditorFileSaveShortcut } from "~/keybindings";
import type { ChatFileReference } from "~/lib/chatReferences";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { PanelStateMessage } from "../chat/PanelStateMessage";
import { Button } from "../ui/button";
import type { CodeEditHistoryControls, CodeEditHistoryState } from "./codeEditHistory";

const MonacoEditorSurface = lazy(() => import("./MonacoEditorSurface"));
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

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

// Capture-phase save handling: the engine hosts its own key handling, so saves
// are dispatched from the container. The chord is matched against the
// configured `editor.file.save` binding (not hard-coded Mod+S) so rebinds are
// honored, while the browser save dialog stays suppressed for the default chord.
export function useCodeEditorSaveKeyDownHandler(onSave: () => void) {
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  return useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (isBrowserSaveChord(event)) {
        event.preventDefault();
      }
      if (!isEditorFileSaveShortcut(event, keybindings)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onSaveRef.current();
    },
    [keybindings],
  );
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
    return this.state.failed
      ? this.props.fallback(() => {
          this.setState({ failed: false });
          this.props.onRetry();
        })
      : this.props.children;
  }
}

/**
 * Keeps a draft editable when the engine chunk fails to load (offline, a stale
 * build): shows the fallback with a Retry that remounts the surface.
 */
export function EditorSurfaceBoundary(props: {
  children: ReactNode;
  fallback: (retry: () => void) => ReactNode;
  loading: ReactNode;
}) {
  const [attempt, setAttempt] = useState(0);
  return (
    <EditorSurfaceErrorBoundary
      key={attempt}
      fallback={props.fallback}
      onRetry={() => setAttempt((value) => value + 1)}
    >
      <Suspense fallback={props.loading}>{props.children}</Suspense>
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
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      onKeyDownCapture={saveKeyDownHandler}
    >
      <EditorSurfaceBoundary
        loading={
          <PanelStateMessage density="compact" fill="flex">
            <p>Loading editor…</p>
          </PanelStateMessage>
        }
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
        <MonacoEditorSurface {...props} />
      </EditorSurfaceBoundary>
    </div>
  );
}

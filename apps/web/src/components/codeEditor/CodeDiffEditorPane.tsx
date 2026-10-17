import { lazy, Suspense, type RefObject } from "react";
import type { ChatFileReference } from "~/lib/chatReferences";
import { EditorSurfaceBoundary, useCodeEditorSaveKeyDownHandler } from "./CodeEditorPane";
import type { CodeEditHistoryControls, CodeEditHistoryState } from "./pierreEdit";
const MonacoEditorSurface = lazy(() => import("./MonacoEditorSurface"));

export interface CodeDiffEditorPaneProps {
  original: string;
  originalVersion: number;
  modified: string;
  modifiedVersion: number;
  fileName: string;
  workspaceRoot?: string | null | undefined;
  onReferenceInChat?: ((reference: ChatFileReference) => void) | undefined;
  resolvedTheme: "light" | "dark";
  renderSideBySide: boolean;
  readOnly?: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  historyControlsRef?: RefObject<CodeEditHistoryControls | null> | undefined;
  onHistoryChange?: ((history: CodeEditHistoryState) => void) | undefined;
}

export function CodeDiffEditorPane(props: CodeDiffEditorPaneProps) {
  const saveKeyDownHandler = useCodeEditorSaveKeyDownHandler(props.onSave);
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      onKeyDownCapture={saveKeyDownHandler}
    >
      <EditorSurfaceBoundary
        fallback={
          <p role="alert" className="p-3 text-ui-sm">
            The diff editor could not load. Your draft is preserved. Reopen the file to continue
            editing.
          </p>
        }
      >
        <Suspense
          fallback={
            <p role="status" className="p-3 text-ui-sm text-muted-foreground">
              Loading diff editor…
            </p>
          }
        >
          <MonacoEditorSurface
            {...props}
            value={props.modified}
            valueVersion={props.modifiedVersion}
          />
        </Suspense>
      </EditorSurfaceBoundary>
    </div>
  );
}

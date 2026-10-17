// FILE: CodeDiffEditorPane.tsx
// Purpose: The editable diff surface over the same native document model as
//          the file editor, with the shared boundary and save chord.
// Layer: Web editor UI
// Exports: CodeDiffEditorPane, CodeDiffEditorPaneProps

import type { RefObject } from "react";

import type { ChatFileReference } from "~/lib/chatReferences";
import { PanelStateMessage } from "../chat/PanelStateMessage";
import {
  EditorSurfaceBoundary,
  EditorSurfaceRetry,
  useCodeEditorSaveKeyDownHandler,
} from "./CodeEditorPane";
import type { CodeEditHistoryControls, CodeEditHistoryState } from "./codeEditHistory";

export interface CodeDiffEditorPaneProps {
  original: string;
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
        loading={
          <PanelStateMessage density="compact" fill="flex">
            <p>Loading diff editor…</p>
          </PanelStateMessage>
        }
        fallback={(retry) => (
          <EditorSurfaceRetry
            message="The diff editor could not load. Your draft is preserved."
            onRetry={retry}
          />
        )}
      >
        {(Surface) => (
          <Surface {...props} value={props.modified} valueVersion={props.modifiedVersion} />
        )}
      </EditorSurfaceBoundary>
    </div>
  );
}

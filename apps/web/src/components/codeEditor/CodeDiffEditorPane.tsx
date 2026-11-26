import { useTranslation } from "~/i18n";
// FILE: CodeDiffEditorPane.tsx
// Purpose: The editable diff surface over the same native document model as
//          the file editor, with the shared boundary and save chord.
// Layer: Web editor UI
// Exports: CodeDiffEditorPane, CodeDiffEditorPaneProps

import type { RefObject } from "react";

import { NATIVE_EDITOR_ON } from "~/betaFeatures";
import type { ChatFileReference } from "~/lib/chatReferences";
import { PanelStateMessage } from "../chat/PanelStateMessage";
import {
  EditorSurfaceBoundary,
  EditorSurfaceRetry,
  PIERRE_ENGINE_PANES,
  PierreEnginePane,
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
  const { t } = useTranslation();

  const saveKeyDownHandler = useCodeEditorSaveKeyDownHandler(props.onSave);
  const loading = (
    <PanelStateMessage density="compact" fill="flex">
      <p>{t("workspace:loadingDiffEditor")}</p>
    </PanelStateMessage>
  );
  if (!NATIVE_EDITOR_ON) {
    const PierreDiffPane = PIERRE_ENGINE_PANES.diff;
    return (
      <PierreEnginePane loading={loading}>
        <PierreDiffPane {...props} />
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
          <EditorSurfaceRetry message={t("workspace:diffEditorLoadFailed")} onRetry={retry} />
        )}
      >
        {(Surface) => (
          <Surface {...props} value={props.modified} valueVersion={props.modifiedVersion} />
        )}
      </EditorSurfaceBoundary>
    </div>
  );
}

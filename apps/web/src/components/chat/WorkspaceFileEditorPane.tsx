import { useRef, useState } from "react";

import { useWorkspaceFileEditorSession } from "~/hooks/useWorkspaceFileEditorSession";
import { CodeEditorPane } from "../codeEditor/CodeEditorPane";
import {
  INITIAL_CODE_EDIT_HISTORY_STATE,
  type CodeEditHistoryControls,
} from "../codeEditor/pierreEdit";
import { PanelStateMessage } from "./PanelStateMessage";
import {
  WorkspaceFileEditorConflictBar,
  WorkspaceFileEditorDiscardDialog,
  WorkspaceFileEditorHeader,
  WorkspaceFileEditorHistoryActions,
} from "./WorkspaceFileEditorChrome";
import { useTranslation } from "~/i18n";

export interface WorkspaceFileEditorPaneProps {
  workspaceRoot: string | null;
  filePath: string;
  resolvedTheme: "light" | "dark";
  onClose: () => void;
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
  onSavingChange?: ((saving: boolean) => void) | undefined;
}

export function WorkspaceFileEditorPane(props: WorkspaceFileEditorPaneProps) {
  const { t } = useTranslation();

  const paneRef = useRef<HTMLDivElement | null>(null);
  const session = useWorkspaceFileEditorSession({
    cwd: props.workspaceRoot,
    filePath: props.filePath,
    enabled: true,
    surfaceRef: paneRef,
    onClose: props.onClose,
    onDirtyChange: props.onDirtyChange,
    onSavingChange: props.onSavingChange,
  });
  const historyControlsRef = useRef<CodeEditHistoryControls | null>(null);
  const [history, setHistory] = useState(INITIAL_CODE_EDIT_HISTORY_STATE);

  return (
    <div ref={paneRef} className="flex h-full min-h-0 min-w-0 flex-1 flex-col app-content-surface">
      <WorkspaceFileEditorHeader
        workspaceRoot={props.workspaceRoot}
        filePath={props.filePath}
        title={t("Editing")}
        dirty={session.dirty}
        saving={session.state.saving}
        canSave={session.dirty && session.canEdit}
        onSave={session.save}
        onClose={session.requestClose}
        actions={
          <WorkspaceFileEditorHistoryActions
            history={history}
            canRevert={session.dirty && session.canEdit}
            onUndo={() => historyControlsRef.current?.undo()}
            onRedo={() => historyControlsRef.current?.redo()}
            onRevert={() => historyControlsRef.current?.revertTo(session.state.baseline)}
          />
        }
      />
      {session.state.saveError ? (
        <WorkspaceFileEditorConflictBar
          message={session.state.saveError}
          conflict={session.state.conflict}
          onReload={session.requestReload}
          onOverwrite={session.overwrite}
        />
      ) : null}
      {session.loadError ? (
        <PanelStateMessage density="compact" fill="flex" className="items-start justify-start p-3">
          <p className="text-left text-ui-sm text-destructive/85">{session.loadError}</p>
        </PanelStateMessage>
      ) : session.readOnlyReason ? (
        <PanelStateMessage density="compact" fill="flex">
          <p>{session.readOnlyReason}</p>
        </PanelStateMessage>
      ) : session.loading || !session.canEdit ? (
        <PanelStateMessage density="compact" fill="flex">
          <p>{t("Loading file...")}</p>
        </PanelStateMessage>
      ) : (
        <CodeEditorPane
          value={session.state.value}
          valueVersion={session.state.version}
          fileName={props.filePath}
          resolvedTheme={props.resolvedTheme}
          onChange={session.handleChange}
          onSave={session.save}
          historyControlsRef={historyControlsRef}
          onHistoryChange={setHistory}
        />
      )}
      <WorkspaceFileEditorDiscardDialog
        open={session.pendingDiscard !== null}
        title={t("Discard unsaved changes?")}
        description={
          session.pendingDiscard === "reload"
            ? t("Reloading replaces the editor contents with what is currently on disk.")
            : t("Closing the editor drops the changes you have not saved yet.")
        }
        confirmLabel={
          session.pendingDiscard === "reload" ? t("Reload and discard") : t("Discard changes")
        }
        onOpenChange={(open) => {
          if (!open) {
            session.cancelPendingDiscard();
          }
        }}
        onConfirm={session.confirmPendingDiscard}
      />
    </div>
  );
}

import { toastManager, type ThreadUndoToastDetails } from "../components/ui/toast";

export const THREAD_UNDO_TOAST_DURATION_MS = 8_000;

/** Undo remains visible across navigation and expires only after its visible lifetime. */
export function showUndoToast(id: string, archiveUndo: ThreadUndoToastDetails) {
  return toastManager.add({
    id,
    timeout: 0,
    data: {
      allowCrossThreadVisibility: true,
      dismissAfterVisibleMs: THREAD_UNDO_TOAST_DURATION_MS,
      archiveUndo,
    },
  });
}

import type { Editor } from "@pierre/diffs/edit";

export type PierreEditor = Editor<undefined>;

export interface CodeEditHistoryControls {
  undo: () => void;
  redo: () => void;
  revertTo: (value: string) => void;
}

export interface CodeEditHistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

export const INITIAL_CODE_EDIT_HISTORY_STATE: CodeEditHistoryState = {
  canUndo: false,
  canRedo: false,
};

let editModule: Promise<typeof import("@pierre/diffs/edit")> | null = null;

export function loadPierreEdit(): Promise<typeof import("@pierre/diffs/edit")> {
  editModule ??= import("@pierre/diffs/edit");
  return editModule;
}

export function createCodeEditHistoryControls(editor: PierreEditor): CodeEditHistoryControls {
  return {
    undo: () => {
      editor.undo();
    },
    redo: () => {
      editor.redo();
    },
    revertTo: (value) => {
      if (editor.getText() === value) {
        return;
      }
      editor.applyEdits([
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: Number.MAX_SAFE_INTEGER, character: Number.MAX_SAFE_INTEGER },
          },
          newText: value,
        },
      ]);
    },
  };
}

export function readCodeEditHistoryState(editor: PierreEditor): CodeEditHistoryState {
  return { canUndo: editor.canUndo, canRedo: editor.canRedo };
}

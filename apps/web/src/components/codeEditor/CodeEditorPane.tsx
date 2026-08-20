import type { EditorOptions } from "@pierre/diffs/edit";
import { File } from "@pierre/diffs/react";
import { useMemo, useRef, type KeyboardEvent, type RefObject } from "react";

import { buildDiffPanelUnsafeCSS, resolveDiffThemeName } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";
import { CodeEditBoundary } from "./CodeEditBoundary";
import {
  createCodeEditHistoryControls,
  readCodeEditHistoryState,
  type CodeEditHistoryControls,
  type CodeEditHistoryState,
  type PierreEditor,
} from "./pierreEdit";
import { PanelStateMessage } from "../chat/PanelStateMessage";

export interface CodeEditorPaneProps {
  value: string;
  valueVersion: number;
  fileName: string;
  resolvedTheme: "light" | "dark";
  readOnly?: boolean;
  className?: string;
  onChange: (value: string) => void;
  onSave: () => void;
  historyControlsRef?: RefObject<CodeEditHistoryControls | null> | undefined;
  onHistoryChange?: ((history: CodeEditHistoryState) => void) | undefined;
}

export function useCodeEditorSessionOptions(input: {
  onChange: (value: string) => void;
  onHistoryChange?: ((history: CodeEditHistoryState) => void) | undefined;
  historyControlsRef?: RefObject<CodeEditHistoryControls | null> | undefined;
}): EditorOptions<undefined> {
  const onChangeRef = useRef(input.onChange);
  onChangeRef.current = input.onChange;
  const onHistoryChangeRef = useRef(input.onHistoryChange);
  onHistoryChangeRef.current = input.onHistoryChange;
  const historyControlsRef = input.historyControlsRef;
  const editorRef = useRef<PierreEditor | null>(null);

  return useMemo(
    () => ({
      onAttach: (editor: PierreEditor) => {
        editorRef.current = editor;
        if (historyControlsRef) {
          historyControlsRef.current = createCodeEditHistoryControls(editor);
        }
        onHistoryChangeRef.current?.(readCodeEditHistoryState(editor));
      },
      onChange: (file: { contents: string }) => {
        onChangeRef.current(file.contents);
        const editor = editorRef.current;
        if (editor) {
          onHistoryChangeRef.current?.(readCodeEditHistoryState(editor));
        }
      },
    }),
    [historyControlsRef],
  );
}

export function codeEditorSaveKeyDownHandler(onSave: () => void) {
  return (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      onSave();
    }
  };
}

export const CODE_EDITOR_LOADING_FALLBACK = (
  <PanelStateMessage density="compact" fill="flex">
    <p>Loading editor...</p>
  </PanelStateMessage>
);

export function CodeEditorPane(props: CodeEditorPaneProps) {
  const valueRef = useRef(props.value);
  valueRef.current = props.value;
  const file = useMemo(
    () => ({
      name: props.fileName,
      contents: valueRef.current,
      cacheKey: `edit:${props.fileName}:${props.valueVersion}`,
    }),
    [props.fileName, props.valueVersion],
  );
  const editorOptions = useCodeEditorSessionOptions({
    onChange: props.onChange,
    onHistoryChange: props.onHistoryChange,
    historyControlsRef: props.historyControlsRef,
  });
  const options = useMemo(
    () => ({
      theme: resolveDiffThemeName(props.resolvedTheme),
      themeType: props.resolvedTheme,
      unsafeCSS: buildDiffPanelUnsafeCSS(props.resolvedTheme),
      disableFileHeader: true,
      overflow: "scroll" as const,
    }),
    [props.resolvedTheme],
  );

  return (
    <div
      className={cn("min-h-0 min-w-0 flex-1 overflow-auto", props.className)}
      onKeyDownCapture={codeEditorSaveKeyDownHandler(props.onSave)}
    >
      <CodeEditBoundary fallback={CODE_EDITOR_LOADING_FALLBACK}>
        <File
          file={file}
          options={options}
          edit={!(props.readOnly ?? false)}
          editorOptions={editorOptions}
        />
      </CodeEditBoundary>
    </div>
  );
}

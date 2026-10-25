// FILE: PierreEditorPanes.tsx
// Purpose: Alternative editing surfaces when the native editor is disabled
//          and the editable diff, with the same props contract as the native
//          panes so the pane chrome does not change between flavors.
// Layer: Web editor UI (Pierre engine)
// Exports: PierreCodeEditorPane, PierreCodeDiffEditorPane, usePierreEditorSessionOptions

import { parseDiffFromFile } from "@pierre/diffs";
import type { EditorOptions } from "@pierre/diffs/edit";
import { File, FileDiff } from "@pierre/diffs/react";
import { normalizeLineEndings } from "@synara/shared/text";
import { useMemo, useRef, useState, type RefObject } from "react";

import { buildDiffPanelUnsafeCSS, resolveDiffThemeName } from "~/lib/diffRendering";
import { CodeEditBoundary } from "./CodeEditBoundary";
import type { CodeDiffEditorPaneProps } from "./CodeDiffEditorPane";
import type { CodeEditorPaneProps } from "./CodeEditorPane";
import type { CodeEditHistoryControls, CodeEditHistoryState } from "./codeEditHistory";
import { useCodeEditorSaveKeyDownHandler } from "./editorSaveShortcut";
import {
  createCodeEditHistoryControls,
  readCodeEditHistoryState,
  type PierreEditor,
} from "./pierreEdit";

export function usePierreEditorSessionOptions(input: {
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

  return useMemo(() => {
    let previousHistory: CodeEditHistoryState | undefined;
    const publishHistory = (editor: PierreEditor) => {
      const history = readCodeEditHistoryState(editor);
      // Most keystrokes change the buffer without changing toolbar availability.
      if (
        history.canUndo === previousHistory?.canUndo &&
        history.canRedo === previousHistory?.canRedo
      ) {
        return;
      }
      previousHistory = history;
      onHistoryChangeRef.current?.(history);
    };
    return {
      onAttach: (editor: PierreEditor) => {
        editorRef.current = editor;
        if (historyControlsRef) {
          historyControlsRef.current = createCodeEditHistoryControls(editor);
        }
        publishHistory(editor);
      },
      onChange: (file: { contents: string }) => {
        onChangeRef.current(file.contents);
        const editor = editorRef.current;
        if (editor) {
          publishHistory(editor);
        }
      },
    };
  }, [historyControlsRef]);
}

export function PierreCodeEditorPane(props: CodeEditorPaneProps) {
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
  const editorOptions = usePierreEditorSessionOptions({
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

  const saveKeyDownHandler = useCodeEditorSaveKeyDownHandler(props.onSave);
  // Pierre owns live edits; only a reload or display change needs a React update.
  const content = useMemo(
    () => <File file={file} options={options} edit editorOptions={editorOptions} />,
    [file, options, editorOptions],
  );

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      onKeyDownCapture={saveKeyDownHandler}
    >
      <CodeEditBoundary>{content}</CodeEditBoundary>
    </div>
  );
}

export function PierreCodeDiffEditorPane(props: CodeDiffEditorPaneProps) {
  // The base revision carries no version of its own; count its changes here so
  // the parsed diff re-reads it when it moves.
  const originalVersionRef = useRef({ contents: props.original, version: 0 });
  if (originalVersionRef.current.contents !== props.original) {
    originalVersionRef.current = {
      contents: props.original,
      version: originalVersionRef.current.version + 1,
    };
  }
  const originalVersion = originalVersionRef.current.version;
  const originalRef = useRef(props.original);
  originalRef.current = props.original;
  const modifiedRef = useRef(props.modified);
  modifiedRef.current = props.modified;
  // A layout switch remounts FileDiff (below), and the remount must start from
  // the buffer as it is now, not from the snapshot parsed at the last load or
  // reload. Bump a parse generation whenever the layout changes so the memo
  // re-reads the current contents for the new instance.
  const layout = props.renderSideBySide ? "split" : "unified";
  const [parseGeneration, setParseGeneration] = useState({ layout, version: 0 });
  if (parseGeneration.layout !== layout) {
    setParseGeneration({ layout, version: parseGeneration.version + 1 });
  }
  const fileDiff = useMemo(
    () =>
      parseDiffFromFile(
        {
          name: props.fileName,
          contents: normalizeLineEndings(originalRef.current),
          cacheKey: `diff-edit:${props.fileName}:old:${originalVersion}:${parseGeneration.version}`,
        },
        {
          name: props.fileName,
          contents: normalizeLineEndings(modifiedRef.current),
          cacheKey: `diff-edit:${props.fileName}:new:${props.modifiedVersion}:${parseGeneration.version}`,
        },
      ),
    [props.fileName, props.modifiedVersion, originalVersion, parseGeneration.version],
  );
  const editorOptions = usePierreEditorSessionOptions({
    onChange: props.onChange,
    onHistoryChange: props.onHistoryChange,
    historyControlsRef: props.historyControlsRef,
  });
  const options = useMemo(
    () => ({
      theme: resolveDiffThemeName(props.resolvedTheme),
      themeType: props.resolvedTheme,
      unsafeCSS: buildDiffPanelUnsafeCSS(props.resolvedTheme),
      diffStyle: props.renderSideBySide ? ("split" as const) : ("unified" as const),
      lineDiffType: "word" as const,
      disableFileHeader: true,
      overflow: "scroll" as const,
    }),
    [props.renderSideBySide, props.resolvedTheme],
  );
  const saveKeyDownHandler = useCodeEditorSaveKeyDownHandler(props.onSave);
  // Keep live edits inside Pierre; refresh React's view on reload, layout or theme changes.
  const content = useMemo(
    () => (
      <FileDiff
        key={layout}
        fileDiff={fileDiff}
        options={options}
        edit={!(props.readOnly ?? false)}
        editorOptions={editorOptions}
      />
    ),
    [layout, fileDiff, options, props.readOnly, editorOptions],
  );

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      onKeyDownCapture={saveKeyDownHandler}
    >
      <CodeEditBoundary>
        {/* diffStyle is effectively mount-time config on FileDiff, so a layout
            switch must remount the instance (same treatment as the diff panel). */}
        {content}
      </CodeEditBoundary>
    </div>
  );
}

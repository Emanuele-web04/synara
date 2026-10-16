import { useLayoutEffect } from "react";
import { rememberEditorView, takeEditorView, type EditorViewHandoff } from "./editorViewHandoff";
import { useContext } from "react";
import { EditorToolScopeContext, type EditorTool } from "./editorToolScope";
import { getEditorExtensionBridge } from "./editorExtensionBridge";
import { EditorExtensionInteraction } from "./EditorExtensionInteraction";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { EditorLocation, ContextMenuItem } from "@synara/contracts";
import { ensureNativeApi } from "~/nativeApi";
import { useWorkspaceFileOpener } from "~/lib/workspaceFileOpener";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle, DialogDescription, DialogFooter } from "../ui/dialog";
import { Input } from "../ui/input";
import type { CodeEditorPaneProps } from "./CodeEditorPane";
import { EditorActionPicker, type EditorActionRow } from "./EditorActionPicker";
import { editorAppearance, monaco } from "./editorRuntime";
import {
  acquireEditorModel,
  applyEditorEdits,
  editorUri,
  locationRange,
  offsetRange,
  rememberEditorLocation,
  replaceEditorText,
  requestIntelligence,
  setEditorServiceStatus,
  supportsProjectIntelligence,
  takeEditorLocation,
  type EditorModelEntry,
} from "./editorModels";
import { getEditorDebugStore } from "./editorDebugStore";
import { EditorDebugLaunchDialog, EditorDebugPanel } from "./EditorDebugPanel";
import "./editorSurface.css";

type SurfaceProps = CodeEditorPaneProps & {
  original?: string;
  originalVersion?: number;
  renderSideBySide?: boolean;
  readOnly?: boolean;
};
type Controller = {
  editor: monaco.editor.IStandaloneCodeEditor;
  instance: monaco.editor.IStandaloneCodeEditor | monaco.editor.IStandaloneDiffEditor;
  entry: EditorModelEntry;
  original?: monaco.editor.ITextModel;
};
type PickerState = {
  title: string;
  mode: "commands" | "results" | "workspaceSymbols";
  rows: EditorActionRow[];
};
const diffLabels = (fileName: string) => ({
  originalAriaLabel: `Original ${fileName}`,
  modifiedAriaLabel: `Edit ${fileName}`,
});
const emptyPicker: PickerState = { title: "Editor commands", mode: "commands", rows: [] };

export default function MonacoEditorSurface(props: SurfaceProps) {
  const client = useQueryClient();
  const toolScope = useContext(EditorToolScopeContext);
  const toolOwner = useRef({});
  const openTool = useRef<(tool: EditorTool, manage?: () => void) => void>(() => undefined);
  const extensionInteractionOwner = useRef({});
  const extensionBridge = useMemo(
    () => (props.workspaceRoot ? getEditorExtensionBridge(client, props.workspaceRoot) : null),
    [client, props.workspaceRoot],
  );
  const debugStore = useMemo(
    () => (props.workspaceRoot ? getEditorDebugStore(client, props.workspaceRoot) : null),
    [client, props.workspaceRoot],
  );
  const [debugLaunch, setDebugLaunch] = useState<"launch" | "attach" | null>(null);
  const opener = useWorkspaceFileOpener();
  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<Controller | null>(null);
  const current = useRef({ props, opener });
  current.current = { props, opener };
  const [controller, setController] = useState<Controller | null>(null);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [diagnosticCount, setDiagnosticCount] = useState({ errors: 0, warnings: 0 });
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [rename, setRename] = useState<{
    value: string;
    offset: number;
    version: number;
    error: string | null;
  } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const commandRef = useRef<(id: string) => void>(() => undefined);
  useEffect(() => {
    if (!controller || !extensionBridge) return;
    return extensionBridge.retain(
      controller.entry,
      !props.readOnly,
      extensionInteractionOwner.current,
    );
  }, [controller, extensionBridge, props.readOnly]);

  useEffect(() => {
    if (!controller || !toolScope) return;
    const owner = toolOwner.current;
    const release = toolScope.attach(owner, {
      filePath: controller.entry.relativePath,
      available: [],
      selected: null,
      problemCount: 0,
      debugging: false,
      open: (tool, manage) => openTool.current(tool, manage),
    });
    const focus = controller.editor.onDidFocusEditorText(() => toolScope.focus(owner));
    const debug = () =>
      toolScope.update(owner, {
        debugging: Boolean(
          debugStore && ["starting", "running", "paused"].includes(debugStore.getSnapshot().phase),
        ),
      });
    const unsubscribe = debugStore?.subscribe(debug);
    debug();
    return () => {
      focus.dispose();
      unsubscribe?.();
      release();
    };
  }, [controller, toolScope, debugStore]);
  useEffect(() => {
    if (!controller || !toolScope) return;
    const selected: EditorTool | null =
      debugLaunch || picker?.title === "Run and debug"
        ? "debug"
        : picker?.title === "Go to symbol in file"
          ? "outline"
          : picker?.title === "Problems in this file"
            ? "problems"
            : picker?.title === "Extensions"
              ? "extensions"
              : picker?.mode === "commands"
                ? "commands"
                : null;
    toolScope.update(toolOwner.current, {
      available: [
        "problems",
        "commands",
        "extensions",
        ...(debugStore ? ["debug" as const] : []),
        ...(supportsProjectIntelligence(controller.entry) ? ["outline" as const] : []),
      ],
      selected,
      problemCount: diagnosticCount.errors + diagnosticCount.warnings,
    });
  }, [controller, toolScope, debugStore, debugLaunch, picker, diagnosticCount]);
  openTool.current = (tool, manage) => {
    if (tool === "extensions") {
      results("Extensions", [
        ...(manage ? [{ id: "extensions:manage", label: "Manage extensions", run: manage }] : []),
        ...commands().filter((row) => row.id.startsWith("extensions:")),
      ]);
    } else if (tool === "debug") {
      results(
        "Run and debug",
        commands().filter((row) => row.id.startsWith("debug") || row.id === "extensions:debug"),
      );
    } else commandRef.current(tool === "outline" ? "documentSymbols" : tool);
  };

  function report(error: unknown) {
    const entry = controllerRef.current?.entry;
    if (entry)
      setEditorServiceStatus(
        entry,
        error instanceof Error ? error.message : "The editor action failed.",
      );
  }
  function focusEditor() {
    queueMicrotask(() => controllerRef.current?.editor.focus());
  }
  function reveal(location: EditorLocation) {
    const currentController = controllerRef.current;
    if (!currentController) return;
    const { entry, editor } = currentController;
    const range = locationRange(location);
    if (location.relativePath === entry.relativePath) {
      editor.setSelection(range);
      editor.revealRangeInCenter(range);
      editor.focus();
      return;
    }
    const uri = editorUri(entry.client, entry.cwd, location.relativePath);
    rememberEditorLocation(uri, range);
    if (!current.current.opener?.openFile(location.relativePath))
      throw new Error("This surface cannot open another workspace file. Open it from Files.");
  }
  function results(title: string, rows: EditorActionRow[]) {
    setQuery("");
    setPicker({ title, mode: "results", rows });
  }
  function locationRows(locations: readonly EditorLocation[], name?: string) {
    return locations.map((location, index) => ({
      id: `location:${index}`,
      label: name ?? location.relativePath,
      detail: `${location.relativePath}:${location.line + 1}:${location.character + 1}`,
      run: () => reveal(location),
    }));
  }
  async function runCommand(id: string) {
    const active = controllerRef.current;
    if (!active) return;
    const { editor, entry } = active;
    const position = editor.getPosition() ?? new monaco.Position(1, 1);
    const selection = editor.getSelection() ?? new monaco.Selection(1, 1, 1, 1);
    const offset = entry.model.getOffsetAt(position);
    const start = entry.model.getOffsetAt(selection.getStartPosition());
    const length = entry.model.getOffsetAt(selection.getEndPosition()) - start;
    switch (id) {
      case "debugLaunch":
      case "debugAttach":
        if (!debugStore) throw new Error("Open a workspace to debug a program.");
        if (id === "debugLaunch" && debugStore.getSnapshot().phase === "paused")
          await debugStore.control("continue");
        else setDebugLaunch(id === "debugAttach" ? "attach" : "launch");
        return;
      case "debugStop":
        await debugStore?.stop();
        return;
      case "debugNext":
        await debugStore?.control("next");
        return;
      case "debugStepIn":
        await debugStore?.control("stepIn");
        return;
      case "debugStepOut":
        await debugStore?.control("stepOut");
        return;
      case "debugBreakpoint":
        if (!current.current.props.readOnly)
          await debugStore?.toggleBreakpoint(entry.relativePath, position.lineNumber);
        return;
      case "commands":
        setQuery("");
        setPicker({ ...emptyPicker, rows: commands() });
        return;
      case "workspaceSymbols":
        setQuery("");
        setPicker({ title: "Find a workspace symbol", mode: "workspaceSymbols", rows: [] });
        return;
      case "rename": {
        if (current.current.props.readOnly) return;
        setRename({
          value: entry.model.getWordAtPosition(position)?.word ?? "",
          offset,
          version: entry.model.getVersionId(),
          error: null,
        });
        return;
      }
      case "documentSymbols": {
        const result = await requestIntelligence(entry, "documentSymbols");
        if (result)
          results(
            "Go to symbol in file",
            (result.symbols ?? [])
              .flatMap((symbol) => locationRows([symbol.location], symbol.name))
              .map((row, index) => ({ ...row, id: `symbol:${index}` })),
          );
        return;
      }
      case "definition":
      case "declaration":
      case "typeDefinition":
      case "references": {
        const result = await requestIntelligence(entry, id, { offset });
        if (!result) return;
        if (id !== "references" && result.locations?.length === 1) reveal(result.locations[0]!);
        else
          results(
            id === "references" ? "Find references" : "Go to location",
            locationRows(result.locations ?? []),
          );
        return;
      }
      case "problems": {
        // Both native intelligence and extension diagnostics already publish
        // to this model. Keep one authoritative list, without a second service.
        const markers = monaco.editor.getModelMarkers({ resource: entry.model.uri });
        results(
          "Problems in this file",
          markers.map((item, index) => ({
            id: `problem:${index}`,
            label: item.message,
            detail: `${item.source ?? "Diagnostic"} · line ${item.startLineNumber}`,
            run: () => {
              const range = new monaco.Range(
                item.startLineNumber,
                item.startColumn,
                item.endLineNumber,
                item.endColumn,
              );
              editor.setSelection(range);
              editor.revealRangeInCenter(range);
              editor.focus();
            },
          })),
        );
        return;
      }
      case "codeActions": {
        const result = await requestIntelligence(entry, "codeActions", { offset: start, length });
        if (result)
          results(
            "Quick fixes and refactorings",
            (result.actions ?? []).map((action, index) => ({
              id: `action:${index}`,
              label: action.title,
              detail: action.kind,
              run: () => applyEditorEdits(entry, action.edits),
            })),
          );
        return;
      }
      case "organizeImports": {
        const result = await requestIntelligence(entry, "organizeImports");
        if (result?.edits) await applyEditorEdits(entry, result.edits);
        return;
      }
      case "referenceInChat": {
        const end = entry.model.getPositionAt(Math.max(start, start + length - 1));
        current.current.props.onReferenceInChat?.({
          path: entry.relativePath,
          startLine: selection.startLineNumber,
          startColumn: selection.startColumn,
          endLine: end.lineNumber,
          endColumn: end.column,
        });
        return;
      }
      case "undo":
        await entry.model.undo();
        return;
      case "redo":
        await entry.model.redo();
        return;
      default:
        await editor.getAction(id)?.run();
    }
  }
  commandRef.current = (id) => {
    void runCommand(id).catch(report);
  };
  function commands(): EditorActionRow[] {
    const active = controllerRef.current;
    if (!active) return [];
    const intelligence = supportsProjectIntelligence(active.entry);
    const editable = !current.current.props.readOnly;
    const action = (id: string, label: string, detail?: string): EditorActionRow => ({
      id,
      label,
      ...(detail ? { detail } : {}),
      run: () => runCommand(id),
    });
    return [
      action("actions.find", "Find in file"),
      ...(editable ? [action("editor.action.startFindReplaceAction", "Replace in file")] : []),
      ...(intelligence
        ? [
            action("editor.action.triggerSuggest", "Show suggestions", "Ctrl+Space"),
            action("editor.action.triggerParameterHints", "Show signature help"),
            action("editor.action.showHover", "Show documentation"),
            action("definition", "Go to definition", "F12"),
            action("declaration", "Go to declaration"),
            action("typeDefinition", "Go to type definition"),
            action("references", "Find references", "Shift+F12"),
            action("documentSymbols", "Go to symbol in file"),
            action("workspaceSymbols", "Find a workspace symbol"),
            action("problems", "Show problems in file"),
          ]
        : []),
      ...(editable
        ? [
            action("undo", "Undo"),
            action("redo", "Redo"),
            action("editor.action.formatDocument", "Format document"),
            ...(intelligence
              ? [
                  action("rename", "Rename symbol", "F2"),
                  action("codeActions", "Quick fixes and refactorings"),
                  action("organizeImports", "Organize imports"),
                ]
              : []),
          ]
        : []),
      ...(debugStore
        ? [
            action(
              "debugLaunch",
              debugStore.getSnapshot().phase === "paused"
                ? "Continue debugging"
                : "Start debugging…",
              "F5",
            ),
            action("debugAttach", "Attach to Node.js…"),
            action("debugBreakpoint", "Toggle breakpoint", "F9"),
            ...(["running", "paused"].includes(debugStore.getSnapshot().phase)
              ? [action("debugStop", "Stop debugging", "Shift+F5")]
              : []),
          ]
        : []),
      ...(extensionBridge && editable ? extensionBridge.actionRows(active.entry, results) : []),
      action("editor.foldAll", "Fold all"),
      action("editor.unfoldAll", "Unfold all"),
      ...(current.current.props.onReferenceInChat
        ? [action("referenceInChat", "Reference selection in chat")]
        : []),
    ];
  }

  const viewHandoffRef = useRef<{ key: string; view: EditorViewHandoff } | null>(null);
  const cwd = props.workspaceRoot ?? null;
  const diff = props.original !== undefined;
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const initial = current.current.props;
    const handle = acquireEditorModel(
      client,
      cwd,
      initial.fileName,
      initial.value,
      initial.valueVersion,
    );
    const { entry } = handle;
    const appearance = editorAppearance(container, initial.resolvedTheme);
    let active: Controller;
    if (diff) {
      const original = monaco.editor.createModel(
        initial.original ?? "",
        entry.model.getLanguageId(),
      );
      const instance = monaco.editor.createDiffEditor(container, {
        ...appearance,
        originalEditable: false,
        renderSideBySide: initial.renderSideBySide ?? true,
        readOnly: initial.readOnly ?? false,
        renderOverviewRuler: false,
        enableSplitViewResizing: true,
        hideUnchangedRegions: { enabled: false },
        ...diffLabels(initial.fileName),
      });
      instance.setModel({ original, modified: entry.model });
      active = { instance, editor: instance.getModifiedEditor(), entry, original };
    } else {
      const editor = monaco.editor.create(container, {
        ...appearance,
        model: entry.model,
        readOnly: initial.readOnly ?? false,
        ariaLabel: `Edit ${initial.fileName}`,
      });
      active = { instance: editor, editor, entry };
    }
    controllerRef.current = active;
    setController(active);
    const { editor } = active;
    const viewKey = diff ? "diff" : "file";
    const view = entry.viewStates.get(viewKey);
    if (view) editor.restoreViewState(view);
    const handoffKey = JSON.stringify([cwd, initial.fileName, diff]);
    const requestedHandoff =
      !diff && cwd ? takeEditorView(client, cwd, initial.fileName, "editor") : undefined;
    if (requestedHandoff) viewHandoffRef.current = { key: handoffKey, view: requestedHandoff };
    const handoff =
      viewHandoffRef.current?.key === handoffKey ? viewHandoffRef.current.view : undefined;
    if (handoff) {
      const line = Math.min(entry.model.getLineCount(), Math.max(1, handoff.lineNumber));
      if (handoff.selection) {
        const start = entry.model.getPositionAt(handoff.selection.start);
        const end = entry.model.getPositionAt(handoff.selection.end);
        editor.setSelection(
          new monaco.Selection(start.lineNumber, start.column, end.lineNumber, end.column),
        );
      }
      // Measure the long visible lines before restoring horizontal offset;
      // otherwise Monaco clamps it against its still-empty initial scroll width.
      editor.layout();
      editor.render(true);
      editor.focus();
      editor.setScrollPosition(
        {
          scrollTop:
            editor.getTopForLineNumber(line) +
            handoff.lineFraction * editor.getOption(monaco.editor.EditorOption.lineHeight),
          scrollLeft: handoff.scrollLeft,
        },
        monaco.editor.ScrollType.Immediate,
      );
    }
    // React Strict Mode may set up, clean up, and set up the editor before
    // the first commit settles. Keep the explicit handoff for the surviving
    // instance, then release it once. Never reclaim focus from another control.
    if (handoff)
      queueMicrotask(() => {
        if (controllerRef.current !== active || !container.isConnected) return;
        if (viewHandoffRef.current?.view === handoff) viewHandoffRef.current = null;
        if (pending) return;
        const focused = document.activeElement;
        if (focused !== document.body && focused && !container.contains(focused)) return;
        editor.focus();
        editor.setScrollPosition(
          {
            scrollTop:
              editor.getTopForLineNumber(
                Math.min(entry.model.getLineCount(), Math.max(1, handoff.lineNumber)),
              ) +
              handoff.lineFraction * editor.getOption(monaco.editor.EditorOption.lineHeight),
            scrollLeft: handoff.scrollLeft,
          },
          monaco.editor.ScrollType.Immediate,
        );
      });
    const pending = takeEditorLocation(entry.model.uri);
    if (pending) {
      editor.setSelection(pending);
      editor.revealRangeInCenter(pending);
      editor.focus();
    }
    const onChange = (value: string) => current.current.props.onChange(value);
    const onStatus = (message: string | null) => setServiceError(message);
    entry.listeners.add(onChange);
    entry.statusListeners.add(onStatus);
    setServiceError(entry.status);
    let previousHistory = "";
    const history = () => {
      const value = { canUndo: entry.model.canUndo(), canRedo: entry.model.canRedo() };
      const key = JSON.stringify(value);
      if (key !== previousHistory) {
        previousHistory = key;
        current.current.props.onHistoryChange?.(value);
      }
    };
    const controls = {
      undo: () => {
        void Promise.resolve(entry.model.undo()).then(history);
      },
      redo: () => {
        void Promise.resolve(entry.model.redo()).then(history);
      },
      revertTo: (value: string) => {
        replaceEditorText(entry.model, value);
        history();
      },
    };
    if (initial.historyControlsRef) initial.historyControlsRef.current = controls;
    history();
    const subscriptions: monaco.IDisposable[] = [
      entry.model.onDidChangeContent(() => queueMicrotask(history)),
    ];
    // Monaco clips and scrolls each diff side independently. Give only a
    // horizontally scrolled gutter the existing dense Synara glass backing.
    const editors =
      "getOriginalEditor" in active.instance
        ? [active.instance.getOriginalEditor(), editor]
        : [editor];
    for (const surface of editors) {
      const syncGutter = () =>
        surface
          .getDomNode()
          ?.toggleAttribute("data-horizontal-scroll", surface.getScrollLeft() > 0);
      syncGutter();
      subscriptions.push(surface.onDidScrollChange(syncGutter));
    }
    for (const [id, label, binding] of [
      ["debugLaunch", "Start or continue debugging", monaco.KeyCode.F5],
      ["debugStop", "Stop debugging", monaco.KeyMod.Shift | monaco.KeyCode.F5],
      ["debugBreakpoint", "Toggle breakpoint", monaco.KeyCode.F9],
      ["debugNext", "Step over", monaco.KeyCode.F10],
      ["debugStepIn", "Step into", monaco.KeyCode.F11],
      ["debugStepOut", "Step out", monaco.KeyMod.Shift | monaco.KeyCode.F11],
      ["commands", "Editor commands", monaco.KeyCode.F1],
      ["rename", "Rename symbol", monaco.KeyCode.F2],
      ["definition", "Go to definition", monaco.KeyCode.F12],
      ["references", "Find references", monaco.KeyMod.Shift | monaco.KeyCode.F12],
      [
        "documentSymbols",
        "Go to symbol in file",
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyO,
      ],
    ] as const)
      subscriptions.push(
        editor.addAction({
          id: `synara.editor.${id}`,
          label,
          keybindings: [binding],
          run: () => commandRef.current(id),
        }),
      );
    subscriptions.push(
      editor.onContextMenu((event) => {
        event.event.preventDefault();
        event.event.stopPropagation();
        const position = event.target.position;
        if (position && !editor.getSelection()?.containsPosition(position))
          editor.setPosition(position);
        const rows = commands();
        const items: ContextMenuItem<string>[] = [
          { id: "commands", label: "Editor commands…" },
          ...(debugStore
            ? [
                {
                  id: "debug",
                  label: "Debug",
                  children: rows
                    .filter((row) => row.id.startsWith("debug"))
                    .map((row) => ({ id: row.id, label: row.label })),
                },
              ]
            : []),
          {
            id: "navigate",
            label: "Navigate",
            children: rows
              .filter((row) =>
                [
                  "definition",
                  "declaration",
                  "typeDefinition",
                  "references",
                  "documentSymbols",
                  "workspaceSymbols",
                ].includes(row.id),
              )
              .map((row) => ({ id: row.id, label: row.label })),
          },
          ...rows
            .filter((row) =>
              [
                "undo",
                "redo",
                "rename",
                "codeActions",
                "organizeImports",
                "editor.action.formatDocument",
                "actions.find",
                "referenceInChat",
              ].includes(row.id),
            )
            .map((row) => ({ id: row.id, label: row.label })),
        ].filter((item) => item.id !== "navigate" || item.children!.length > 0);
        void ensureNativeApi()
          .contextMenu.show(items, { x: event.event.posx, y: event.event.posy })
          .then((id) => {
            if (id) commandRef.current(id);
          })
          .catch(report);
      }),
    );
    subscriptions.push(
      monaco.editor.registerEditorOpener({
        openCodeEditor(source, resource, selection) {
          if (
            source !== editor ||
            resource.scheme !== entry.model.uri.scheme ||
            resource.authority !== entry.model.uri.authority ||
            resource.query !== entry.model.uri.query
          )
            return false;
          const range =
            selection && "startLineNumber" in selection
              ? selection
              : new monaco.Range(
                  selection?.lineNumber ?? 1,
                  selection?.column ?? 1,
                  selection?.lineNumber ?? 1,
                  selection?.column ?? 1,
                );
          if (resource.toString() === entry.model.uri.toString()) {
            editor.setSelection(range);
            editor.revealRangeInCenterIfOutsideViewport(range);
            editor.focus();
            return true;
          }
          rememberEditorLocation(resource, range);
          return current.current.opener?.openFile(resource.path.slice(1)) ?? false;
        },
      }),
    );
    return () => {
      if (!diff && cwd) {
        const lineNumber = editor.getVisibleRanges()[0]?.startLineNumber ?? 1;
        const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
        rememberEditorView(client, cwd, initial.fileName, {
          target: "preview",
          lineNumber,
          lineFraction: Math.max(
            0,
            (editor.getScrollTop() - editor.getTopForLineNumber(lineNumber)) / lineHeight,
          ),
          scrollLeft: editor.getScrollLeft(),
        });
      }
      const viewState = editor.saveViewState();
      if (viewState) entry.viewStates.set(viewKey, viewState);
      if (initial.historyControlsRef?.current === controls)
        initial.historyControlsRef.current = null;
      subscriptions.forEach((item) => item.dispose());
      entry.listeners.delete(onChange);
      entry.statusListeners.delete(onStatus);
      active.instance.dispose();
      active.original?.dispose();
      handle.release();
      if (controllerRef.current === active) controllerRef.current = null;
    };
  }, [client, cwd, props.fileName, diff]);

  useEffect(() => {
    if (!controller) return;
    const { entry, original, instance } = controller;
    // Bound sessions synchronize themselves; controlled standalone callers still support reload.
    if (!entry.session && entry.sourceVersion !== props.valueVersion) {
      entry.model.setValue(props.value);
      entry.sourceVersion = props.valueVersion;
    }
    if (original && original.getValue() !== props.original) original.setValue(props.original ?? "");
    instance.updateOptions({
      readOnly: props.readOnly ?? false,
      ...(original
        ? {
            renderSideBySide: props.renderSideBySide ?? true,
            ...diffLabels(props.fileName),
          }
        : {}),
    });
  }, [
    controller,
    props.value,
    props.valueVersion,
    props.original,
    props.originalVersion,
    props.readOnly,
    props.renderSideBySide,
    props.fileName,
  ]);

  useEffect(() => {
    if (!controller || !debugStore) return;
    const { entry, editor } = controller;
    const breakpoints = editor.createDecorationsCollection();
    const execution = editor.createDecorationsCollection();
    let breakpointKey = "";
    let frameKey = "";
    const update = () => {
      const state = debugStore.getSnapshot();
      const points = state.breakpoints.filter((point) => point.relativePath === entry.relativePath);
      const key = JSON.stringify(points);
      if (key !== breakpointKey) {
        breakpointKey = key;
        breakpoints.set(
          points.map((point) => ({
            range: new monaco.Range(point.line, 1, point.line, 1),
            options: {
              glyphMarginClassName: "synara-debug-breakpoint",
              glyphMarginHoverMessage: { value: "Breakpoint (F9 to toggle)", isTrusted: false },
              stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            },
          })),
        );
      }
      const frame =
        state.phase === "paused"
          ? state.frames.find(
              (item) => item.id === state.frameId && item.relativePath === entry.relativePath,
            )
          : undefined;
      const nextFrame = frame
        ? `${state.sessionId}:${state.pauseVersion}:${frame.id}:${frame.line}`
        : "";
      if (nextFrame !== frameKey) {
        frameKey = nextFrame;
        execution.set(
          frame
            ? [
                {
                  range: new monaco.Range(frame.line, 1, frame.line, 1),
                  options: {
                    isWholeLine: true,
                    className: "synara-debug-stopped-line",
                    glyphMarginClassName: "synara-debug-stopped-arrow",
                  },
                },
              ]
            : [],
        );
        if (frame) editor.revealLineInCenterIfOutsideViewport(frame.line);
      }
    };
    update();
    const unsubscribe = debugStore.subscribe(update);
    const mouse = editor.onMouseDown((event) => {
      if (
        event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
        !event.target.position ||
        current.current.props.readOnly
      )
        return;
      void debugStore
        .toggleBreakpoint(entry.relativePath, event.target.position.lineNumber)
        .catch(debugStore.report);
    });
    const moved = entry.model.onDidChangeContent(() => {
      const points = debugStore
        .getSnapshot()
        .breakpoints.filter((point) => point.relativePath === entry.relativePath);
      const ranges = breakpoints.getRanges();
      if (!points.length || points.length !== ranges.length) return;
      const adjusted = [
        ...new Map(
          points.map((point, index) => {
            const line = ranges[index]?.startLineNumber ?? point.line;
            return [line, { ...point, line }];
          }),
        ).values(),
      ].sort((a, b) => a.line - b.line);
      void debugStore.replaceBreakpoints(entry.relativePath, adjusted).catch(debugStore.report);
    });
    return () => {
      unsubscribe();
      mouse.dispose();
      moved.dispose();
      breakpoints.clear();
      execution.clear();
    };
  }, [controller, debugStore]);

  useEffect(() => {
    if (!controller || !containerRef.current) return;
    const update = () => {
      if (!containerRef.current) return;
      const options = editorAppearance(containerRef.current, props.resolvedTheme);
      // The upstream diff editor resets sub-editor labels on each update.
      // Carry native names through theme/typography updates as well as creation.
      controller.instance.updateOptions({
        ...options,
        ...(controller.original ? diffLabels(props.fileName) : {}),
      });
      monaco.editor.setTheme(options.theme!);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    return () => observer.disconnect();
  }, [controller, props.resolvedTheme, props.fileName]);

  useEffect(() => {
    if (!controller || !supportsProjectIntelligence(controller.entry)) return;
    const { entry } = controller;
    let timer: ReturnType<typeof setTimeout>;
    let request: AbortController | undefined;
    const refresh = () => {
      clearTimeout(timer);
      request?.abort();
      timer = setTimeout(() => {
        request = new AbortController();
        void requestIntelligence(entry, "diagnostics", { signal: request.signal })
          .then((result) => {
            if (!result || entry.model.isDisposed()) return;
            const diagnostics = result.diagnostics ?? [];
            monaco.editor.setModelMarkers(
              entry.model,
              "synara.typescript",
              diagnostics.map((item) => ({
                ...offsetRange(entry.model, item),
                message: item.message,
                code: String(item.code),
                source: "TypeScript",
                severity:
                  item.severity === "error"
                    ? monaco.MarkerSeverity.Error
                    : item.severity === "warning"
                      ? monaco.MarkerSeverity.Warning
                      : item.severity === "info"
                        ? monaco.MarkerSeverity.Info
                        : monaco.MarkerSeverity.Hint,
                tags: [
                  ...(item.unnecessary ? [monaco.MarkerTag.Unnecessary] : []),
                  ...(item.deprecated ? [monaco.MarkerTag.Deprecated] : []),
                ],
              })),
            );
            setDiagnosticCount({
              errors: diagnostics.filter((item) => item.severity === "error").length,
              warnings: diagnostics.filter((item) => item.severity === "warning").length,
            });
          })
          .catch(report);
      }, 350);
    };
    refresh();
    const change = entry.model.onDidChangeContent(refresh);
    return () => {
      clearTimeout(timer);
      request?.abort();
      change.dispose();
    };
  }, [controller]);

  useEffect(() => {
    if (picker?.mode !== "workspaceSymbols" || !controller) return;
    const abort = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      void requestIntelligence(controller.entry, "workspaceSymbols", {
        query,
        signal: abort.signal,
      })
        .then((result) => {
          if (abort.signal.aborted) return;
          setPicker((value) =>
            value?.mode === "workspaceSymbols"
              ? {
                  ...value,
                  rows: (result?.symbols ?? []).slice(0, 200).map((symbol, index) => ({
                    id: `symbol:${index}`,
                    label: symbol.name,
                    detail: `${symbol.location.relativePath}:${symbol.location.line + 1}`,
                    run: () => reveal(symbol.location),
                  })),
                }
              : value,
          );
        })
        .catch(report)
        .finally(() => {
          if (!abort.signal.aborted) setSearching(false);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [picker?.mode, query, controller]);

  const rows =
    picker?.rows.filter(
      (row) =>
        picker.mode === "workspaceSymbols" ||
        `${row.label} ${row.detail ?? ""}`.toLowerCase().includes(query.toLowerCase()),
    ) ?? [];
  return (
    <div className="synara-code-editor relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={containerRef}
        className="min-h-0 min-w-0 flex-1"
        data-testid="synara-editor-surface"
      />
      {serviceError ? (
        <div
          role="status"
          className="flex items-start gap-2 border-t border-border px-3 py-2 text-ui-sm text-muted-foreground"
        >
          <span className="min-w-0 flex-1">{serviceError}</span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setServiceError(null)}
            aria-label="Dismiss editor notice"
          >
            Dismiss
          </Button>
        </div>
      ) : null}
      {diagnosticCount.errors + diagnosticCount.warnings > 0 ? (
        <div className="flex justify-end px-2 pb-1">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => commandRef.current("problems")}
            aria-label="Show problems in file"
          >
            {diagnosticCount.errors} errors · {diagnosticCount.warnings} warnings
          </Button>
        </div>
      ) : null}
      {debugStore ? (
        <>
          <EditorDebugPanel
            store={debugStore}
            onReveal={(frame) => {
              if (!frame.relativePath) return;
              reveal({
                relativePath: frame.relativePath,
                line: Math.max(0, frame.line - 1),
                character: Math.max(0, frame.column - 1),
                endLine: Math.max(0, frame.line - 1),
                endCharacter: Math.max(0, frame.column),
                start: 0,
                length: 0,
              });
            }}
          />
          <EditorDebugLaunchDialog
            store={debugStore}
            open={debugLaunch !== null}
            request={debugLaunch ?? "launch"}
            program={props.fileName}
            onClose={() => {
              setDebugLaunch(null);
              focusEditor();
            }}
          />
        </>
      ) : null}
      {extensionBridge ? (
        <EditorExtensionInteraction
          bridge={extensionBridge}
          entry={controller?.entry ?? null}
          owner={extensionInteractionOwner.current}
        />
      ) : null}
      <EditorActionPicker
        open={picker !== null}
        title={picker?.title ?? "Editor commands"}
        query={query}
        rows={rows}
        busy={picker?.mode === "workspaceSymbols" && searching}
        onQueryChange={setQuery}
        onClose={() => {
          setPicker(null);
          focusEditor();
        }}
        onChoose={(row) => {
          setPicker(null);
          void Promise.resolve().then(row.run).catch(report);
        }}
      />
      <Dialog
        open={rename !== null}
        onOpenChange={(open) => {
          if (!open && !renaming) {
            setRename(null);
            focusEditor();
          }
        }}
      >
        <DialogPopup>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!rename || !controller || renaming) return;
              if (controller.entry.model.getVersionId() !== rename.version) {
                setRename({
                  ...rename,
                  error: "The document changed. Close this dialog and run Rename again.",
                });
                return;
              }
              setRenaming(true);
              void requestIntelligence(controller.entry, "rename", {
                offset: rename.offset,
                newName: rename.value,
              })
                .then(async (result) => {
                  if (!result?.edits) throw new Error("The document changed. Run Rename again.");
                  await applyEditorEdits(controller.entry, result.edits);
                  setRename(null);
                  focusEditor();
                })
                .catch((error: unknown) =>
                  setRename((value) =>
                    value
                      ? {
                          ...value,
                          error: error instanceof Error ? error.message : "Rename failed.",
                        }
                      : value,
                  ),
                )
                .finally(() => setRenaming(false));
            }}
            className="space-y-4 p-5"
          >
            <DialogTitle>Rename symbol</DialogTitle>
            <DialogDescription>
              Update references through the workspace’s language service.
            </DialogDescription>
            <Input
              autoFocus
              aria-label="New symbol name"
              value={rename?.value ?? ""}
              disabled={renaming}
              onChange={(event) => {
                const newName = event.currentTarget.value;
                setRename((value) => (value ? { ...value, value: newName, error: null } : value));
              }}
            />
            {rename?.error ? (
              <p role="alert" className="text-ui-sm text-destructive">
                {rename.error}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={renaming}
                onClick={() => {
                  setRename(null);
                  focusEditor();
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={renaming || !rename?.value.trim()}>
                {renaming ? "Renaming…" : "Rename"}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

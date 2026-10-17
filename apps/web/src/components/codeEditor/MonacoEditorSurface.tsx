// FILE: MonacoEditorSurface.tsx
// Purpose: The editable code surface (single file or diff) over the shared
//          native document model, with Synara's command picker, rename dialog,
//          context menu, diagnostics strip and debug controls around the engine.
// Layer: Web editor UI
// Depends on: editorRuntime (engine + appearance), editorModels (shared
//             models, language service), editorDebugStore, Synara keybindings.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent } from "react";
import type { ContextMenuItem, EditorLocation, ResolvedKeybindingsConfig } from "@synara/contracts";

import { useAppSettings } from "~/appSettings";
import {
  resolveEditorShortcutCommand,
  shortcutLabelForCommand,
  type EditorShortcutCommand,
} from "~/keybindings";
import { formatSelectionLabel } from "~/lib/chatReferences";
import { contextMenuGroup } from "~/lib/contextMenuGroup";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { useWorkspaceFileOpener } from "~/lib/workspaceFileOpener";
import { readNativeApi } from "~/nativeApi";
import { RenameDialog } from "../RenameDialog";
import { WorkspaceFileEditorNoticeBar } from "../chat/WorkspaceFileEditorChrome";
import { Button } from "../ui/button";
import { StatusDot } from "../ui/status-chip";
import { toastManager } from "../ui/toast";
import type { CodeEditorPaneProps } from "./CodeEditorPane";
import { EditorActionPicker, type EditorActionRow } from "./EditorActionPicker";
import { EditorDebugLaunchDialog, EditorDebugPanel } from "./EditorDebugPanel";
import { getEditorDebugStore } from "./editorDebugStore";
import { ensureEditorLanguage } from "./editorHighlighting";
import {
  acquireEditorModel,
  applyEditorEdits,
  editorUri,
  forgetEditorLocation,
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
import { editorAppearance, monaco } from "./editorRuntime";
import "./editorSurface.css";

type SurfaceProps = CodeEditorPaneProps & {
  original?: string;
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
type EditorCommand =
  | "commands"
  | "rename"
  | "definition"
  | "typeDefinition"
  | "references"
  | "documentSymbols"
  | "workspaceSymbols"
  | "problems"
  | "codeActions"
  | "organizeImports"
  | "referenceInChat"
  | "undo"
  | "redo"
  | "debugLaunch"
  | "debugAttach"
  | "debugStop"
  | "debugNext"
  | "debugStepIn"
  | "debugStepOut"
  | "debugBreakpoint"
  | (string & {});

/** Configured Synara shortcuts → the surface command they run. */
const SHORTCUT_COMMANDS: Record<EditorShortcutCommand, EditorCommand> = {
  "editor.commands": "commands",
  "editor.rename": "rename",
  "editor.goToDefinition": "definition",
  "editor.findReferences": "references",
  "editor.goToSymbol": "documentSymbols",
  "editor.problems": "problems",
  "editor.debug.start": "debugLaunch",
  "editor.debug.stop": "debugStop",
  "editor.debug.toggleBreakpoint": "debugBreakpoint",
  "editor.debug.stepOver": "debugNext",
  "editor.debug.stepInto": "debugStepIn",
  "editor.debug.stepOut": "debugStepOut",
};
const COMMAND_SHORTCUTS = Object.fromEntries(
  Object.entries(SHORTCUT_COMMANDS).map(([shortcut, command]) => [command, shortcut]),
) as Partial<Record<EditorCommand, EditorShortcutCommand>>;
const NAVIGATION_COMMANDS: readonly EditorCommand[] = [
  "definition",
  "typeDefinition",
  "references",
  "documentSymbols",
  "workspaceSymbols",
];
const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const diffLabels = (fileName: string) => ({
  originalAriaLabel: `Original ${fileName}`,
  modifiedAriaLabel: `Edit ${fileName}`,
});

export default function MonacoEditorSurface(props: SurfaceProps) {
  const client = useQueryClient();
  const opener = useWorkspaceFileOpener();
  const { settings } = useAppSettings();
  const keybindings = useQuery(serverConfigQueryOptions()).data?.keybindings ?? EMPTY_KEYBINDINGS;
  const cwd = props.workspaceRoot ?? null;
  const diff = props.original !== undefined;
  const debugStore = cwd ? getEditorDebugStore(client, cwd) : null;
  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<Controller | null>(null);
  const [controller, setController] = useState<Controller | null>(null);
  const [serviceNotice, setServiceNotice] = useState<string | null>(null);
  const [problems, setProblems] = useState({ errors: 0, warnings: 0 });
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [rename, setRename] = useState<{ word: string; offset: number; version: number } | null>(
    null,
  );
  const [debugLaunch, setDebugLaunch] = useState<"launch" | "attach" | null>(null);

  function report(error: unknown) {
    const message = error instanceof Error ? error.message : "The editor action failed.";
    const entry = controllerRef.current?.entry;
    // Before the engine mounts there is no entry to carry the status; show it directly.
    if (entry) setEditorServiceStatus(entry, message);
    else setServiceNotice(message);
  }
  function focusEditor() {
    queueMicrotask(() => controllerRef.current?.editor.focus());
  }
  const openFile = useEffectEvent(
    (relativePath: string) => opener?.openFile(relativePath) ?? false,
  );
  const emitChange = useEffectEvent((value: string) => props.onChange(value));
  const emitHistory = useEffectEvent((history: { canUndo: boolean; canRedo: boolean }) =>
    props.onHistoryChange?.(history),
  );
  const isReadOnly = useEffectEvent(() => props.readOnly ?? false);

  function reveal(location: EditorLocation) {
    const active = controllerRef.current;
    if (!active) return;
    const { entry, editor } = active;
    const range = locationRange(location);
    if (location.relativePath === entry.relativePath) {
      editor.setSelection(range);
      editor.revealRangeInCenter(range);
      editor.focus();
      return;
    }
    const uri = editorUri(entry.client, entry.cwd, location.relativePath);
    rememberEditorLocation(uri, range);
    if (!openFile(location.relativePath)) {
      forgetEditorLocation(uri);
      throw new Error("This surface cannot open another workspace file. Open it from Files.");
    }
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
  async function runCommand(id: EditorCommand) {
    const active = controllerRef.current;
    if (!active) return;
    const { editor, entry } = active;
    const position = editor.getPosition() ?? new monaco.Position(1, 1);
    const selection = editor.getSelection() ?? new monaco.Selection(1, 1, 1, 1);
    const offset = entry.model.getOffsetAt(position);
    const start = entry.model.getOffsetAt(selection.getStartPosition());
    const length = entry.model.getOffsetAt(selection.getEndPosition()) - start;
    const readOnly = isReadOnly();
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
        if (!readOnly) await debugStore?.toggleBreakpoint(entry.relativePath, position.lineNumber);
        return;
      case "commands":
        setQuery("");
        setPicker({ title: "Editor commands", mode: "commands", rows: commands() });
        return;
      case "workspaceSymbols":
        setQuery("");
        setPicker({ title: "Find a workspace symbol", mode: "workspaceSymbols", rows: [] });
        return;
      case "rename":
        if (readOnly || !supportsProjectIntelligence(entry)) return;
        setRename({
          word: entry.model.getWordAtPosition(position)?.word ?? "",
          offset,
          version: entry.model.getVersionId(),
        });
        return;
      case "documentSymbols": {
        const result = await requestIntelligence(entry, "documentSymbols");
        if (result)
          results(
            "Go to symbol in file",
            (result.symbols ?? []).map((symbol, index) => ({
              ...locationRows([symbol.location], symbol.name)[0]!,
              id: `symbol:${index}`,
            })),
          );
        return;
      }
      case "definition":
      case "typeDefinition":
      case "references": {
        const result = await requestIntelligence(entry, id as "definition", { offset });
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
        const result = await requestIntelligence(entry, "diagnostics");
        if (!result) return;
        results(
          "Problems in this file",
          (result.diagnostics ?? []).map((item, index) => ({
            id: `problem:${index}`,
            label: item.message,
            detail: `${item.severity} · line ${entry.model.getPositionAt(item.start).lineNumber}`,
            run: () => {
              const range = offsetRange(entry.model, item);
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
        props.onReferenceInChat?.({
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
  const run = useEffectEvent((id: EditorCommand) => {
    void runCommand(id).catch(report);
  });
  const shortcut = (command: EditorCommand) => {
    const binding = COMMAND_SHORTCUTS[command];
    return binding ? (shortcutLabelForCommand(keybindings, binding) ?? undefined) : undefined;
  };
  function commands(): EditorActionRow[] {
    const active = controllerRef.current;
    if (!active) return [];
    const intelligence = supportsProjectIntelligence(active.entry);
    const editable = !isReadOnly();
    const phase = debugStore?.getSnapshot().phase;
    const action = (id: EditorCommand, label: string, detail?: string): EditorActionRow => ({
      id,
      label,
      ...(detail ? { detail } : {}),
      ...(shortcut(id) ? { shortcut: shortcut(id) } : {}),
      run: () => runCommand(id),
    });
    return [
      action("actions.find", "Find in file"),
      ...(editable ? [action("editor.action.startFindReplaceAction", "Replace in file")] : []),
      ...(intelligence
        ? [
            action("editor.action.triggerSuggest", "Show suggestions"),
            action("editor.action.triggerParameterHints", "Show signature help"),
            action("editor.action.showHover", "Show documentation"),
            action("definition", "Go to definition"),
            action("typeDefinition", "Go to type definition"),
            action("references", "Find references"),
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
                  action("rename", "Rename symbol"),
                  action("codeActions", "Quick fixes and refactorings"),
                  action("organizeImports", "Organize imports"),
                ]
              : []),
          ]
        : []),
      ...(debugStore
        ? [
            action("debugLaunch", phase === "paused" ? "Continue debugging" : "Start debugging…"),
            action("debugAttach", "Attach to Node.js…"),
            action("debugBreakpoint", "Toggle breakpoint"),
            ...(phase === "running" || phase === "paused"
              ? [action("debugStop", "Stop debugging")]
              : []),
          ]
        : []),
      action("editor.foldAll", "Fold all"),
      action("editor.unfoldAll", "Unfold all"),
      ...(props.onReferenceInChat
        ? [action("referenceInChat", "Reference selection in chat")]
        : []),
    ];
  }
  const showContextMenu = useEffectEvent((position: { x: number; y: number }) => {
    const api = readNativeApi();
    const active = controllerRef.current;
    if (!api || !active) return;
    const rows = commands();
    const row = (id: EditorCommand) => rows.find((item) => item.id === id);
    const item = (id: EditorCommand): ContextMenuItem<string>[] => {
      const found = row(id);
      return found ? [{ id: found.id, label: found.label }] : [];
    };
    const selection = active.editor.getSelection();
    const referenceLabel =
      selection && !selection.isEmpty()
        ? formatSelectionLabel({
            path: active.entry.relativePath,
            startLine: selection.startLineNumber,
            startColumn: selection.startColumn,
            endLine: selection.endLineNumber,
            endColumn: selection.endColumn,
          })
        : null;
    const items: ContextMenuItem<string>[] = [
      { id: "commands", label: "Editor commands…" },
      ...contextMenuGroup(
        { id: "navigate", label: "Navigate", separatorBefore: true },
        NAVIGATION_COMMANDS.flatMap(item),
      ),
      ...contextMenuGroup(
        { id: "debug", label: "Debug" },
        rows
          .filter((entry) => entry.id.startsWith("debug"))
          .map((entry) => ({ id: entry.id, label: entry.label })),
      ),
      ...contextMenuGroup({ id: "refactor", label: "Refactor", separatorBefore: true }, [
        ...item("rename"),
        ...item("codeActions"),
        ...item("organizeImports"),
        ...item("editor.action.formatDocument"),
      ]),
      ...item("actions.find"),
      ...(row("referenceInChat")
        ? [
            {
              id: "referenceInChat",
              label: referenceLabel
                ? `Reference ${referenceLabel} in chat`
                : "Reference selection in chat",
              separatorBefore: true,
            },
          ]
        : []),
    ];
    void api.contextMenu
      .show(items, position)
      .then((id) => {
        if (id) run(id);
      })
      .catch(report);
  });

  // Mount the engine over the shared model once the file's grammar is loaded.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const initial = { ...props };
    const handle = acquireEditorModel(
      client,
      cwd,
      initial.fileName,
      initial.value,
      initial.valueVersion,
    );
    const { entry } = handle;
    let active: Controller | null = null;
    let cancelled = false;
    const subscriptions: monaco.IDisposable[] = [];
    const onStatus = (message: string | null) => setServiceNotice(message);
    entry.statusListeners.add(onStatus);
    setServiceNotice(entry.status);
    void ensureEditorLanguage(entry.model.getLanguageId())
      .then((highlighter) => {
        if (cancelled) return;
        const appearance = editorAppearance(container, initial.resolvedTheme, highlighter);
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
        const { editor } = active;
        const viewKey = diff ? "diff" : "file";
        const view = entry.viewStates.get(viewKey);
        if (view) editor.restoreViewState(view);
        const pending = takeEditorLocation(entry.model.uri);
        if (pending) {
          editor.setSelection(pending);
          editor.revealRangeInCenter(pending);
          editor.focus();
        }
        entry.listeners.add(emitChange);
        let previousHistory = "";
        const history = () => {
          if (entry.model.isDisposed()) return;
          const value = { canUndo: entry.model.canUndo(), canRedo: entry.model.canRedo() };
          const key = JSON.stringify(value);
          if (key === previousHistory) return;
          previousHistory = key;
          emitHistory(value);
        };
        const controls = {
          undo: () => void Promise.resolve(entry.model.undo()).then(history),
          redo: () => void Promise.resolve(entry.model.redo()).then(history),
          revertTo: (value: string) => {
            replaceEditorText(entry.model, value);
            history();
          },
        };
        if (initial.historyControlsRef) initial.historyControlsRef.current = controls;
        history();
        subscriptions.push(entry.model.onDidChangeContent(() => queueMicrotask(history)));
        // Each diff side clips and scrolls on its own; only a horizontally
        // scrolled gutter takes the dense Synara glass backing.
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
        subscriptions.push(
          editor.onContextMenu((event) => {
            event.event.preventDefault();
            event.event.stopPropagation();
            const position = event.target.position;
            if (position && !editor.getSelection()?.containsPosition(position))
              editor.setPosition(position);
            showContextMenu({ x: event.event.posx, y: event.event.posy });
          }),
          // Ctrl/Cmd-click definitions: same file reveals in place, other
          // workspace files open through Synara's file opener. Claim every
          // workspace URI so the engine never swaps this surface's model.
          monaco.editor.registerEditorOpener({
            openCodeEditor(source, resource, selection) {
              if (source !== editor || resource.scheme !== entry.model.uri.scheme) return false;
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
              if (!openFile(resource.path.slice(1))) forgetEditorLocation(resource);
              return true;
            },
          }),
        );
        controllerRef.current = active;
        setController(active);
        return () => {
          const viewState = editor.saveViewState();
          if (viewState) entry.viewStates.set(viewKey, viewState);
          if (initial.historyControlsRef?.current === controls)
            initial.historyControlsRef.current = null;
        };
      })
      .then((dispose) => {
        if (cancelled) dispose?.();
        else teardown = dispose ?? null;
      })
      .catch(report);
    let teardown: (() => void) | null = null;
    return () => {
      cancelled = true;
      teardown?.();
      subscriptions.forEach((item) => item.dispose());
      entry.listeners.delete(emitChange);
      entry.statusListeners.delete(onStatus);
      active?.instance.dispose();
      active?.original?.dispose();
      handle.release();
      if (controllerRef.current === active) controllerRef.current = null;
      setController(null);
    };
    // The engine is rebuilt only for another document or surface kind.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, cwd, props.fileName, diff]);

  // Controlled standalone callers (no session) still support reload; bound
  // sessions synchronize their model themselves.
  useEffect(() => {
    if (!controller) return;
    const { entry, original, instance } = controller;
    if (!entry.session && entry.sourceVersion !== props.valueVersion) {
      entry.model.setValue(props.value);
      entry.sourceVersion = props.valueVersion;
    }
    if (original && original.getValue() !== props.original) original.setValue(props.original ?? "");
    instance.updateOptions({
      readOnly: props.readOnly ?? false,
      ...(original
        ? { renderSideBySide: props.renderSideBySide ?? true, ...diffLabels(props.fileName) }
        : {}),
    });
  }, [
    controller,
    props.value,
    props.valueVersion,
    props.original,
    props.readOnly,
    props.renderSideBySide,
    props.fileName,
  ]);

  // Theme and typography follow Synara's settings, not an engine theme switch.
  useEffect(() => {
    const container = containerRef.current;
    if (!controller || !container) return;
    void ensureEditorLanguage(controller.entry.model.getLanguageId())
      .then((highlighter) => {
        if (controller.entry.model.isDisposed()) return;
        const options = editorAppearance(container, props.resolvedTheme, highlighter);
        controller.instance.updateOptions({
          ...options,
          // The diff editor resets its sub-editor labels on every update.
          ...(controller.original ? diffLabels(props.fileName) : {}),
        });
        monaco.editor.setTheme(options.theme!);
      })
      .catch(report);
  }, [controller, props.resolvedTheme, props.fileName, settings.chatFontSizePx]);

  // Breakpoint and paused-line markers for this document.
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
              glyphMarginHoverMessage: { value: "Breakpoint", isTrusted: false },
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
        isReadOnly()
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

  // Diagnostics: engine markers for squiggles plus the counts in the strip below.
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
            setProblems({
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
      setProblems({ errors: 0, warnings: 0 });
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

  const handleShortcut = (event: KeyboardEvent<HTMLDivElement>) => {
    const command = resolveEditorShortcutCommand(event, keybindings);
    if (!command) return;
    event.preventDefault();
    event.stopPropagation();
    run(SHORTCUT_COMMANDS[command]);
  };
  const rows =
    picker?.rows.filter(
      (row) =>
        picker.mode === "workspaceSymbols" ||
        `${row.label} ${row.detail ?? ""}`.toLowerCase().includes(query.toLowerCase()),
    ) ?? [];
  const problemCount = problems.errors + problems.warnings;
  return (
    <div
      className="synara-code-editor relative flex min-h-0 min-w-0 flex-1 flex-col"
      onKeyDownCapture={handleShortcut}
    >
      {serviceNotice ? (
        <WorkspaceFileEditorNoticeBar
          message={serviceNotice}
          role="status"
          actions={
            <Button
              size="xs"
              variant="chrome-outline"
              className="!h-6 shrink-0 rounded-md text-ui-sm"
              onClick={() => setServiceNotice(null)}
            >
              Dismiss
            </Button>
          }
        />
      ) : null}
      <div
        ref={containerRef}
        className="min-h-0 min-w-0 flex-1"
        data-testid="synara-editor-surface"
      />
      {problemCount > 0 ? (
        <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border/65 px-3 text-ui-sm text-muted-foreground">
          {problems.errors > 0 ? (
            <span className="flex items-center gap-1.5">
              <StatusDot className="bg-destructive" />
              {problems.errors} {problems.errors === 1 ? "error" : "errors"}
            </span>
          ) : null}
          {problems.warnings > 0 ? (
            <span className="flex items-center gap-1.5">
              <StatusDot className="bg-[var(--color-warning)]" />
              {problems.warnings} {problems.warnings === 1 ? "warning" : "warnings"}
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto !h-5 px-1.5 text-ui-sm"
            onClick={() => run("problems")}
          >
            Show problems
          </Button>
        </div>
      ) : null}
      {debugStore ? (
        <>
          <EditorDebugPanel
            store={debugStore}
            shortcut={(command) => shortcut(command)}
            onReveal={(frame) => {
              if (!frame.relativePath) return;
              try {
                reveal({
                  relativePath: frame.relativePath,
                  line: Math.max(0, frame.line - 1),
                  character: Math.max(0, frame.column - 1),
                  endLine: Math.max(0, frame.line - 1),
                  endCharacter: Math.max(0, frame.column),
                  start: 0,
                  length: 0,
                });
              } catch (error) {
                debugStore.report(error);
              }
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
      <RenameDialog
        open={rename !== null}
        title="Rename symbol"
        description="Updates every reference through the workspace's language service."
        initialValue={rename?.word ?? ""}
        saveLabel="Rename"
        onOpenChange={(open) => {
          if (open) return;
          setRename(null);
          focusEditor();
        }}
        onSave={async (newName) => {
          const active = controllerRef.current;
          if (!rename || !active) return;
          try {
            if (active.entry.model.getVersionId() !== rename.version)
              throw new Error("The document changed. Run Rename again.");
            const result = await requestIntelligence(active.entry, "rename", {
              offset: rename.offset,
              newName,
            });
            if (!result?.edits) throw new Error("The document changed. Run Rename again.");
            await applyEditorEdits(active.entry, result.edits);
          } catch (error) {
            toastManager.add({
              type: "error",
              title: "Rename failed",
              description: error instanceof Error ? error.message : "The rename did not apply.",
            });
            throw error;
          }
        }}
      />
    </div>
  );
}

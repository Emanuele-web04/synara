// FILE: EditorDebugPanel.tsx
// Purpose: The debugger's launch dialog and the contextual debug section under
//          the editor (controls, call stack, variables, watches, console).
// Layer: Web editor UI
// Exports: EditorDebugLaunchDialog, EditorDebugPanel
// Depends on: editorDebugStore and the shared dialog, row, disclosure and
//             header-control primitives.

import { useEffect, useId, useState } from "react";
import type { EditorDebugActionResult, EditorDebugFrame } from "@synara/contracts";

import {
  ArrowDownIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  PauseIcon,
  PlayIcon,
  StopIcon,
  XIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { SegmentedPicker } from "../SegmentedPicker";
import { ChatHeaderIconButton } from "../chat/chatHeaderControls";
import { EXPLORER_ROW_PROPS, useExplorerListNavigation } from "../chat/explorerListNavigation";
import { fileRowClassName, fileRowIndentStyle } from "../chat/fileRowStyles";
import { PanelStateMessage } from "../chat/PanelStateMessage";
import { WorkspaceFileEditorNoticeBar } from "../chat/WorkspaceFileEditorChrome";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { EditorDebugStore, useEditorDebug } from "./editorDebugStore";

type Variable = NonNullable<EditorDebugActionResult["variables"]>[number];
type DebugView = "stack" | "variables" | "watch" | "console";
const DEBUG_VIEWS: ReadonlyArray<{ value: DebugView; label: string }> = [
  { value: "stack", label: "Call stack" },
  { value: "variables", label: "Variables" },
  { value: "watch", label: "Watch" },
  { value: "console", label: "Console" },
];
const CONSOLE_CLASS_NAME =
  "whitespace-pre-wrap break-words px-1 font-chat-code text-chat-code leading-relaxed text-foreground/88";

/** A scope, variable or watch value: an explorer-style row that lazily expands its children. */
function VariableRow({
  store,
  variable,
  depth = 0,
  trailing,
}: {
  store: EditorDebugStore;
  variable: Variable;
  depth?: number;
  trailing?: React.ReactNode;
}) {
  const [children, setChildren] = useState<readonly Variable[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const expandable = variable.variablesReference > 0 && depth < 8;
  const toggle = () => {
    if (!expandable) return;
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (children) return;
    setBusy(true);
    void store
      .command({ action: "variables", variablesReference: variable.variablesReference })
      .then((result) => setChildren(result.variables ?? []))
      .catch(store.report)
      .finally(() => setBusy(false));
  };
  return (
    <li>
      <div className="flex items-center gap-0.5">
        <button
          {...EXPLORER_ROW_PROPS}
          type="button"
          className={fileRowClassName(false, "h-7 pr-2")}
          style={fileRowIndentStyle(depth)}
          aria-expanded={expandable ? open : undefined}
          disabled={busy}
          onClick={toggle}
        >
          {expandable ? (
            <DisclosureChevron open={open} className="size-3.5 shrink-0 opacity-75" />
          ) : (
            <span aria-hidden="true" className="size-3.5 shrink-0" />
          )}
          <span className="min-w-0 truncate">
            <span className="text-foreground">{variable.name}</span>
            {variable.value ? (
              <span className="font-chat-code text-muted-foreground">: {variable.value}</span>
            ) : null}
          </span>
        </button>
        {trailing}
      </div>
      {open ? (
        <ul>
          {busy ? (
            <li
              role="status"
              className="text-ui-sm text-muted-foreground"
              style={fileRowIndentStyle(depth + 1)}
            >
              Loading…
            </li>
          ) : (
            children?.map((child, index) => (
              <VariableRow
                key={`${child.name}:${index}`}
                store={store}
                variable={child}
                depth={depth + 1}
              />
            ))
          )}
        </ul>
      ) : null}
    </li>
  );
}

export function EditorDebugLaunchDialog({
  store,
  open,
  request,
  program: initialProgram,
  onClose,
}: {
  store: EditorDebugStore;
  open: boolean;
  request: "launch" | "attach";
  program: string;
  onClose: () => void;
}) {
  const state = useEditorDebug(store);
  const formId = useId();
  const [mode, setMode] = useState(request);
  const [program, setProgram] = useState(initialProgram);
  const [args, setArgs] = useState("");
  const [port, setPort] = useState("9229");
  const [stopOnEntry, setStopOnEntry] = useState(false);
  useEffect(() => {
    if (!open) return;
    setMode(request);
    setProgram(initialProgram);
    store.clearError();
  }, [open, request, initialProgram, store]);
  const starting = state.phase === "starting";
  const close = () => {
    store.cancelStart();
    onClose();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === "launch" ? "Debug a Node.js program" : "Attach to Node.js"}
          </DialogTitle>
          <DialogDescription>
            {mode === "launch"
              ? "Runs the selected file on the server machine after saving the workspace. Only start code you trust."
              : "Connects to a Node inspector on the server's loopback interface. Stopping leaves the process running."}{" "}
            The first use downloads Microsoft's checksum-verified JavaScript debugger.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              const inspectorPort = Number(port);
              if (
                mode === "attach" &&
                (!Number.isInteger(inspectorPort) || inspectorPort < 1 || inspectorPort > 65_535)
              ) {
                store.report(new Error("Enter an inspector port from 1 to 65535."));
                return;
              }
              void store
                .start({
                  request: mode,
                  program: program.trim() || initialProgram,
                  args: args ? args.split("\n") : [],
                  port: inspectorPort,
                  stopOnEntry,
                })
                .then(onClose)
                .catch(() => undefined);
            }}
          >
            <SegmentedPicker
              value={mode}
              options={[
                { value: "launch", label: "Launch" },
                { value: "attach", label: "Attach" },
              ]}
              onValueChange={setMode}
              ariaLabel="Debug connection"
              disabled={starting}
            />
            {mode === "launch" ? (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor={`${formId}-program`}>Workspace entry point</Label>
                  <Input
                    id={`${formId}-program`}
                    value={program}
                    disabled={starting}
                    onChange={(event) => setProgram(event.currentTarget.value)}
                    autoFocus
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${formId}-args`}>Arguments, one per line</Label>
                  <Textarea
                    id={`${formId}-args`}
                    value={args}
                    disabled={starting}
                    onChange={(event) => setArgs(event.currentTarget.value)}
                    rows={3}
                  />
                </div>
                <Label className="font-normal">
                  <Checkbox
                    checked={stopOnEntry}
                    disabled={starting}
                    onCheckedChange={(checked) => setStopOnEntry(checked === true)}
                  />
                  Pause at the first line
                </Label>
              </>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor={`${formId}-port`}>Inspector port</Label>
                <Input
                  id={`${formId}-port`}
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  disabled={starting}
                  onChange={(event) => setPort(event.currentTarget.value)}
                  autoFocus
                />
              </div>
            )}
            {state.error ? (
              <p role="alert" className="text-ui leading-snug text-destructive">
                {state.error}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={close}>
            Cancel
          </Button>
          <Button
            form={formId}
            type="submit"
            size="sm"
            disabled={starting || (mode === "launch" && !program.trim())}
          >
            {starting ? "Starting debugger…" : mode === "launch" ? "Save and debug" : "Attach"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function TargetChips<T extends string | number>(props: {
  label: string;
  items: ReadonlyArray<{ id: T; name: string }>;
  selected: T | null;
  onSelect: (id: T) => void;
}) {
  if (props.items.length < 2) return null;
  return (
    <div className="mb-1.5 flex flex-wrap gap-1 px-1" aria-label={props.label}>
      {props.items.map((item) => (
        <Button
          key={String(item.id)}
          size="chip"
          variant={props.selected === item.id ? "secondary" : "ghost"}
          onClick={() => props.onSelect(item.id)}
        >
          {item.name}
        </Button>
      ))}
    </div>
  );
}

export function EditorDebugPanel({
  store,
  shortcut,
  onReveal,
}: {
  store: EditorDebugStore;
  /** The configured chord for a surface command (`debugNext`, …), for tooltips. */
  shortcut: (command: string) => string | undefined;
  onReveal: (frame: EditorDebugFrame) => void;
}) {
  const state = useEditorDebug(store);
  const [view, setView] = useState<DebugView>("stack");
  const [expression, setExpression] = useState("");
  const [evaluating, setEvaluating] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const handleListKeyDown = useExplorerListNavigation();
  const paused = state.phase === "paused";
  const ended = state.phase === "ended";
  useEffect(() => {
    if (ended) setView("console");
  }, [ended]);
  if (state.phase === "idle" || state.phase === "starting") return null;
  const title = ended ? "Debug session ended" : paused ? "Paused" : "Debugging";
  const withShortcut = (label: string, command: string) => {
    const chord = shortcut(command);
    return chord ? `${label} (${chord})` : label;
  };
  const tools = [
    {
      label: paused ? withShortcut("Continue", "debugLaunch") : "Pause",
      action: paused ? ("continue" as const) : ("pause" as const),
      Icon: paused ? PlayIcon : PauseIcon,
      disabled: ended,
    },
    {
      label: withShortcut("Step over", "debugNext"),
      action: "next" as const,
      Icon: ArrowRightIcon,
      disabled: !paused,
    },
    {
      label: withShortcut("Step into", "debugStepIn"),
      action: "stepIn" as const,
      Icon: ArrowDownIcon,
      disabled: !paused,
    },
    {
      label: withShortcut("Step out", "debugStepOut"),
      action: "stepOut" as const,
      Icon: ArrowUpIcon,
      disabled: !paused,
    },
  ];
  const targets = state.connections.filter((item) => item.ready && item.id !== "root");
  const frameKey = `${state.connectionId}:${state.pauseVersion}:${state.frameId}`;
  return (
    <section
      aria-label="Debug session"
      className="flex max-h-80 min-h-0 shrink-0 flex-col border-t border-border/65"
    >
      <div className="flex h-10 shrink-0 items-center gap-1 px-2">
        <button
          type="button"
          className={cn(
            "flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-ui font-medium text-foreground/86 transition-colors",
            "hover:bg-[var(--color-background-button-secondary-hover)]",
          )}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          <DisclosureChevron open={!collapsed} className="size-3.5 opacity-75" />
          <span className="truncate">{title}</span>
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {tools.map(({ label, action, Icon, disabled }) => (
            <ChatHeaderIconButton
              key={action}
              type="button"
              tone="plain"
              label={label}
              title={label}
              disabled={disabled || state.busy}
              onClick={() => void store.control(action)}
            >
              <Icon aria-hidden="true" className="size-3.5" />
            </ChatHeaderIconButton>
          ))}
          {!ended ? (
            <ChatHeaderIconButton
              type="button"
              tone="plain"
              label={withShortcut("Stop debugging", "debugStop")}
              title={withShortcut("Stop debugging", "debugStop")}
              disabled={state.busy}
              onClick={() => void store.stop()}
            >
              <StopIcon aria-hidden="true" className="size-3.5" />
            </ChatHeaderIconButton>
          ) : (
            <ChatHeaderIconButton
              type="button"
              tone="plain"
              label="Close debug results"
              title="Close debug results"
              onClick={() => store.dismiss()}
            >
              <XIcon aria-hidden="true" className="size-3.5" />
            </ChatHeaderIconButton>
          )}
        </div>
      </div>
      {state.error ? (
        <WorkspaceFileEditorNoticeBar
          message={state.error}
          actions={
            <ChatHeaderIconButton
              type="button"
              tone="plain"
              label="Dismiss debugger error"
              title="Dismiss debugger error"
              onClick={store.clearError}
            >
              <XIcon aria-hidden="true" className="size-3.5" />
            </ChatHeaderIconButton>
          }
        />
      ) : null}
      <DisclosureRegion
        open={!collapsed}
        className="min-h-0"
        contentClassName="flex min-h-0 flex-col"
      >
        <div className="shrink-0 px-3 pb-2">
          <SegmentedPicker
            value={view}
            onValueChange={setView}
            ariaLabel="Debug details"
            options={DEBUG_VIEWS}
          />
        </div>
        <div
          className="min-h-20 min-w-0 flex-1 overflow-auto px-2 pb-2"
          onKeyDown={handleListKeyDown}
        >
          {view === "stack" ? (
            <>
              <TargetChips
                label="Debug targets"
                items={targets}
                selected={state.connectionId}
                onSelect={(id) => void store.selectTarget(id).catch(store.report)}
              />
              <TargetChips
                label="Threads"
                items={state.threads}
                selected={state.threadId}
                onSelect={(id) => void store.selectThread(id).catch(store.report)}
              />
              {paused ? (
                <ul>
                  {state.frames.map((frame) => (
                    <li key={frame.id}>
                      <button
                        {...EXPLORER_ROW_PROPS}
                        type="button"
                        className={fileRowClassName(frame.id === state.frameId, "h-7 px-2")}
                        onClick={() => {
                          void store.selectFrame(frame.id).catch(store.report);
                          if (frame.relativePath) onReveal(frame);
                        }}
                      >
                        <span className="min-w-0 flex-1 truncate">{frame.name}</span>
                        <span className="shrink-0 truncate text-ui-xs text-muted-foreground/70">
                          {frame.relativePath ?? frame.sourceName}:{frame.line}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <PanelStateMessage density="compact" fill="flex">
                  <p>
                    {ended
                      ? "The session has ended."
                      : "Pause execution to inspect the call stack."}
                  </p>
                </PanelStateMessage>
              )}
            </>
          ) : null}
          {view === "variables" ? (
            paused ? (
              <ul key={frameKey}>
                {state.scopes.map((scope) => (
                  <VariableRow
                    key={scope.variablesReference}
                    store={store}
                    variable={{
                      name: scope.name,
                      value: scope.expensive ? "Expand to evaluate" : "",
                      variablesReference: scope.variablesReference,
                    }}
                  />
                ))}
              </ul>
            ) : (
              <PanelStateMessage density="compact" fill="flex">
                <p>Pause execution to inspect variables.</p>
              </PanelStateMessage>
            )
          ) : null}
          {view === "watch" ? (
            state.watches.length ? (
              <ul key={frameKey}>
                {state.watches.map((watch) => (
                  <VariableRow
                    key={watch.expression}
                    store={store}
                    variable={{
                      name: watch.expression,
                      value: watch.value,
                      variablesReference: paused ? watch.variablesReference : 0,
                    }}
                    trailing={
                      <ChatHeaderIconButton
                        type="button"
                        tone="plain"
                        label={`Remove watch ${watch.expression}`}
                        title="Remove watch"
                        onClick={() => store.removeWatch(watch.expression)}
                      >
                        <XIcon aria-hidden="true" className="size-3.5" />
                      </ChatHeaderIconButton>
                    }
                  />
                ))}
              </ul>
            ) : (
              <PanelStateMessage density="compact" fill="flex">
                <p>Watch expressions run in the selected frame each time execution pauses.</p>
              </PanelStateMessage>
            )
          ) : null}
          {view === "console" ? (
            state.output.length ? (
              <pre className={CONSOLE_CLASS_NAME} aria-label="Debug console output">
                {state.output.join("")}
              </pre>
            ) : (
              <PanelStateMessage density="compact" fill="flex">
                <p>Program output appears here.</p>
              </PanelStateMessage>
            )
          ) : null}
        </div>
        {view === "watch" || (view === "console" && !ended) ? (
          <form
            className="flex shrink-0 gap-2 border-t border-border/65 px-3 py-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!expression.trim() || evaluating) return;
              setEvaluating(true);
              void (
                view === "watch" ? store.addWatch(expression.trim()) : store.console(expression)
              )
                .then(() => setExpression(""))
                .catch(store.report)
                .finally(() => setEvaluating(false));
            }}
          >
            <Input
              aria-label={view === "watch" ? "Watch expression" : "Debug console expression"}
              placeholder={view === "watch" ? "Watch expression" : "Evaluate an expression"}
              value={expression}
              onChange={(event) => setExpression(event.currentTarget.value)}
              disabled={evaluating}
            />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={evaluating || !expression.trim()}
            >
              {view === "watch" ? "Add" : "Evaluate"}
            </Button>
          </form>
        ) : null}
      </DisclosureRegion>
    </section>
  );
}

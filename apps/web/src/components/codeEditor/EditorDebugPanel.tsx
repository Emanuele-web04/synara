import { useEffect, useId, useState } from "react";
import type { EditorDebugActionResult, EditorDebugFrame } from "@synara/contracts";
import {
  PlayIcon,
  PauseIcon,
  StopIcon,
  ArrowRightIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  XIcon,
  ChevronRightIcon,
  ChevronDownIcon,
} from "~/lib/icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Dialog, DialogPopup, DialogTitle, DialogDescription, DialogFooter } from "../ui/dialog";
import { SegmentedPicker } from "../SegmentedPicker";
import { EditorDebugStore, useEditorDebug } from "./editorDebugStore";

type Variable = NonNullable<EditorDebugActionResult["variables"]>[number];
function VariableRow({
  store,
  variable,
  depth = 0,
}: {
  store: EditorDebugStore;
  variable: Variable;
  depth?: number;
}) {
  const [children, setChildren] = useState<readonly Variable[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const expandable = variable.variablesReference > 0 && depth < 8;
  return (
    <li>
      <div className="flex min-w-0 items-start gap-1 py-0.5 text-ui-sm">
        {expandable ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`${open ? "Collapse" : "Expand"} ${variable.name}`}
            aria-expanded={open}
            disabled={busy}
            onClick={() => {
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
            }}
          >
            {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </Button>
        ) : (
          <span className="w-6 shrink-0" />
        )}
        <span className="min-w-0 break-words">
          <span className="text-foreground">{variable.name}</span>
          <span className="text-muted-foreground">: {variable.value}</span>
        </span>
      </div>
      {open ? (
        <ul className="ml-4 border-l border-border pl-1">
          {busy ? (
            <li role="status" className="text-ui-sm text-muted-foreground">
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
  const id = useId();
  const [mode, setMode] = useState(request);
  const [program, setProgram] = useState(initialProgram);
  const [args, setArgs] = useState("");
  const [port, setPort] = useState("9229");
  const [stopOnEntry, setStopOnEntry] = useState(false);
  useEffect(() => {
    if (open) {
      setMode(request);
      setProgram(initialProgram);
      store.clearError();
    }
  }, [open, request, initialProgram, store]);
  const starting = state.phase === "starting";
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) {
          store.cancelStart();
          onClose();
        }
      }}
    >
      <DialogPopup>
        <form
          className="space-y-4 p-5"
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
          <DialogTitle>
            {mode === "launch" ? "Debug a Node.js program" : "Attach to Node.js"}
          </DialogTitle>
          <DialogDescription>
            {mode === "launch"
              ? "This runs the selected file on the server machine after saving the workspace. Only start code you trust."
              : "Connect to a Node inspector on the server’s loopback interface. Stopping the debugger leaves the attached process running."}{" "}
            The first use downloads Microsoft’s checksum-verified JavaScript debugger.
          </DialogDescription>
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
              <div className="space-y-1">
                <label htmlFor={`${id}-program`} className="text-ui-sm">
                  Workspace entry point
                </label>
                <Input
                  id={`${id}-program`}
                  value={program}
                  disabled={starting}
                  onChange={(event) => setProgram(event.currentTarget.value)}
                  autoFocus
                />
              </div>
              <div className="space-y-1">
                <label htmlFor={`${id}-args`} className="text-ui-sm">
                  Arguments, one per line
                </label>
                <Textarea
                  id={`${id}-args`}
                  value={args}
                  disabled={starting}
                  onChange={(event) => setArgs(event.currentTarget.value)}
                  rows={3}
                />
              </div>
              <label className="flex items-center gap-2 text-ui-sm">
                <input
                  type="checkbox"
                  checked={stopOnEntry}
                  disabled={starting}
                  onChange={(event) => setStopOnEntry(event.currentTarget.checked)}
                />
                Pause at the first line
              </label>
            </>
          ) : (
            <div className="space-y-1">
              <label htmlFor={`${id}-port`} className="text-ui-sm">
                Inspector port
              </label>
              <Input
                id={`${id}-port`}
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
            <p role="alert" className="text-ui-sm text-destructive">
              {state.error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                store.cancelStart();
                onClose();
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={starting || (mode === "launch" && !program.trim())}>
              {starting ? "Starting debugger…" : mode === "launch" ? "Save and debug" : "Attach"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

export function EditorDebugPanel({
  store,
  onReveal,
}: {
  store: EditorDebugStore;
  onReveal: (frame: EditorDebugFrame) => void;
}) {
  const state = useEditorDebug(store);
  const [view, setView] = useState<"stack" | "variables" | "watch" | "console">("stack");
  const [expression, setExpression] = useState("");
  const [evaluating, setEvaluating] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const paused = state.phase === "paused",
    ended = state.phase === "ended";
  useEffect(() => {
    if (ended) setView("console");
  }, [ended]);
  if (state.phase === "idle" || state.phase === "starting") return null;
  const tools = [
    {
      label: paused ? "Continue (F5)" : "Pause",
      action: paused ? ("continue" as const) : ("pause" as const),
      Icon: paused ? PlayIcon : PauseIcon,
      disabled: ended,
    },
    { label: "Step over (F10)", action: "next" as const, Icon: ArrowRightIcon, disabled: !paused },
    { label: "Step into (F11)", action: "stepIn" as const, Icon: ArrowDownIcon, disabled: !paused },
    {
      label: "Step out (Shift+F11)",
      action: "stepOut" as const,
      Icon: ArrowUpIcon,
      disabled: !paused,
    },
  ];
  return (
    <section
      aria-label="Debug session"
      className="flex max-h-80 min-h-0 shrink-0 flex-col border-t border-border bg-background"
    >
      <div className="flex flex-wrap items-center gap-1 px-2 py-1">
        <Button
          variant="ghost"
          size="xs"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}{" "}
          {ended ? "Debug session ended" : paused ? "Paused" : "Debugging"}
        </Button>
        <div className="flex-1" />
        {tools.map(({ label, action, Icon, disabled }) => (
          <Button
            key={action}
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            title={label}
            disabled={disabled || state.busy}
            onClick={() => void store.control(action)}
          >
            <Icon />
          </Button>
        ))}
        {!ended ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Stop debugging (Shift+F5)"
            title="Stop debugging (Shift+F5)"
            disabled={state.busy}
            onClick={() => void store.stop()}
          >
            <StopIcon />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Close debug results"
            onClick={() => store.dismiss()}
          >
            <XIcon />
          </Button>
        )}
      </div>
      {state.error ? (
        <div role="alert" className="flex gap-2 px-3 pb-2 text-ui-sm text-destructive">
          <span className="min-w-0 flex-1 break-words">{state.error}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss debugger error"
            onClick={store.clearError}
          >
            <XIcon />
          </Button>
        </div>
      ) : null}
      {!collapsed ? (
        <>
          <div className="px-3 pb-2">
            <SegmentedPicker
              value={view}
              onValueChange={setView}
              ariaLabel="Debug details"
              options={[
                { value: "stack", label: "Call stack" },
                { value: "variables", label: "Variables" },
                { value: "watch", label: "Watch" },
                { value: "console", label: "Console" },
              ]}
            />
          </div>
          <div className="min-h-20 min-w-0 flex-1 overflow-auto px-3 pb-3 text-ui-sm">
            {view === "stack" ? (
              <>
                {state.connections.filter((item) => item.ready && item.id !== "root").length > 1 ? (
                  <div className="mb-2 flex flex-wrap gap-1" aria-label="Debug targets">
                    {state.connections
                      .filter((item) => item.ready && item.id !== "root")
                      .map((target) => (
                        <Button
                          key={target.id}
                          size="xs"
                          variant={state.connectionId === target.id ? "secondary" : "ghost"}
                          onClick={() => void store.selectTarget(target.id).catch(store.report)}
                        >
                          {target.name}
                        </Button>
                      ))}
                  </div>
                ) : null}
                {state.threads.length > 1 ? (
                  <div className="mb-2 flex flex-wrap gap-1" aria-label="Threads">
                    {state.threads.map((thread) => (
                      <Button
                        key={thread.id}
                        size="xs"
                        variant={state.threadId === thread.id ? "secondary" : "ghost"}
                        onClick={() => void store.selectThread(thread.id).catch(store.report)}
                      >
                        {thread.name}
                      </Button>
                    ))}
                  </div>
                ) : null}
                {paused ? (
                  <ul>
                    {state.frames.map((frame) => (
                      <li key={frame.id}>
                        <Button
                          variant={frame.id === state.frameId ? "secondary" : "ghost"}
                          size="sm"
                          className="w-full justify-start overflow-hidden"
                          onClick={() => {
                            void store.selectFrame(frame.id).catch(store.report);
                            if (frame.relativePath) onReveal(frame);
                          }}
                        >
                          <span className="truncate">{frame.name}</span>
                          <span className="ml-auto truncate text-ui-xs text-muted-foreground">
                            {frame.relativePath ?? frame.sourceName}:{frame.line}
                          </span>
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground">
                    {ended
                      ? "The session has ended."
                      : "Pause execution to inspect the call stack."}
                  </p>
                )}
              </>
            ) : null}
            {view === "variables" ? (
              paused ? (
                <ul key={`${state.connectionId}:${state.pauseVersion}:${state.frameId}`}>
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
                <p className="text-muted-foreground">Pause execution to inspect variables.</p>
              )
            ) : null}
            {view === "watch" ? (
              <>
                <p className="mb-2 text-ui-xs text-muted-foreground">
                  Watch expressions execute in the selected stack frame each time execution pauses.
                </p>
                <ul key={`${state.connectionId}:${state.pauseVersion}:${state.frameId}`}>
                  {state.watches.map((watch) => (
                    <li key={watch.expression} className="flex items-start gap-1">
                      <ul className="min-w-0 flex-1">
                        <VariableRow
                          store={store}
                          variable={{
                            name: watch.expression,
                            value: watch.value,
                            variablesReference: paused ? watch.variablesReference : 0,
                          }}
                        />
                      </ul>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Remove watch ${watch.expression}`}
                        onClick={() => store.removeWatch(watch.expression)}
                      >
                        <XIcon />
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {view === "console" ? (
              <pre
                className="whitespace-pre-wrap break-words font-mono text-ui-sm"
                aria-label="Debug console output"
              >
                {state.output.join("") || "Program output appears here."}
              </pre>
            ) : null}
          </div>
          {view === "watch" || (view === "console" && !ended) ? (
            <form
              className="flex gap-2 border-t border-border px-3 py-2"
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
              <Button type="submit" size="sm" disabled={evaluating || !expression.trim()}>
                {view === "watch" ? "Add" : "Evaluate"}
              </Button>
            </form>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

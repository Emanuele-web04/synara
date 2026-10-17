import { useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type {
  EditorDebugActionInput,
  EditorDebugActionResult,
  EditorDebugBreakpoint,
  EditorDebugFrame,
  EditorDebugSnapshot,
  EditorDebugStartInput,
} from "@synara/contracts";
import { ensureNativeApi } from "~/nativeApi";
import { flushWorkspaceEditors } from "~/lib/workspaceEditorSession";

type Watch = { expression: string; value: string; variablesReference: number };
export type EditorDebugState = {
  phase: "idle" | "starting" | "running" | "paused" | "ended";
  sessionId: string | null;
  connectionId: string | null;
  threadId: number | null;
  frameId: number | null;
  connections: EditorDebugSnapshot["connections"];
  threads: NonNullable<EditorDebugActionResult["threads"]>;
  frames: readonly EditorDebugFrame[];
  scopes: NonNullable<EditorDebugActionResult["scopes"]>;
  watches: readonly Watch[];
  output: readonly string[];
  breakpoints: readonly EditorDebugBreakpoint[];
  error: string | null;
  busy: boolean;
  pauseVersion: number;
};
const initial = (): EditorDebugState => ({
  phase: "idle",
  sessionId: null,
  connectionId: null,
  threadId: null,
  frameId: null,
  connections: [],
  threads: [],
  frames: [],
  scopes: [],
  watches: [],
  output: [],
  breakpoints: [],
  error: null,
  busy: false,
  pauseVersion: 0,
});
const registries = new WeakMap<QueryClient, Map<string, EditorDebugStore>>();

/** Workspace-owned debug state survives changing editor/diff surfaces without starting another process. */
export class EditorDebugStore {
  private state = initial();
  private listeners = new Set<() => void>();
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private launchController: AbortController | undefined;
  private frameGeneration = 0;
  private sequence = 0;
  private pollFailures = 0;
  constructor(
    readonly client: QueryClient,
    readonly cwd: string,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(patch: Partial<EditorDebugState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  report = (error: unknown) =>
    this.update({ error: error instanceof Error ? error.message : "Debugger operation failed." });
  clearError = () => this.update({ error: null });
  private api() {
    const api = ensureNativeApi().editor;
    if (!api?.debugStart || !api.debugAction || !api.debugPoll)
      throw new Error(
        "This server does not support debugging. Update the server to use this feature.",
      );
    return { start: api.debugStart, action: api.debugAction, poll: api.debugPoll };
  }
  async start(input: Omit<EditorDebugStartInput, "cwd" | "breakpoints">) {
    if (!["idle", "ended"].includes(this.state.phase))
      throw new Error("A debug session is already running.");
    const api = this.api();
    this.launchController = new AbortController();
    const signal = this.launchController.signal;
    this.update({
      phase: "starting",
      sessionId: null,
      error: null,
      output: [],
      frames: [],
      scopes: [],
      frameId: null,
      threadId: null,
    });
    const generation = ++this.generation;
    try {
      if (!(await flushWorkspaceEditors(this.client, this.cwd)))
        throw new Error("Resolve unsaved-file errors or conflicts before debugging.");
      signal.throwIfAborted();
      const { sessionId } = await api.start(
        { ...input, cwd: this.cwd, breakpoints: [...this.state.breakpoints] },
        { signal },
      );
      if (generation !== this.generation) {
        await api.action({ sessionId, action: "disconnect" });
        return;
      }
      this.sequence = 0;
      this.pollFailures = 0;
      this.update({ sessionId, phase: "running", connectionId: null, connections: [] });
      void this.poll(generation);
    } catch (error) {
      if (generation !== this.generation || signal.aborted) return;
      this.update({ phase: "ended" });
      this.report(error);
      throw error;
    } finally {
      if (generation === this.generation) this.launchController = undefined;
    }
  }
  cancelStart() {
    if (this.state.phase !== "starting") return;
    ++this.generation;
    this.launchController?.abort();
    this.launchController = undefined;
    this.update({ phase: "ended", error: null });
  }
  private async poll(generation: number) {
    const sessionId = this.state.sessionId;
    if (generation !== this.generation || !sessionId) return;
    try {
      const snapshot = await this.api().poll({ sessionId, after: this.sequence });
      if (generation !== this.generation) return;
      this.sequence = snapshot.sequence;
      this.pollFailures = 0;
      const output = [...this.state.output];
      let stopped: { connectionId: string; threadId?: number } | undefined;
      const patch: Partial<EditorDebugState> = { connections: snapshot.connections };
      for (const event of snapshot.events) {
        if (event.event === "output" || event.event === "exited")
          output.push(
            event.event === "exited"
              ? `Program exited (${event.exitCode ?? "unknown"}).\n`
              : event.text,
          );
        if (event.event === "error") patch.error = event.text;
        if (event.event === "stopped") {
          stopped = {
            connectionId: event.connectionId,
            ...(event.threadId === undefined ? {} : { threadId: event.threadId }),
          };
          patch.phase = "paused";
          patch.connectionId = event.connectionId;
          patch.pauseVersion = this.state.pauseVersion + 1;
        }
        if (
          event.event === "continued" &&
          event.connectionId === (stopped?.connectionId ?? this.state.connectionId)
        ) {
          stopped = undefined;
          this.frameGeneration++;
          patch.phase = "running";
          patch.frames = [];
          patch.scopes = [];
          patch.frameId = null;
        }
      }
      if (!this.state.connectionId)
        patch.connectionId =
          snapshot.connections.find((item) => item.ready && item.id !== "root")?.id ?? null;
      while (output.length > 500 || output.reduce((sum, text) => sum + text.length, 0) > 256_000)
        output.shift();
      patch.output = output;
      if (snapshot.terminated) {
        patch.phase = "ended";
        patch.frames = [];
        patch.scopes = [];
        patch.frameId = null;
        this.frameGeneration++;
      }
      this.update(patch);
      if (stopped && !snapshot.terminated)
        await this.selectTarget(stopped.connectionId, stopped.threadId);
      if (snapshot.terminated) return;
    } catch (error) {
      if (generation !== this.generation) return;
      this.report(error);
      if (++this.pollFailures >= 4) {
        this.update({
          phase: "ended",
          error:
            "Lost the debug connection. The server will stop its adapter after the two-minute lease expires; launch-owned processes are stopped, attached processes are left running.",
        });
        return;
      }
    }
    if (generation === this.generation)
      this.pollTimer = setTimeout(
        () => void this.poll(generation),
        this.pollFailures ? 1_000 : 300,
      );
  }
  async command(
    input: Omit<EditorDebugActionInput, "sessionId">,
  ): Promise<EditorDebugActionResult> {
    if (!this.state.sessionId) throw new Error("Start a debug session first.");
    return this.api().action({
      ...input,
      sessionId: this.state.sessionId,
      ...(input.connectionId || !this.state.connectionId
        ? {}
        : { connectionId: this.state.connectionId }),
    });
  }
  async control(action: "continue" | "pause" | "next" | "stepIn" | "stepOut") {
    if (this.state.busy) return;
    this.update({ busy: true, error: null });
    try {
      let threadId = this.state.threadId;
      if (threadId === null)
        threadId = (await this.command({ action: "threads" })).threads?.[0]?.id ?? null;
      if (threadId === null) throw new Error("The debug target has no active thread yet.");
      await this.command({ action, threadId });
      if (action !== "pause") {
        this.frameGeneration++;
        this.update({ phase: "running", frames: [], scopes: [], frameId: null });
      }
    } catch (error) {
      this.report(error);
    } finally {
      this.update({ busy: false });
    }
  }
  async stop() {
    ++this.generation;
    ++this.frameGeneration;
    clearTimeout(this.pollTimer);
    if (!this.state.sessionId) return;
    this.update({ busy: true });
    try {
      await this.command({ action: "disconnect" });
      this.update({ phase: "ended", frameId: null, frames: [], scopes: [], connectionId: null });
    } catch (error) {
      this.report(error);
    } finally {
      this.update({ busy: false });
    }
  }
  dismiss() {
    if (["running", "paused", "starting"].includes(this.state.phase)) return;
    ++this.generation;
    clearTimeout(this.pollTimer);
    this.update({ ...initial(), breakpoints: this.state.breakpoints, watches: this.state.watches });
  }
  async selectTarget(connectionId: string, preferredThread?: number) {
    const generation = ++this.frameGeneration;
    this.update({ connectionId, frames: [], scopes: [], frameId: null });
    const { threads = [] } = await this.command({ action: "threads", connectionId });
    if (generation !== this.frameGeneration) return;
    const threadId = preferredThread ?? threads[0]?.id ?? null;
    this.update({ threads, threadId });
    if (threadId !== null && this.state.phase === "paused") await this.selectThread(threadId);
  }
  async selectThread(threadId: number) {
    const generation = ++this.frameGeneration;
    this.update({ threadId, frames: [], scopes: [], frameId: null });
    const { frames = [] } = await this.command({ action: "stackTrace", threadId });
    if (generation !== this.frameGeneration) return;
    this.update({ frames });
    if (frames[0]) await this.selectFrame(frames[0].id);
  }
  async selectFrame(frameId: number) {
    const generation = ++this.frameGeneration;
    this.update({ frameId, scopes: [] });
    const { scopes = [] } = await this.command({ action: "scopes", frameId });
    if (generation !== this.frameGeneration) return;
    this.update({ scopes });
    await this.refreshWatches(generation);
  }
  async replaceBreakpoints(relativePath: string, breakpoints: readonly EditorDebugBreakpoint[]) {
    if (
      JSON.stringify(
        this.state.breakpoints.filter((item) => item.relativePath === relativePath),
      ) === JSON.stringify(breakpoints)
    )
      return;
    this.update({
      breakpoints: [
        ...this.state.breakpoints.filter((item) => item.relativePath !== relativePath),
        ...breakpoints,
      ],
    });
    if (!this.state.sessionId || !["running", "paused"].includes(this.state.phase)) return;
    try {
      if (!(await flushWorkspaceEditors(this.client, this.cwd)))
        throw new Error("Save the changed source before updating breakpoints.");
      const result = await this.command({
        action: "setBreakpoints",
        relativePath,
        breakpoints: [...breakpoints],
      });
      const pending = result.breakpoints?.find((item) => !item.verified && item.message);
      if (pending) this.update({ error: pending.message });
    } catch (error) {
      this.report(error);
    }
  }
  toggleBreakpoint(relativePath: string, line: number) {
    const existing = this.state.breakpoints.filter((item) => item.relativePath === relativePath);
    return this.replaceBreakpoints(
      relativePath,
      existing.some((item) => item.line === line)
        ? existing.filter((item) => item.line !== line)
        : [...existing, { relativePath, line }].sort((a, b) => a.line - b.line),
    );
  }
  async evaluate(expression: string, context: "watch" | "repl") {
    return (
      await this.command({
        action: "evaluate",
        expression,
        context,
        ...(this.state.frameId === null ? {} : { frameId: this.state.frameId }),
      })
    ).evaluation;
  }
  async console(expression: string) {
    const result = await this.evaluate(expression, "repl");
    this.update({
      output: [
        ...this.state.output.slice(-498),
        `> ${expression}\n`,
        `${result?.value ?? "undefined"}\n`,
      ],
    });
  }
  async addWatch(expression: string) {
    if (!expression.trim() || this.state.watches.some((item) => item.expression === expression))
      return;
    if (this.state.watches.length >= 32)
      throw new Error("A session supports at most 32 watch expressions.");
    this.update({
      watches: [
        ...this.state.watches,
        { expression, value: "Not evaluated", variablesReference: 0 },
      ],
    });
    if (this.state.phase === "paused") await this.refreshWatches(this.frameGeneration);
  }
  removeWatch(expression: string) {
    this.update({ watches: this.state.watches.filter((item) => item.expression !== expression) });
  }
  private async refreshWatches(generation: number) {
    const watches = await Promise.all(
      this.state.watches.map(async (watch) => {
        try {
          const result = await this.evaluate(watch.expression, "watch");
          return {
            ...watch,
            value: result?.value ?? "undefined",
            variablesReference: result?.variablesReference ?? 0,
          };
        } catch (error) {
          return {
            ...watch,
            value: error instanceof Error ? error.message : "Unavailable",
            variablesReference: 0,
          };
        }
      }),
    );
    if (generation === this.frameGeneration) this.update({ watches });
  }
}
export function getEditorDebugStore(client: QueryClient, cwd: string) {
  let registry = registries.get(client);
  if (!registry) {
    registry = new Map();
    registries.set(client, registry);
  }
  let store = registry.get(cwd);
  if (!store) {
    store = new EditorDebugStore(client, cwd);
    registry.set(cwd, store);
  }
  return store;
}
export function useEditorDebug(store: EditorDebugStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

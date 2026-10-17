import path from "node:path";
import { realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { spawnProcess } from "@synara/shared/processRuntime";
import { resolveExecutable } from "@synara/shared/executable";
import { isPathInside } from "@synara/shared/pathContainment";
import type {
  EditorDebugActionInput,
  EditorDebugActionResult,
  EditorDebugBreakpoint,
  EditorDebugEvent,
  EditorDebugSnapshot,
  EditorDebugStartInput,
} from "@synara/contracts";
import { createProtocolProcessTeardown } from "../platform/protocolProcessTeardown";
import {
  stripSynaraControlPlaneEnvironment,
  withoutProviderCredentialEnvironment,
} from "../providerChildEnvironment";
import {
  DapConnection,
  dapArray,
  dapNumber,
  dapObject,
  dapString,
  type DapObject,
} from "./dapConnection";
import { ensureDebugAdapter } from "./debugAdapterInstaller";

type Connection = { id: string; name: string; dap: DapConnection; ready: boolean; ended: boolean };
type DebugSession = {
  id: string;
  owner: string;
  cwd: string;
  request: "launch" | "attach";
  process: ChildProcess;
  port: number;
  connections: Map<string, Connection>;
  breakpoints: Map<string, readonly EditorDebugBreakpoint[]>;
  events: EditorDebugEvent[];
  sequence: number;
  touched: number;
  terminated: boolean;
  cleanupComplete?: boolean;
  teardown?: () => Promise<void>;
  stopping?: Promise<void>;
};
const requiredId = (value: number | undefined, name: string) => {
  if (value === undefined) throw new Error(`A ${name} is required for this debug command.`);
  return value;
};

/** Owns actual upstream DAP processes. No graphical workbench or replacement terminal. */
export class EditorDebugService {
  private sessions = new Map<string, DebugSession>();
  private starting = new Map<string, Promise<unknown>>();
  private disposed = false;
  private shutdown = new AbortController();
  private sweep: ReturnType<typeof setInterval>;
  constructor(
    stateDir: string,
    private readonly adapter: (signal: AbortSignal) => Promise<string> = (signal) =>
      ensureDebugAdapter(stateDir, signal),
  ) {
    this.sweep = setInterval(() => {
      for (const session of this.sessions.values()) {
        if (Date.now() - session.touched <= 120_000) continue;
        if (session.cleanupComplete) this.sessions.delete(session.id);
        else
          void this.stop(session).catch((error: unknown) =>
            this.emit(
              session,
              "root",
              "error",
              error instanceof Error ? error.message : "Debugger cleanup failed.",
            ),
          );
      }
    }, 30_000).unref();
  }
  private emit(
    session: DebugSession,
    connectionId: string,
    event: EditorDebugEvent["event"],
    text = "",
    extra: { threadId?: number; exitCode?: number } = {},
  ) {
    session.events.push({
      id: ++session.sequence,
      connectionId,
      event,
      text: text.slice(0, 16_384),
      ...extra,
    });
    // A slow/disconnected client cannot retain unlimited debuggee output.
    while (
      session.events.length > 500 ||
      session.events.reduce((sum, item) => sum + item.text.length, 0) > 512_000
    )
      session.events.shift();
  }
  private owned(owner: string, id: string) {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner)
      throw new Error("The debug session is not available to this connection.");
    session.touched = Date.now();
    return session;
  }
  private async workspaceFile(root: string, relativePath: string) {
    if (
      path.isAbsolute(relativePath) ||
      relativePath.includes("\0") ||
      relativePath.split(/[\\/]/).some((part) => part === ".." || part === ".git")
    )
      throw new Error("Expected a workspace-relative debug source.");
    const file = await realpath(path.resolve(root, relativePath));
    if (!isPathInside(root, file))
      throw new Error("Debug source escaped its workspace through a symlink.");
    return file;
  }
  /** Like `workspaceFile`, but a since-deleted breakpoint source is `undefined`, not an error. */
  private async breakpointSource(root: string, relativePath: string) {
    try {
      return await this.workspaceFile(root, relativePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      throw error;
    }
  }
  private sourcePath(session: DebugSession, value: unknown) {
    const file = dapString(value);
    return file && path.isAbsolute(file) && isPathInside(session.cwd, file)
      ? path.relative(session.cwd, file).split(path.sep).join("/")
      : undefined;
  }
  start(
    owner: string,
    input: EditorDebugStartInput,
    signal?: AbortSignal,
  ): Promise<{ sessionId: string }> {
    if (this.disposed) return Promise.reject(new Error("The debugger service is shutting down."));
    if (
      this.starting.has(owner) ||
      [...this.sessions.values()].some(
        (session) => session.owner === owner && !session.cleanupComplete,
      )
    )
      return Promise.reject(new Error("Stop the current debug session before starting another."));
    if (
      this.starting.size +
        [...this.sessions.values()].filter((session) => !session.cleanupComplete).length >=
      4
    )
      return Promise.reject(new Error("The server's debug session limit has been reached."));
    const pending = this.launch(owner, input, signal).finally(() => this.starting.delete(owner));
    this.starting.set(owner, pending);
    return pending;
  }
  private async launch(
    owner: string,
    input: EditorDebugStartInput,
    signal?: AbortSignal,
  ): Promise<{ sessionId: string }> {
    const cwd = await realpath(input.cwd);
    if (input.request === "attach" && input.port === 0)
      throw new Error("Enter the loopback Node inspector port to attach.");
    const program =
      input.request === "launch" ? await this.workspaceFile(cwd, input.program) : undefined;
    if (program && !/\.(?:[cm]?js|[cm]?ts)$/i.test(program))
      throw new Error(
        "Launch a Node.js .js/.mjs/.cjs entry point, or a .ts/.mts/.cts file supported by your Node runtime. Build JSX before debugging it.",
      );
    const breakpoints = new Map<string, readonly EditorDebugBreakpoint[]>();
    for (const bp of input.breakpoints) {
      // A deleted file's breakpoints are skipped; they must not block the launch.
      if (!(await this.breakpointSource(cwd, bp.relativePath))) continue;
      breakpoints.set(bp.relativePath, [...(breakpoints.get(bp.relativePath) ?? []), bp]);
    }
    const cancellation = signal
      ? AbortSignal.any([signal, this.shutdown.signal])
      : this.shutdown.signal;
    cancellation.throwIfAborted();
    const adapter = await new Promise<string>((resolve, reject) => {
      const abort = () => reject(new Error("Debug launch was cancelled."));
      cancellation.addEventListener("abort", abort, { once: true });
      this.adapter(this.shutdown.signal).then(
        (entry) => {
          cancellation.removeEventListener("abort", abort);
          resolve(entry);
        },
        (error: unknown) => {
          cancellation.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
    if (signal?.aborted || this.disposed) throw new Error("Debug launch was cancelled.");
    // The adapter and debuggee get the user's environment, never Synara's authority or
    // provider credentials. Packaged desktop reuses Electron's executable, so Node mode is
    // set explicitly rather than inherited.
    const env = withoutProviderCredentialEnvironment(
      stripSynaraControlPlaneEnvironment(process.env),
    );
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
    const node = process.versions.bun ? resolveExecutable("node", { cwd, env }) : process.execPath;
    if (!node)
      throw new Error(
        "Node.js is required to run the JavaScript debugger. Install Node and try again.",
      );
    const child = spawnProcess(node, [adapter, "0", "127.0.0.1"], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      ownProcessGroup: true,
      requireExecutable: true,
    });
    const session: DebugSession = {
      id: randomUUID(),
      owner,
      cwd,
      request: input.request,
      process: child,
      port: 0,
      connections: new Map(),
      breakpoints,
      events: [],
      sequence: 0,
      touched: Date.now(),
      terminated: false,
    };
    this.sessions.set(session.id, session);
    const abort = () => {
      void this.stop(session).catch((error: unknown) =>
        this.emit(session, "root", "error", String(error)),
      );
    };
    cancellation.addEventListener("abort", abort, { once: true });
    try {
      session.port = await new Promise<number>((resolve, reject) => {
        let buffer = "";
        const timer = setTimeout(
          () => reject(new Error("JavaScript debugger did not start within 10 seconds.")),
          10_000,
        );
        const onError = (error: Error) => {
          clearTimeout(timer);
          reject(error);
        };
        const onExit = () =>
          onError(new Error("JavaScript debugger exited before accepting connections."));
        child.once("error", onError);
        child.once("exit", onExit);
        const onData = (chunk: Buffer) => {
          buffer = (buffer + chunk.toString("utf8")).slice(-8_192);
          const match = /Debug server listening at 127\.0\.0\.1:(\d+)/.exec(buffer);
          if (!match) return;
          clearTimeout(timer);
          child.removeListener("error", onError);
          child.removeListener("exit", onExit);
          child.stdout?.removeListener("data", onData);
          resolve(Number(match[1]));
        };
        child.stdout?.on("data", onData);
      });
      child.stderr?.on("data", (chunk: Buffer) =>
        this.emit(session, "root", "output", chunk.toString("utf8")),
      );
      child.stdout?.on("data", () => undefined); // Drain adapter infrastructure logs, not debuggee output.
      child.on("error", (error) => this.emit(session, "root", "error", error.message));
      child.once("exit", (code) => {
        if (!session.terminated) {
          this.emit(session, "root", "error", `Debug adapter exited (${code ?? "signal"}).`);
          void this.stop(session).catch((error: unknown) =>
            this.emit(session, "root", "error", String(error)),
          );
        }
        for (const connection of session.connections.values()) {
          connection.ready = false;
          connection.dap.dispose();
        }
      });
      const configuration: DapObject = {
        type: "pwa-node",
        request: input.request,
        name: input.request === "launch" ? input.program : `Node :${input.port}`,
        cwd,
        console: "internalConsole",
        internalConsoleOptions: "neverOpen",
        sourceMaps: true,
        resolveSourceMapLocations: [path.join(cwd, "**"), "!**/node_modules/**"],
        outFiles: [path.join(cwd, "**", "*.js"), "!**/node_modules/**"],
        autoAttachChildProcesses: false,
        restart: false,
        ...(program
          ? {
              program,
              args: [...input.args],
              runtimeExecutable: node,
              stopOnEntry: input.stopOnEntry,
            }
          : { address: "127.0.0.1", port: input.port }),
      };
      await this.connect(session, "root", "Node.js", input.request, configuration);
      cancellation.throwIfAborted();
      return { sessionId: session.id };
    } catch (error) {
      try {
        await this.stop(session);
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], "Debug launch and process cleanup failed.", {
          cause: error,
        });
      }
      throw error;
    } finally {
      cancellation.removeEventListener("abort", abort);
    }
  }
  private async connect(
    session: DebugSession,
    id: string,
    name: string,
    request: "launch" | "attach",
    configuration: DapObject,
  ) {
    // Finished child targets do not count toward the cap; short-lived workers come and go.
    for (const [key, item] of session.connections)
      if (item.ended && key !== "root") {
        item.dap.dispose();
        session.connections.delete(key);
      }
    if (session.terminated || session.connections.size >= 8)
      throw new Error("The debug session is closed or has too many targets.");
    const connection: Connection = {
      id,
      name,
      dap: new DapConnection(session.port),
      ready: false,
      ended: false,
    };
    session.connections.set(id, connection);
    const dap = connection.dap;
    dap.onEvent = (event, body) => {
      if (event === "output" && body.category !== "telemetry")
        this.emit(session, id, "output", dapString(body.output));
      else if (event === "stopped")
        this.emit(
          session,
          id,
          "stopped",
          dapString(body.description) || dapString(body.reason),
          typeof body.threadId === "number" ? { threadId: dapNumber(body.threadId) } : {},
        );
      else if (event === "continued" || event === "thread")
        this.emit(
          session,
          id,
          event,
          dapString(body.reason),
          typeof body.threadId === "number" ? { threadId: dapNumber(body.threadId) } : {},
        );
      else if (event === "breakpoint")
        this.emit(session, id, "breakpoint", dapString(dapObject(body.breakpoint).message));
      else if (event === "exited")
        this.emit(session, id, "exited", "Program exited.", { exitCode: dapNumber(body.exitCode) });
      else if (event === "terminated") {
        connection.ready = false;
        connection.ended = true;
        this.emit(session, id, "terminated", "Debug target finished.");
        if (id === "root")
          void this.stop(session).catch((error: unknown) =>
            this.emit(session, id, "error", String(error)),
          );
      }
    };
    dap.onClose = (error) => {
      connection.ready = false;
      if (!session.terminated && !connection.ended) this.emit(session, id, "error", error.message);
      connection.ended = true;
    };
    dap.onRequest = async (command, args) => {
      if (command !== "startDebugging")
        throw new Error(`Synara does not support the adapter's ${command} request.`);
      const config = dapObject(args.configuration);
      if (
        typeof config.__pendingTargetId !== "string" ||
        (args.request !== "launch" && args.request !== "attach")
      )
        throw new Error("Invalid child debugger configuration.");
      // js-debug's standalone server hands actual Node targets to a new DAP connection.
      // The adapter supplies this opaque ID; no arbitrary user launch configuration is accepted.
      await this.connect(
        session,
        randomUUID(),
        dapString(config.name) || "Node target",
        args.request,
        {
          type: "pwa-node",
          name: dapString(config.name),
          __pendingTargetId: config.__pendingTargetId,
        },
      );
      return {};
    };
    await dap.request("initialize", {
      clientID: "synara",
      clientName: "Synara",
      adapterID: "pwa-node",
      locale: "en",
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: "path",
      supportsVariableType: true,
      supportsVariablePaging: true,
      supportsRunInTerminalRequest: false,
      supportsStartDebuggingRequest: true,
      supportsProgressReporting: false,
    });
    const launched = dap.request(request, configuration, 45_000);
    // Handle a rejection immediately even while configuration requests are outstanding.
    void launched.catch(() => undefined);
    for (const [relativePath, breakpoints] of session.breakpoints)
      await this.setBreakpoints(session, connection, relativePath, breakpoints);
    await dap.request("setExceptionBreakpoints", { filters: [] });
    await dap.request("configurationDone");
    await launched;
    connection.ready = true;
    this.emit(session, id, "ready", name);
  }
  private async setBreakpoints(
    session: DebugSession,
    connection: Connection,
    relativePath: string,
    breakpoints: readonly EditorDebugBreakpoint[],
  ): Promise<DapObject> {
    const absolute = await this.breakpointSource(session.cwd, relativePath);
    if (!absolute)
      return {
        breakpoints: breakpoints.map(({ line }) => ({
          verified: false,
          line,
          message: "The source file no longer exists.",
        })),
      };
    return connection.dap.request("setBreakpoints", {
      source: { path: absolute },
      breakpoints: breakpoints.map(({ line, condition, hitCondition, logMessage }) => ({
        line,
        condition,
        hitCondition,
        logMessage,
      })),
      sourceModified: false,
    });
  }
  poll(owner: string, id: string, after: number): EditorDebugSnapshot {
    const session = this.owned(owner, id);
    return {
      sessionId: id,
      sequence: session.sequence,
      terminated: session.cleanupComplete === true,
      connections: [...session.connections.values()].map(({ id: connectionId, name, ready }) => ({
        id: connectionId,
        name,
        ready,
      })),
      events: session.events.filter((event) => event.id > after),
    };
  }
  async action(owner: string, input: EditorDebugActionInput): Promise<EditorDebugActionResult> {
    const session = this.owned(owner, input.sessionId);
    if (input.action === "disconnect") {
      await this.stop(session);
      return {};
    }
    if (session.terminated) throw new Error("The debug session has ended.");
    const connection = input.connectionId
      ? session.connections.get(input.connectionId)
      : ([...session.connections.values()].find((item) => item.id !== "root" && item.ready) ??
        session.connections.get("root"));
    if (!connection?.ready) throw new Error("The debug target is not ready.");
    const request = (command: string, args: DapObject = {}) =>
      connection.dap.request(command, args);
    switch (input.action) {
      case "continue":
      case "pause":
      case "next":
      case "stepIn":
      case "stepOut":
        await request(input.action, { threadId: requiredId(input.threadId, "thread ID") });
        return {};
      case "threads":
        return {
          threads: dapArray((await request("threads")).threads).map((item) => ({
            id: dapNumber(item.id),
            name: dapString(item.name),
          })),
        };
      case "stackTrace":
        return {
          frames: dapArray(
            (
              await request("stackTrace", {
                threadId: requiredId(input.threadId, "thread ID"),
                startFrame: 0,
                levels: 100,
              })
            ).stackFrames,
          ).map((item) => {
            const source = dapObject(item.source),
              relativePath = this.sourcePath(session, source.path);
            return {
              id: dapNumber(item.id),
              name: dapString(item.name),
              line: dapNumber(item.line),
              column: dapNumber(item.column),
              sourceName: dapString(source.name),
              ...(relativePath ? { relativePath } : {}),
            };
          }),
        };
      case "scopes":
        return {
          scopes: dapArray(
            (await request("scopes", { frameId: requiredId(input.frameId, "frame ID") })).scopes,
          ).map((item) => ({
            name: dapString(item.name),
            variablesReference: dapNumber(item.variablesReference),
            expensive: item.expensive === true,
          })),
        };
      case "variables":
        return {
          variables: dapArray(
            (
              await request("variables", {
                variablesReference: requiredId(input.variablesReference, "variables reference"),
                start: 0,
                count: 200,
              })
            ).variables,
          ).map((item) => this.variable(item)),
        };
      case "evaluate": {
        if (!input.expression?.trim()) throw new Error("Enter an expression to evaluate.");
        const result = await request("evaluate", {
          expression: input.expression,
          context: input.context ?? "repl",
          ...(input.frameId === undefined ? {} : { frameId: input.frameId }),
        });
        return {
          evaluation: this.variable({ ...result, name: input.expression, value: result.result }),
        };
      }
      case "setBreakpoints": {
        if (
          !input.relativePath ||
          !input.breakpoints ||
          input.breakpoints.some((item) => item.relativePath !== input.relativePath)
        )
          throw new Error("Breakpoints must belong to the requested source file.");
        // Rejects escapes before storing; a deleted file is reported unverified below.
        await this.breakpointSource(session.cwd, input.relativePath);
        session.breakpoints.set(input.relativePath, input.breakpoints);
        const results = await Promise.all(
          [...session.connections.values()]
            .filter((item) => item.ready)
            .map((item) =>
              this.setBreakpoints(session, item, input.relativePath!, input.breakpoints!),
            ),
        );
        const body = results.at(-1) ?? {};
        return {
          breakpoints: dapArray(body.breakpoints).map((bp) => ({
            verified: bp.verified === true,
            line: dapNumber(bp.line),
            message: dapString(bp.message),
          })),
        };
      }
    }
  }
  private variable(item: DapObject) {
    return {
      name: dapString(item.name),
      value: dapString(item.value).slice(0, 32_768),
      variablesReference: dapNumber(item.variablesReference),
      ...(typeof item.type === "string" ? { type: item.type } : {}),
      ...(typeof item.evaluateName === "string" ? { evaluateName: item.evaluateName } : {}),
    };
  }
  private stop(session: DebugSession): Promise<void> {
    if (session.cleanupComplete) return Promise.resolve();
    if (session.stopping) return session.stopping;
    session.terminated = true;
    session.teardown ??= createProtocolProcessTeardown(session.process, async () => {
      const root = session.connections.get("root");
      try {
        // Attach detaches only; it must never terminate someone else's Node process.
        if (root)
          await root.dap.request(
            "disconnect",
            { terminateDebuggee: session.request === "launch" },
            3_000,
          );
      } finally {
        for (const connection of session.connections.values()) {
          connection.ready = false;
          connection.dap.dispose();
        }
      }
    });
    const pending = session
      .teardown()
      .then(() => {
        session.cleanupComplete = true;
        this.emit(
          session,
          "root",
          "terminated",
          session.request === "attach" ? "Detached from Node." : "Debug session stopped.",
        );
      })
      .finally(() => {
        delete session.stopping;
      });
    session.stopping = pending;
    return pending;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.shutdown.abort();
    clearInterval(this.sweep);
    await Promise.allSettled(this.starting.values());
    const results = await Promise.allSettled(
      [...this.sessions.values()].map((session) => this.stop(session)),
    );
    for (const session of this.sessions.values()) {
      if (session.cleanupComplete) this.sessions.delete(session.id);
    }
    const errors = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (errors.length)
      throw new AggregateError(
        errors.map((result) => result.reason),
        "One or more debug process trees could not be verified stopped.",
      );
  }
}

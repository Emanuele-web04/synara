import path from "node:path";
import { readFile, stat, realpath } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { URI } from "@code-oss/vs/base/common/uri.js";
import { parse } from "@code-oss/vs/base/common/json.js";
import { CancellationToken } from "@code-oss/vs/base/common/cancellation.js";

const object = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid extension debugger object.");
  return value;
};
const integer = (value) => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid extension debugger identifier.");
  return value;
};
const inside = (root, filename) => {
  const relative = path.relative(root, filename);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
};

/** Actual Code-OSS descriptor factories and DAP actors, presented by Synara's
 * existing debugger. All adapters and debuggees remain inside the host sandbox. */
export class NativeExtensionDebugAdapter {
  constructor(actor, activate, initialization, documents) {
    this.actor = actor;
    this.activate = activate;
    this.initialization = initialization;
    this.documents = documents;
    this.configurationProviders = new Map();
    this.sessions = new Map();
    this.nextHandle = 1;
    this.nextSequence = 1;
  }
  mainThread() {
    return {
      $registerDebugTypes() {},
      $registerDebugConfigurationProvider: (
        type,
        trigger,
        provides,
        resolves,
        substitutes,
        handle,
      ) => {
        this.configurationProviders.set(handle, {
          type,
          trigger,
          provides,
          resolves,
          substitutes,
          handle,
        });
      },
      $unregisterDebugConfigurationProvider: (handle) => {
        this.configurationProviders.delete(handle);
      },
      $registerDebugAdapterDescriptorFactory() {},
      $unregisterDebugAdapterDescriptorFactory() {},
      $sessionCached() {},
      $acceptDAMessage: (handle, message) => this.receive(handle, message),
      $acceptDAError: (handle, name, message) =>
        this.fail(handle, new Error(`${name}: ${message}`)),
      $acceptDAExit: (handle, code) => {
        const session = this.byHandle(handle);
        if (session) {
          session.terminated = true;
          this.emit(session, "exited", "", { exitCode: typeof code === "number" ? code : -1 });
        }
        this.fail(handle, new Error("Extension debug adapter exited."));
      },
      $setDebugSessionName: (id, name) => {
        const session = this.sessions.get(id);
        if (session) session.name = String(name).slice(0, 256);
      },
      $appendDebugConsole: (text) => {
        for (const session of this.sessions.values())
          if (!session.terminated) this.emit(session, "output", String(text));
      },
      $customDebugAdapterRequest: (id, command, args) =>
        this.request(this.session(id), command, args),
      $startDebugging() {
        throw new Error("Start extension debugging from the native Synara command picker.");
      },
      $stopDebugging() {
        throw new Error("Stop extension debugging through the native Synara lifecycle owner.");
      },
    };
  }
  byHandle(handle) {
    return [...this.sessions.values()].find((session) => session.handle === handle);
  }
  session(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Unknown extension debug session.");
    return session;
  }
  emit(session, event, text = "", extra = {}) {
    session.events.push({
      id: ++session.sequence,
      connectionId: "extension",
      event,
      text: text.slice(0, 16_384),
      ...extra,
    });
    while (
      session.events.length > 500 ||
      session.events.reduce((size, item) => size + item.text.length, 0) > 512_000
    )
      session.events.shift();
  }
  fail(handle, error) {
    const session = this.byHandle(handle);
    if (!session) return;
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    session.pending.clear();
    this.emit(session, "error", error.message);
  }
  receive(handle, raw) {
    const session = this.byHandle(handle);
    if (!session) return;
    const message = object(raw);
    if (message.type === "response") {
      const pending = session.pending.get(message.request_seq);
      if (!pending) return;
      clearTimeout(pending.timer);
      session.pending.delete(message.request_seq);
      if (message.success) pending.resolve(message.body ?? {});
      else
        pending.reject(
          new Error(String(message.message ?? "The extension debugger rejected the request.")),
        );
    } else if (message.type === "event") {
      const body = message.body ?? {};
      if (message.event === "initialized") {
        session.initialized = true;
        session.onInitialized?.();
      } else if (message.event === "terminated") {
        session.terminated = true;
        this.emit(session, "terminated");
      } else if (["stopped", "continued", "thread", "breakpoint"].includes(message.event))
        this.emit(
          session,
          message.event,
          typeof body.reason === "string" ? body.reason : "",
          Number.isSafeInteger(body.threadId) ? { threadId: body.threadId } : {},
        );
      else if (message.event === "output") this.emit(session, "output", String(body.output ?? ""));
      else if (message.event === "exited")
        this.emit(session, "exited", "", {
          exitCode: typeof body.exitCode === "number" ? body.exitCode : -1,
        });
    } else if (message.type === "request") {
      // Never create another terminal or execute an adapter's reverse request
      // in the privileged parent. Unsupported reverse requests fail explicitly.
      void this.actor().$sendDAMessage(handle, {
        type: "response",
        seq: this.nextSequence++,
        request_seq: message.seq,
        command: message.command,
        success: false,
        message: "Synara does not support this reverse debug request.",
      });
    }
  }
  request(session, command, args = {}, timeoutMs = 15_000) {
    if (session.terminated) return Promise.reject(new Error("Extension debug session ended."));
    if (session.pending.size >= 64)
      return Promise.reject(new Error("Extension debugger request limit reached."));
    const seq = this.nextSequence++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(seq);
        reject(new Error(`Extension debugger ${command} timed out.`));
      }, timeoutMs).unref();
      session.pending.set(seq, { resolve, reject, timer });
      Promise.resolve(
        this.actor().$sendDAMessage(session.handle, {
          type: "request",
          seq,
          command,
          arguments: args,
        }),
      ).catch((error) => {
        clearTimeout(timer);
        session.pending.delete(seq);
        reject(error);
      });
    });
  }
  async configurations() {
    const initialization = this.initialization();
    const filename = path.join(initialization.workspace, ".vscode", "launch.json");
    const snapshot = this.documents().get(URI.file(filename).toString());
    let contents;
    if (snapshot) contents = snapshot.contents;
    else {
      const info = await stat(filename).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (!info) return [];
      if (!info.isFile() || info.size > 1_000_000)
        throw new Error("The launch configuration exceeds its size limit.");
      contents = await readFile(filename, "utf8");
    }
    const errors = [];
    const config = parse(contents, errors, { allowTrailingComma: true });
    if (
      errors.length ||
      !Array.isArray(config?.configurations) ||
      config.configurations.length > 64
    )
      throw new Error("Invalid .vscode/launch.json configurations.");
    const types = new Set(
      initialization.extensions
        .flatMap(({ manifest }) => manifest.contributes?.debuggers ?? [])
        .map((item) => item.type),
    );
    return config.configurations
      .filter((item) => item && types.has(item.type) && item.request === "launch")
      .map((configuration) => ({
        id: createHash("sha256").update(JSON.stringify(configuration)).digest("hex"),
        name: String(configuration.name ?? configuration.type).slice(0, 256),
        type: configuration.type,
        configuration,
      }));
  }
  async workspaceFile(relativePath) {
    const root = this.initialization().workspace;
    if (
      typeof relativePath !== "string" ||
      path.isAbsolute(relativePath) ||
      relativePath.split(/[\\/]/).some((part) => part === ".." || part === ".git")
    )
      throw new Error("Expected a workspace-relative debug file.");
    const filename = await realpath(path.resolve(root, relativePath));
    if (!inside(root, filename)) throw new Error("Extension debug file escapes the workspace.");
    return filename;
  }
  substitute(value, variables, depth = 0) {
    if (depth > 16) throw new Error("Debug configuration exceeds the nesting limit.");
    if (typeof value === "string")
      return value.replace(/\$\{([^}]+)\}/g, (_, name) => {
        if (!(name in variables)) throw new Error(`Unsupported debug variable ${name}.`);
        return variables[name];
      });
    if (Array.isArray(value))
      return value.map((item) => this.substitute(item, variables, depth + 1));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          this.substitute(item, variables, depth + 1),
        ]),
      );
    return value;
  }
  async start(params) {
    if ([...this.sessions.values()].some((session) => !session.terminated))
      throw new Error("Stop the existing extension debug session first.");
    const selected = (await this.configurations()).find(
      (item) => item.id === params.configurationId,
    );
    if (!selected)
      throw new Error("The selected launch configuration changed or its extension is unavailable.");
    const initialization = this.initialization(),
      cwd = initialization.workspace;
    await this.activate(selected.type);
    const file = await this.workspaceFile(params.relativePath);
    let configuration = selected.configuration;
    if (
      configuration.preLaunchTask ||
      configuration.postDebugTask ||
      configuration.debugServer ||
      configuration.terminal ||
      configuration.request !== "launch"
    )
      throw new Error(
        "This launch requires an unsupported external task, terminal, or debug server.",
      );
    const folder = URI.file(cwd);
    for (const provider of this.configurationProviders.values())
      if ((provider.type === selected.type || provider.type === "*") && provider.resolves) {
        configuration = await this.actor().$resolveDebugConfiguration(
          provider.handle,
          folder,
          configuration,
          CancellationToken.None,
        );
        if (!configuration) throw new Error("The extension cancelled its debug configuration.");
      }
    configuration = this.substitute(configuration, {
      workspaceFolder: cwd,
      workspaceRoot: cwd,
      workspaceFolderBasename: path.basename(cwd),
      file,
      fileBasename: path.basename(file),
      fileDirname: path.dirname(file),
      relativeFile: path.relative(cwd, file),
    });
    for (const provider of this.configurationProviders.values())
      if ((provider.type === selected.type || provider.type === "*") && provider.substitutes) {
        configuration = await this.actor().$resolveDebugConfigurationWithSubstitutedVariables(
          provider.handle,
          folder,
          configuration,
          CancellationToken.None,
        );
        if (!configuration)
          throw new Error("The extension cancelled its resolved debug configuration.");
      }
    if (
      configuration.type !== selected.type ||
      configuration.request !== "launch" ||
      configuration.preLaunchTask ||
      configuration.postDebugTask ||
      configuration.debugServer ||
      configuration.terminal
    )
      throw new Error("Resolved debug configuration requires an unsupported capability.");
    const session = {
      id: randomUUID(),
      handle: this.nextHandle++,
      name: selected.name,
      configuration,
      events: [],
      sequence: 0,
      pending: new Map(),
      initialized: false,
      terminated: false,
      ready: false,
    };
    this.sessions.set(session.id, session);
    const dto = {
      id: session.id,
      type: selected.type,
      name: selected.name,
      folderUri: folder,
      configuration,
    };
    await this.actor().$startDASession(session.handle, dto);
    await this.actor().$acceptDebugSessionStarted(dto);
    await this.actor().$acceptDebugSessionActiveChanged(dto);
    const capabilities = await this.request(session, "initialize", {
      clientID: "synara",
      clientName: "Synara",
      adapterID: selected.type,
      pathFormat: "path",
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsVariableType: true,
      supportsVariablePaging: false,
      supportsRunInTerminalRequest: false,
      supportsStartDebuggingRequest: false,
    });
    const launched = this.request(session, "launch", configuration, 25_000);
    void launched.catch(() => undefined);
    if (!session.initialized)
      await Promise.race([
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Extension debug adapter did not initialize.")),
            10_000,
          ).unref();
          session.onInitialized = () => {
            clearTimeout(timer);
            resolve();
          };
        }),
        launched.then(() => {
          if (!session.initialized)
            throw new Error("Extension debug adapter omitted its initialization event.");
        }),
      ]);
    const grouped = new Map();
    for (const breakpoint of params.breakpoints ?? [])
      grouped.set(breakpoint.relativePath, [
        ...(grouped.get(breakpoint.relativePath) ?? []),
        breakpoint,
      ]);
    for (const [relativePath, breakpoints] of grouped)
      await this.setBreakpoints(session, relativePath, breakpoints);
    if (capabilities.supportsConfigurationDoneRequest)
      await this.request(session, "configurationDone");
    await launched;
    session.ready = true;
    this.emit(session, "ready");
    return { sessionId: session.id };
  }
  async setBreakpoints(session, relativePath, breakpoints) {
    const filename = await this.workspaceFile(relativePath);
    const result = await this.request(session, "setBreakpoints", {
      source: { path: filename },
      breakpoints: breakpoints.map((item) => ({
        line: integer(item.line),
        ...(item.condition ? { condition: item.condition } : {}),
        ...(item.hitCondition ? { hitCondition: item.hitCondition } : {}),
        ...(item.logMessage ? { logMessage: item.logMessage } : {}),
      })),
    });
    return {
      breakpoints: (result.breakpoints ?? []).map((item) => ({
        verified: item.verified === true,
        line: item.line ?? 0,
        message: item.message ?? "",
      })),
    };
  }
  sourcePath(value) {
    if (!value) return undefined;
    const filename =
      typeof value === "string"
        ? value.startsWith("file:")
          ? URI.parse(value).fsPath
          : value
        : URI.revive(value).fsPath;
    return path.isAbsolute(filename) && inside(this.initialization().workspace, filename)
      ? path.relative(this.initialization().workspace, filename).split(path.sep).join("/")
      : undefined;
  }
  async action(params) {
    const session = this.session(params.sessionId);
    const action = params.action;
    if (action === "disconnect")
      throw new Error(
        "The parent lifecycle owner must capture descendants before disconnecting this extension host.",
      );
    if (action === "setBreakpoints")
      return this.setBreakpoints(session, params.relativePath, params.breakpoints ?? []);
    const args = {};
    for (const key of ["threadId", "frameId", "variablesReference"])
      if (params[key] !== undefined) args[key] = integer(params[key]);
    if (action === "stackTrace") {
      args.startFrame = 0;
      args.levels = 50;
    }
    if (action === "evaluate") {
      args.expression = String(params.expression ?? "").slice(0, 16_384);
      args.context = params.context ?? "watch";
    }
    if (
      ![
        "continue",
        "pause",
        "next",
        "stepIn",
        "stepOut",
        "threads",
        "stackTrace",
        "scopes",
        "variables",
        "evaluate",
      ].includes(action)
    )
      throw new Error("Unsupported extension debug action.");
    const result = await this.request(session, action, args);
    if (action === "threads")
      return { threads: (result.threads ?? []).map(({ id, name }) => ({ id, name })) };
    if (action === "stackTrace")
      return {
        frames: (result.stackFrames ?? []).map((frame) => {
          const relativePath = this.sourcePath(frame.source?.path);
          return {
            id: frame.id,
            name: frame.name,
            line: frame.line ?? 0,
            column: frame.column ?? 0,
            sourceName: frame.source?.name ?? "",
            ...(relativePath ? { relativePath } : {}),
          };
        }),
      };
    if (action === "scopes")
      return {
        scopes: (result.scopes ?? []).map((scope) => ({
          name: scope.name,
          variablesReference: scope.variablesReference,
          expensive: scope.expensive === true,
        })),
      };
    if (action === "variables")
      return {
        variables: (result.variables ?? []).map((value) => ({
          name: value.name,
          value: value.value,
          variablesReference: value.variablesReference ?? 0,
          ...(typeof value.type === "string" ? { type: value.type } : {}),
          ...(typeof value.evaluateName === "string" ? { evaluateName: value.evaluateName } : {}),
        })),
      };
    if (action === "evaluate")
      return {
        evaluation: {
          name: String(params.expression ?? ""),
          value: String(result.result ?? ""),
          variablesReference: result.variablesReference ?? 0,
          ...(typeof result.type === "string" ? { type: result.type } : {}),
        },
      };
    return {};
  }
  async dispatch(params) {
    if (params.operation === "configurations")
      return (await this.configurations()).map(({ id, name, type }) => ({ id, name, type }));
    if (params.operation === "start") return this.start(params);
    if (params.operation === "action") return this.action(params);
    if (params.operation === "poll") {
      const session = this.session(params.sessionId);
      return {
        sessionId: session.id,
        sequence: session.sequence,
        terminated: session.terminated,
        connections: [{ id: "extension", name: session.name, ready: session.ready }],
        events: session.events.filter((event) => event.id > (params.after ?? 0)),
      };
    }
    throw new Error("Unknown extension debugger operation.");
  }
  async shutdown() {
    for (const session of this.sessions.values()) {
      if (!session.terminated)
        await this.request(session, "disconnect", { terminateDebuggee: true }, 1_000).catch(
          () => undefined,
        );
      await this.actor().$stopDASession(session.handle);
      session.terminated = true;
      await this.actor().$acceptDebugSessionTerminated(session.id);
    }
  }
}

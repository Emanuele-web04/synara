/**
 * RuntimeInstanceDurableObject - one Durable Object per `runtimeInstanceId`.
 *
 * The DO is the authoritative home of a single runtime instance: it owns the
 * instance record, the backing `SandboxRuntime`, and every per-instance route
 * (exec / logs / terminal / files / files-watch / ports / network-policy /
 * renew-activity / get / delete). Keeping all instance state inside one DO is
 * what makes `runtimeInstanceId -> instance` a stable, single-writer mapping:
 * the Worker entrypoint routes by instance id, and the DO serializes concurrent
 * operations on that instance.
 *
 * The `workspace` flavor is the default interactive runtime. The `container`
 * flavor is the raw Containers path, kept service-oriented: it declares ports at
 * create time and rejects the interactive terminal route, so raw Containers stay
 * a lower-level service runtime rather than the default workspace.
 *
 * @module instanceDurableObject
 */
import {
  BridgeCreateInstanceRequest,
  BridgeExecRequest,
  BridgeExposePortRequest,
  BridgeFileWriteRequest,
  BridgeNetworkPolicyRequest,
  BridgeRenewActivityRequest,
  BridgeTerminalFrame,
  RuntimeRouteId,
  type BridgeInstance,
  type BridgeLogLine,
  type BridgeNetworkRule,
  type BridgeRenewActivityResult,
  type BridgeRoute,
} from "@t3tools/contracts";
import { Schema } from "effect";

import type {
  BridgeEnv,
  DurableObjectState,
  RuntimeTerminalHandle,
  SandboxRuntime,
  WorkerWebSocket,
  WorkerWebSocketPair,
} from "./cloudflareRuntime.ts";
import {
  jsonResponse,
  errorResponse,
  ndjsonStreamResponse,
  webSocketUpgradeResponse,
  type NdjsonSink,
} from "./responses.ts";
import { parseRoute } from "./routes.ts";

/** Factory the entrypoint injects so production binds a real runtime and tests a fake. */
export type SandboxRuntimeFactory = (input: {
  readonly instanceId: string;
  readonly flavor: BridgeInstance["flavor"];
  readonly env: Readonly<Record<string, string>>;
  readonly resources: {
    readonly cpu?: number;
    readonly memoryMb?: number;
    readonly diskMb?: number;
  };
}) => Promise<SandboxRuntime>;

/** Construct globals (WebSocketPair) so tests can run without the Worker runtime. */
export interface DurableObjectPlatform {
  readonly makeWebSocketPair: () => WorkerWebSocketPair;
  readonly now: () => string;
  readonly randomId: () => string;
}

/**
 * Read and validate a JSON request body against a contract schema. Returns
 * `null` on malformed JSON or a decode failure so callers reply 400 uniformly.
 * The decoder is passed pre-applied (`Schema.decodeUnknownExit(Schema)`) so the
 * exact schema/codec type stays inferred rather than over-annotated here.
 */
const decodeBody = async <A>(
  request: Request,
  decode: (input: unknown) => { readonly _tag: "Success" | "Failure"; readonly value?: A },
): Promise<A | null> => {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return null;
  }
  const decoded = decode(raw);
  return decoded._tag === "Success" && decoded.value !== undefined ? decoded.value : null;
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
};

/** Parse a positive PTY dimension from a query param, falling back when invalid. */
const parseTerminalDimension = (value: string | null, fallback: number): number => {
  const parsed = value === null ? Number.NaN : Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const collectStream = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      text += decoder.decode(value, { stream: true });
    }
  }
  text += decoder.decode();
  return text;
};

interface StoredInstance {
  readonly record: BridgeInstance;
  readonly networkPolicy: {
    readonly defaultEgress: "allow" | "deny";
    readonly rules: ReadonlyArray<BridgeNetworkRule>;
  };
  readonly expiresAt: string | null;
}

export class RuntimeInstanceDurableObject {
  private runtime: SandboxRuntime | undefined;
  private readonly watchers = new Set<NdjsonSink<BridgeFileWatchEventLike>>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: BridgeEnv,
    private readonly factory: SandboxRuntimeFactory,
    private readonly platform: DurableObjectPlatform,
  ) {
    void this.env;
  }

  private async load(): Promise<StoredInstance | undefined> {
    return this.state.storage.get<StoredInstance>("instance");
  }

  private async save(value: StoredInstance): Promise<void> {
    await this.state.storage.put("instance", value);
  }

  /**
   * Entrypoint the Worker forwards to. Parses the same route the Worker did and
   * dispatches to the matching handler so the sub-route table lives in one place.
   */
  async fetch(request: Request): Promise<Response> {
    const route = parseRoute(request);
    if (route === null || route.kind === "create-instance") {
      return this.create(request);
    }
    switch (route.sub.kind) {
      case "get":
        // A bare `POST /instances/:id` (the Worker's create rewrite) is the
        // instance create; `GET` reads the current record.
        return request.method === "POST" ? this.create(request) : this.get();
      case "delete":
        return this.destroy();
      case "exec":
        return this.exec(request);
      case "logs":
        return this.logs();
      case "terminal":
        return this.terminal(request);
      case "files":
        return request.method === "PUT" ? this.writeFile(request) : this.readFile(request);
      case "files-watch":
        return this.watchFiles();
      case "ports":
        return this.exposePort(request);
      case "network-policy":
        return this.setNetworkPolicy(request);
      case "renew-activity":
        return this.renewActivity(request);
      default:
        return errorResponse(404, "unknown_instance_route");
    }
  }

  /** POST /instances — create-or-reuse this DO's single instance. */
  async create(request: Request): Promise<Response> {
    const body = await decodeBody(request, Schema.decodeUnknownExit(BridgeCreateInstanceRequest));
    if (body === null) {
      return errorResponse(400, "invalid_create_body");
    }
    const existing = await this.load();
    if (existing !== undefined) {
      return jsonResponse(200, existing.record);
    }
    const instanceId = this.state.id.toString();
    const now = this.platform.now();
    const flavor = body.flavor ?? "workspace";
    const ports = body.ports ?? [];
    const env = body.env ?? {};
    // Container flavor declares its ports up front; a workspace exposes on demand.
    const routes: ReadonlyArray<BridgeRoute> =
      flavor === "container"
        ? ports.map((port) => ({
            id: RuntimeRouteId.makeUnsafe(this.platform.randomId()),
            port,
            url: null,
            label: null,
          }))
        : [];
    const record: BridgeInstance = {
      id: instanceId as BridgeInstance["id"],
      flavor,
      status: "running",
      rootPath: "/workspace",
      routes,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    };
    const stored: StoredInstance = {
      record,
      networkPolicy: { defaultEgress: "allow", rules: [] },
      expiresAt:
        body.idleTimeoutSeconds === undefined
          ? null
          : new Date(Date.now() + body.idleTimeoutSeconds * 1000).toISOString(),
    };
    await this.save(stored);
    this.runtime = await this.factory({
      instanceId,
      flavor,
      env,
      resources: {
        ...(body.resources?.cpu === undefined ? {} : { cpu: body.resources.cpu }),
        ...(body.resources?.memoryMb === undefined ? {} : { memoryMb: body.resources.memoryMb }),
        ...(body.resources?.diskMb === undefined ? {} : { diskMb: body.resources.diskMb }),
      },
    });
    return jsonResponse(201, record);
  }

  private async ensureRuntime(): Promise<SandboxRuntime | null> {
    if (this.runtime !== undefined) {
      return this.runtime;
    }
    const stored = await this.load();
    if (stored === undefined) {
      return null;
    }
    this.runtime = await this.factory({
      instanceId: stored.record.id,
      flavor: stored.record.flavor,
      env: {},
      resources: {},
    });
    return this.runtime;
  }

  async get(): Promise<Response> {
    const stored = await this.load();
    if (stored === undefined) {
      return errorResponse(404, "instance_not_found");
    }
    return jsonResponse(200, stored.record);
  }

  async exec(request: Request): Promise<Response> {
    const stored = await this.load();
    if (stored === undefined) {
      return errorResponse(404, "instance_not_found");
    }
    const body = await decodeBody(request, Schema.decodeUnknownExit(BridgeExecRequest));
    if (body === null) {
      return errorResponse(400, "invalid_exec_body");
    }
    const runtime = await this.ensureRuntime();
    if (runtime === null) {
      return errorResponse(404, "instance_not_found");
    }
    const handle = await runtime.exec({
      command: body.command,
      args: body.args ?? [],
      cwd: body.cwd ?? undefined,
      env: body.env ?? {},
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      collectStream(handle.stdout),
      collectStream(handle.stderr),
      handle.exitCode,
    ]);
    return jsonResponse(200, {
      processId: this.platform.randomId(),
      stdout,
      stderr,
      exitCode,
    });
  }

  async logs(): Promise<Response> {
    const stored = await this.load();
    if (stored === undefined) {
      return errorResponse(404, "instance_not_found");
    }
    return ndjsonStreamResponse<BridgeLogLine>((sink) => {
      // The log stream stays open; a real runtime would push lines from the
      // instance's stdout/stderr ring buffer. With no active process there is
      // nothing to emit, so the stream simply idles until the client closes it.
      void sink;
      return () => {};
    });
  }

  async terminal(request: Request): Promise<Response> {
    const stored = await this.load();
    if (stored === undefined) {
      return errorResponse(404, "instance_not_found");
    }
    // Raw Containers are service-oriented: no interactive terminal. This keeps
    // them a lower-level runtime rather than the default interactive workspace.
    if (stored.record.flavor === "container") {
      return errorResponse(409, "terminal_unsupported_for_container");
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return errorResponse(426, "websocket_upgrade_required");
    }
    const runtime = await this.ensureRuntime();
    if (runtime === null) {
      return errorResponse(404, "instance_not_found");
    }
    // Terminal options ride on the query string: a WebSocket upgrade carries no
    // request body, so command/dimensions cannot come from a JSON payload.
    const params = new URL(request.url).searchParams;
    const pair = this.platform.makeWebSocketPair();
    const server = pair[1];
    server.accept();

    const terminal = await runtime.openTerminal({
      command: params.get("command"),
      args: params.getAll("arg"),
      cols: parseTerminalDimension(params.get("cols"), 80),
      rows: parseTerminalDimension(params.get("rows"), 24),
      cwd: params.get("cwd") ?? undefined,
    });
    this.wireTerminal(server, terminal);

    return webSocketUpgradeResponse(pair[0]);
  }

  private wireTerminal(socket: WorkerWebSocket, terminal: RuntimeTerminalHandle): void {
    const send = (frame: BridgeTerminalFrame) => {
      socket.send(JSON.stringify(frame));
    };
    terminal.onData((chunk) => send({ _tag: "data", data: chunk }));
    terminal.onExit((exitCode) => {
      send({ _tag: "exit", exitCode });
      socket.close(1000, "exit");
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }
      const decoded = Schema.decodeUnknownExit(BridgeTerminalFrame)(safeJsonParse(event.data));
      if (decoded._tag !== "Success") {
        return;
      }
      const frame = decoded.value;
      if (frame._tag === "stdin") {
        terminal.write(frame.data);
      } else if (frame._tag === "resize") {
        terminal.resize(frame.cols, frame.rows);
      }
    });
    socket.addEventListener("close", () => terminal.close());
    socket.addEventListener("error", () => terminal.close());
  }

  async readFile(request: Request): Promise<Response> {
    const stored = await this.load();
    if (stored === undefined) {
      return errorResponse(404, "instance_not_found");
    }
    const path = new URL(request.url).searchParams.get("path");
    if (path === null || path.length === 0) {
      return errorResponse(400, "missing_path");
    }
    const runtime = await this.ensureRuntime();
    if (runtime === null) {
      return errorResponse(404, "instance_not_found");
    }
    try {
      const bytes = await runtime.fs.read(path);
      return jsonResponse(200, { path, contentBase64: toBase64(bytes), truncated: false });
    } catch {
      return errorResponse(404, "file_not_found");
    }
  }

  async writeFile(request: Request): Promise<Response> {
    const stored = await this.load();
    if (stored === undefined) {
      return errorResponse(404, "instance_not_found");
    }
    const body = await decodeBody(request, Schema.decodeUnknownExit(BridgeFileWriteRequest));
    if (body === null) {
      return errorResponse(400, "invalid_write_body");
    }
    const runtime = await this.ensureRuntime();
    if (runtime === null) {
      return errorResponse(404, "instance_not_found");
    }
    await runtime.fs.write(body.path, fromBase64(body.contentBase64));
    for (const watcher of this.watchers) {
      watcher.write({ path: body.path, kind: "modified", at: this.platform.now() });
    }
    return jsonResponse(200, { ok: true });
  }

  async watchFiles(): Promise<Response> {
    const stored = await this.load();
    if (stored === undefined) {
      return errorResponse(404, "instance_not_found");
    }
    return ndjsonStreamResponse<BridgeFileWatchEventLike>((sink) => {
      this.watchers.add(sink);
      return () => {
        this.watchers.delete(sink);
      };
    });
  }

  async exposePort(request: Request): Promise<Response> {
    const stored = await this.load();
    if (stored === undefined) {
      return errorResponse(404, "instance_not_found");
    }
    const body = await decodeBody(request, Schema.decodeUnknownExit(BridgeExposePortRequest));
    if (body === null) {
      return errorResponse(400, "invalid_port_body");
    }
    const runtime = await this.ensureRuntime();
    if (runtime === null) {
      return errorResponse(404, "instance_not_found");
    }
    const url = await runtime.exposePort({ port: body.port, label: body.label ?? null });
    const route: BridgeRoute = {
      id: RuntimeRouteId.makeUnsafe(this.platform.randomId()),
      port: body.port,
      url,
      label: body.label ?? null,
    };
    const next: StoredInstance = {
      ...stored,
      record: {
        ...stored.record,
        routes: [...(stored.record.routes ?? []), route],
        updatedAt: this.platform.now(),
      },
    };
    await this.save(next);
    return jsonResponse(201, route);
  }

  async setNetworkPolicy(request: Request): Promise<Response> {
    const stored = await this.load();
    if (stored === undefined) {
      return errorResponse(404, "instance_not_found");
    }
    const body = await decodeBody(request, Schema.decodeUnknownExit(BridgeNetworkPolicyRequest));
    if (body === null) {
      return errorResponse(400, "invalid_network_policy_body");
    }
    const next: StoredInstance = {
      ...stored,
      networkPolicy: { defaultEgress: body.defaultEgress, rules: body.rules ?? [] },
    };
    await this.save(next);
    return jsonResponse(200, { ok: true });
  }

  async renewActivity(request: Request): Promise<Response> {
    const stored = await this.load();
    if (stored === undefined) {
      return errorResponse(404, "instance_not_found");
    }
    const body = await decodeBody(request, Schema.decodeUnknownExit(BridgeRenewActivityRequest));
    if (body === null) {
      return errorResponse(400, "invalid_renew_body");
    }
    const extendSeconds = body.extendSeconds ?? 300;
    const expiresAt = new Date(Date.now() + extendSeconds * 1000).toISOString();
    await this.save({ ...stored, expiresAt });
    const result: BridgeRenewActivityResult = { expiresAt, remainingSeconds: extendSeconds };
    return jsonResponse(200, result);
  }

  async destroy(): Promise<Response> {
    const stored = await this.load();
    if (stored === undefined) {
      // Delete is idempotent: a missing instance is already deleted.
      return jsonResponse(200, { ok: true });
    }
    const runtime = await this.ensureRuntime();
    if (runtime !== null) {
      await runtime.destroy().catch(() => {});
    }
    this.runtime = undefined;
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();
    await this.state.storage.delete("instance");
    return jsonResponse(200, { ok: true });
  }
}

interface BridgeFileWatchEventLike {
  readonly path: string;
  readonly kind: "created" | "modified" | "deleted";
  readonly at: string;
}

const safeJsonParse = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

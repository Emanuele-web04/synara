/**
 * Minimal ambient surface of the Cloudflare Workers runtime the bridge uses.
 *
 * The repo does not vendor `@cloudflare/workers-types`, so the bridge declares
 * only the primitives it touches (Durable Object storage, the WebSocket pair,
 * container/sandbox bindings) as plain interfaces. A real deployment swaps these
 * for the official types via wrangler; keeping them local lets the package
 * typecheck standalone in CI without a heavy worker-types dependency.
 *
 * @module cloudflareRuntime
 */

/** Web-standard WebSocket as exposed inside a Worker (subset). */
export interface WorkerWebSocket {
  accept(): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "message",
    listener: (event: { readonly data: string | ArrayBuffer }) => void,
  ): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: () => void): void;
}

export interface WorkerWebSocketPair {
  readonly 0: WorkerWebSocket;
  readonly 1: WorkerWebSocket;
}

/** Durable Object persistent key/value storage (subset). */
export interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(): Promise<Map<string, T>>;
}

export interface DurableObjectState {
  readonly storage: DurableObjectStorage;
  readonly id: { toString(): string };
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

/** A Durable Object stub addressable by id from the Worker entrypoint. */
export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): { toString(): string };
  get(id: { toString(): string }): DurableObjectStub;
}

/**
 * A spawned process inside a sandbox/container runtime. The bridge forwards its
 * collected exec output or streams its terminal bytes back over a WebSocket.
 */
export interface RuntimeExecHandle {
  readonly exitCode: Promise<number | null>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
}

export interface RuntimeTerminalHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
  readonly onData: (listener: (chunk: string) => void) => void;
  readonly onExit: (listener: (exitCode: number | null) => void) => void;
}

export interface RuntimeFileSystem {
  read(path: string): Promise<Uint8Array>;
  write(path: string, content: Uint8Array): Promise<void>;
}

/**
 * The lower-level runtime a Durable Object drives. `workspace` is the sandbox
 * SDK runtime (interactive, file/terminal capable). `container` is the raw
 * Containers runtime, kept service-oriented. A real binding implements this;
 * tests supply a fake.
 */
export interface SandboxRuntime {
  exec(input: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string | undefined;
    readonly env: Readonly<Record<string, string>>;
  }): Promise<RuntimeExecHandle>;
  openTerminal(input: {
    readonly command: string | null;
    readonly args: ReadonlyArray<string>;
    readonly cols: number;
    readonly rows: number;
    readonly cwd: string | undefined;
  }): Promise<RuntimeTerminalHandle>;
  readonly fs: RuntimeFileSystem;
  exposePort(input: { readonly port: number; readonly label: string | null }): Promise<string>;
  destroy(): Promise<void>;
}

/** Bindings the Worker is configured with (wrangler `[[durable_objects]]`, etc). */
export interface BridgeEnv {
  /** Shared bearer secret the Synara server authenticates with. */
  readonly BRIDGE_AUTH_TOKEN: string;
  readonly RUNTIME_INSTANCES: DurableObjectNamespace;
}

/** The runtime globals the production platform reads (the `WebSocketPair` ctor). */
export interface DurableObjectPlatformGlobals {
  readonly WebSocketPair: new () => WorkerWebSocketPair;
}

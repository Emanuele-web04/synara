/**
 * In-memory fakes for the bridge's Cloudflare-runtime dependencies.
 *
 * Lets the Durable Object run in a plain test process: an in-memory storage map,
 * an in-process WebSocket pair, and a `SandboxRuntime` whose exec/terminal/fs are
 * scripted. The fakes match the same interfaces a real binding implements, so the
 * DO's branching is exercised exactly as it would be on the Worker runtime.
 *
 * @module fakeSandboxRuntime
 */
import type {
  DurableObjectState,
  DurableObjectStorage,
  RuntimeExecHandle,
  RuntimeTerminalHandle,
  SandboxRuntime,
  WorkerWebSocket,
  WorkerWebSocketPair,
} from "./cloudflareRuntime.ts";

const stringStream = (text: string): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (text.length > 0) {
        controller.enqueue(encoder.encode(text));
      }
      controller.close();
    },
  });
};

export interface FakeExecScript {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number | null;
}

export interface FakeSandboxOptions {
  /** Keyed by command name; defaults to an empty success. */
  readonly execScripts?: Readonly<Record<string, FakeExecScript>>;
  readonly files?: Map<string, Uint8Array>;
}

export interface FakeTerminal extends RuntimeTerminalHandle {
  /** Push a chunk as if the runtime emitted terminal output. */
  readonly emit: (chunk: string) => void;
  /** Signal the runtime process exited. */
  readonly emitExit: (exitCode: number | null) => void;
  /** Inputs the client wrote, in order. */
  readonly writes: ReadonlyArray<string>;
  readonly closed: () => boolean;
}

export interface FakeSandboxRuntime extends SandboxRuntime {
  readonly lastTerminal: () => FakeTerminal | undefined;
  readonly destroyed: () => boolean;
}

export const makeFakeSandboxRuntime = (options: FakeSandboxOptions = {}): FakeSandboxRuntime => {
  const files = options.files ?? new Map<string, Uint8Array>();
  let terminal: FakeTerminal | undefined;
  let destroyed = false;

  return {
    exec: (input) => {
      const script = options.execScripts?.[input.command] ?? {};
      const handle: RuntimeExecHandle = {
        stdout: stringStream(script.stdout ?? ""),
        stderr: stringStream(script.stderr ?? ""),
        exitCode: Promise.resolve(script.exitCode === undefined ? 0 : script.exitCode),
      };
      return Promise.resolve(handle);
    },
    openTerminal: () => {
      const dataListeners: Array<(chunk: string) => void> = [];
      const exitListeners: Array<(exitCode: number | null) => void> = [];
      const writes: string[] = [];
      let closed = false;
      const fake: FakeTerminal = {
        write: (data) => {
          writes.push(data);
        },
        resize: () => {},
        close: () => {
          closed = true;
        },
        onData: (listener) => {
          dataListeners.push(listener);
        },
        onExit: (listener) => {
          exitListeners.push(listener);
        },
        emit: (chunk) => {
          for (const listener of dataListeners) {
            listener(chunk);
          }
        },
        emitExit: (exitCode) => {
          for (const listener of exitListeners) {
            listener(exitCode);
          }
        },
        writes,
        closed: () => closed,
      };
      terminal = fake;
      return Promise.resolve(fake);
    },
    fs: {
      read: (path) => {
        const bytes = files.get(path);
        if (bytes === undefined) {
          return Promise.reject(new Error(`no such file: ${path}`));
        }
        return Promise.resolve(bytes);
      },
      write: (path, content) => {
        files.set(path, content);
        return Promise.resolve();
      },
    },
    exposePort: (input) => Promise.resolve(`https://port-${input.port}.example.workers.dev`),
    destroy: () => {
      destroyed = true;
      return Promise.resolve();
    },
    lastTerminal: () => terminal,
    destroyed: () => destroyed,
  };
};

/** A storage-backed fake of the Durable Object state the DO depends on. */
export const makeFakeDurableObjectState = (instanceId: string): DurableObjectState => {
  const map = new Map<string, unknown>();
  const storage: DurableObjectStorage = {
    get: <T>(key: string) => Promise.resolve(map.get(key) as T | undefined),
    put: <T>(key: string, value: T) => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(map.delete(key)),
    list: <T>() => Promise.resolve(new Map(map as Map<string, T>)),
  };
  return {
    storage,
    id: { toString: () => instanceId },
    blockConcurrencyWhile: <T>(callback: () => Promise<T>) => callback(),
  };
};

/** A WebSocket end with test affordances: what it sent, received, and a deliver hook. */
export interface FakeWebSocketEnd extends WorkerWebSocket {
  readonly sent: ReadonlyArray<string>;
  readonly received: ReadonlyArray<string>;
  readonly deliver: (data: string) => void;
  peer?: FakeWebSocketEnd;
}

/** A two-ended in-process WebSocket pair mirroring the runtime's WebSocketPair. */
export const makeFakeWebSocketPair = (): WorkerWebSocketPair => {
  const makeEnd = (): FakeWebSocketEnd => {
    const sent: string[] = [];
    const received: string[] = [];
    const messageListeners: Array<(event: { readonly data: string | ArrayBuffer }) => void> = [];
    const closeListeners: Array<() => void> = [];
    const end: FakeWebSocketEnd = {
      sent,
      received,
      accept: () => {},
      send: (data: string) => {
        sent.push(data);
        end.peer?.deliver(data);
      },
      close: () => {
        for (const listener of closeListeners) {
          listener();
        }
      },
      deliver: (data: string) => {
        received.push(data);
        for (const listener of messageListeners) {
          listener({ data });
        }
      },
      addEventListener: (
        type: "message" | "close" | "error",
        listener: ((event: { readonly data: string | ArrayBuffer }) => void) & (() => void),
      ) => {
        if (type === "message") {
          messageListeners.push(listener);
        } else if (type === "close") {
          closeListeners.push(listener);
        }
      },
    };
    return end;
  };
  const client = makeEnd();
  const server = makeEnd();
  client.peer = server;
  server.peer = client;
  return { 0: client, 1: server };
};

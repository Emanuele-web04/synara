/**
 * realSandboxRuntime - adapts a `@cloudflare/sandbox` handle to the bridge's
 * local {@link SandboxRuntime} interface.
 *
 * The Durable Object drives every instance through `SandboxRuntime`; the fake
 * implements it for tests and this module implements it over the real SDK. It
 * resolves a sandbox per instance id from the bound DO namespace, then maps each
 * runtime operation onto the SDK:
 *
 *   - `exec`        -> `sandbox.exec(command, { cwd, env })`, output re-streamed
 *                      so the DO's `collectStream` sees the same `ReadableStream`
 *                      contract the fake produces.
 *   - `openTerminal`-> `sandbox.startProcess(command, { onOutput, onExit })`. The
 *                      SDK's managed process is the closest the Sandbox SDK gives
 *                      to a PTY; it streams output but exposes no stdin write in
 *                      this surface, so terminal writes are dropped (documented).
 *   - `fs`          -> `sandbox.readFile` / `sandbox.writeFile`.
 *   - `exposePort`  -> `sandbox.exposePort`, normalizing the `{ url } | string`
 *                      return.
 *   - `destroy`     -> `sandbox.destroy()`.
 *
 * Constructing this requires the SDK to be installed and the `SANDBOX` binding to
 * be present; both are deploy-time concerns the factory checks before calling in.
 *
 * @module realSandboxRuntime
 */
import type {
  RuntimeExecHandle,
  RuntimeFileSystem,
  RuntimeTerminalHandle,
  SandboxRuntime,
} from "./cloudflareRuntime.ts";
import type { CloudflareSandboxSdk, CloudflareSdkSandbox } from "./cloudflareSandboxSdk.ts";

const encoder = new TextEncoder();

/** Re-stream a collected string as a one-shot `ReadableStream<Uint8Array>`. */
const stringStream = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      if (text.length > 0) {
        controller.enqueue(encoder.encode(text));
      }
      controller.close();
    },
  });

/** Normalize the SDK's `readFile` return into raw bytes. */
const toBytes = (
  result: { readonly content: string | Uint8Array } | string | Uint8Array,
): Uint8Array => {
  const content = typeof result === "object" && "content" in result ? result.content : result;
  return typeof content === "string" ? encoder.encode(content) : content;
};

/** Normalize the SDK's `exposePort` return (`{ url } | string`) into a URL. */
const toUrl = (result: { readonly url: string } | string): string =>
  typeof result === "string" ? result : result.url;

const makeFileSystem = (sandbox: CloudflareSdkSandbox): RuntimeFileSystem => ({
  read: (path) => sandbox.readFile(path).then(toBytes),
  write: (path, content) => sandbox.writeFile(path, content).then(() => undefined),
});

/**
 * Build a `SandboxRuntime` over a resolved SDK sandbox. `sandbox` is already
 * scoped to one instance id, so the runtime is the per-instance boundary the DO
 * stores.
 */
export const makeRealSandboxRuntime = (sandbox: CloudflareSdkSandbox): SandboxRuntime => ({
  exec: async (input) => {
    const command = [input.command, ...input.args].join(" ");
    const result = await sandbox.exec(command, {
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      env: input.env,
    });
    const handle: RuntimeExecHandle = {
      stdout: stringStream(result.stdout),
      stderr: stringStream(result.stderr),
      exitCode: Promise.resolve(result.exitCode),
    };
    return handle;
  },
  openTerminal: async (input) => {
    const command = [input.command ?? "/bin/sh", ...input.args].join(" ");
    const dataListeners: Array<(chunk: string) => void> = [];
    const exitListeners: Array<(exitCode: number | null) => void> = [];
    const process = await sandbox.startProcess(command, {
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      onOutput: (_channel, data) => {
        for (const listener of dataListeners) {
          listener(data);
        }
      },
      onExit: (code) => {
        for (const listener of exitListeners) {
          listener(code);
        }
      },
    });
    const terminal: RuntimeTerminalHandle = {
      // The Sandbox SDK managed process exposes no stdin channel in this surface,
      // so interactive writes are dropped. Codex over the bridge terminal is
      // therefore output-only against the real runtime until the SDK exposes a
      // PTY; the local/fake paths remain fully interactive.
      write: () => {},
      resize: () => {},
      close: () => {
        void process.kill();
      },
      onData: (listener) => {
        dataListeners.push(listener);
      },
      onExit: (listener) => {
        exitListeners.push(listener);
      },
    };
    return terminal;
  },
  fs: makeFileSystem(sandbox),
  exposePort: (input) =>
    sandbox.exposePort(input.port, input.label === null ? {} : { name: input.label }).then(toUrl),
  destroy: () => sandbox.destroy().then(() => undefined),
});

/**
 * Resolve a real sandbox for an instance id from the bound SDK namespace and wrap
 * it as a `SandboxRuntime`. `binding` is the `env.SANDBOX` Durable Object
 * namespace the Sandbox SDK provides; `normalizeId` lets the SDK accept the
 * bridge's own instance ids.
 */
export const resolveRealSandboxRuntime = (
  sdk: CloudflareSandboxSdk,
  binding: unknown,
  instanceId: string,
): SandboxRuntime =>
  makeRealSandboxRuntime(sdk.getSandbox(binding, instanceId, { normalizeId: true }));

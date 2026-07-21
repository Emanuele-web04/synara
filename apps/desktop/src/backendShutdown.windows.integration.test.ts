import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as FsPromises from "node:fs/promises";
import * as Http from "node:http";
import * as Net from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DESKTOP_BACKEND_SHUTDOWN_PATH,
  startDesktopBackendShutdownRequest,
  stopWindowsBackendAndWait,
  type BackendShutdownProcess,
  type DesktopBackendShutdownRequestOutcome,
  type StartDesktopBackendShutdownRequest,
} from "./backendShutdown";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SERVER_DIRECTORY = Path.join(REPOSITORY_ROOT, "apps", "server");
const RUNTIME_STATE_RELATIVE_PATH = Path.join("userdata", "server-runtime.json");
const MAX_CAPTURED_CHILD_OUTPUT_BYTES = 64 * 1024;

function hasExited(child: ChildProcess.ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

class BoundedByteTail {
  readonly #chunks: Buffer[] = [];
  #byteLength = 0;

  get byteLength(): number {
    return this.#byteLength;
  }

  append(chunk: Uint8Array | string): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    if (bytes.byteLength >= MAX_CAPTURED_CHILD_OUTPUT_BYTES) {
      this.#chunks.length = 0;
      this.#chunks.push(
        Buffer.from(bytes.subarray(bytes.byteLength - MAX_CAPTURED_CHILD_OUTPUT_BYTES)),
      );
      this.#byteLength = MAX_CAPTURED_CHILD_OUTPUT_BYTES;
      return;
    }

    this.#chunks.push(bytes);
    this.#byteLength += bytes.byteLength;
    while (this.#byteLength > MAX_CAPTURED_CHILD_OUTPUT_BYTES) {
      const first = this.#chunks[0];
      if (!first) break;
      const excess = this.#byteLength - MAX_CAPTURED_CHILD_OUTPUT_BYTES;
      if (first.byteLength <= excess) {
        this.#chunks.shift();
        this.#byteLength -= first.byteLength;
      } else {
        this.#chunks[0] = first.subarray(excess);
        this.#byteLength -= excess;
      }
    }
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.#chunks, this.#byteLength);
  }

  toString(): string {
    return this.toBuffer().toString("utf8");
  }
}

class TestResources {
  readonly #children = new Set<ChildProcess.ChildProcess>();
  readonly #requests = new Set<Http.ClientRequest>();
  readonly #servers = new Set<Net.Server>();
  readonly #sockets = new Set<Net.Socket>();
  readonly #tempDirs = new Set<string>();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();

  async makeTempDir(prefix: string, parentDirectory = OS.tmpdir()): Promise<string> {
    const directory = await FsPromises.mkdtemp(Path.join(parentDirectory, prefix));
    this.#tempDirs.add(directory);
    return directory;
  }

  trackChild(child: ChildProcess.ChildProcess): ChildProcess.ChildProcess {
    this.#children.add(child);
    return child;
  }

  trackRequest(request: Http.ClientRequest): Http.ClientRequest {
    this.#requests.add(request);
    request.once("close", () => this.#requests.delete(request));
    request.once("socket", (socket) => this.trackSocket(socket));
    return request;
  }

  trackServer<T extends Net.Server>(server: T): T {
    this.#servers.add(server);
    server.on("connection", (socket) => this.trackSocket(socket));
    return server;
  }

  trackSocket<T extends Net.Socket>(socket: T): T {
    if (socket.destroyed) return socket;
    this.#sockets.add(socket);
    socket.once("close", () => this.#sockets.delete(socket));
    return socket;
  }

  #armTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      callback();
    }, delayMs);
    this.#timers.add(timer);
    return timer;
  }

  #clearTimer(timer: ReturnType<typeof setTimeout>): void {
    clearTimeout(timer);
    this.#timers.delete(timer);
  }

  async withTimeout<T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = this.#armTimer(
        () => reject(new Error(`Timed out after ${timeoutMs} ms: ${description}`)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) this.#clearTimer(timer);
    }
  }

  async delay(delayMs: number): Promise<void> {
    await new Promise<void>((resolve) => this.#armTimer(resolve, delayMs));
  }

  async waitFor(
    predicate: () => boolean | Promise<boolean>,
    timeoutMs: number,
    description: string,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        if (await predicate()) return;
      } catch (error) {
        lastError = error;
      }
      await this.delay(50);
    }
    const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
    throw new Error(`Timed out after ${timeoutMs} ms: ${description}.${detail}`);
  }

  async waitForChildExit(
    child: ChildProcess.ChildProcess,
    timeoutMs: number,
    description: string,
  ): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
    if (hasExited(child)) {
      return { code: child.exitCode, signal: child.signalCode };
    }

    return await new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = (): void => {
        child.off("exit", onExit);
        if (timer) this.#clearTimer(timer);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        cleanup();
        resolve({ code, signal });
      };
      child.once("exit", onExit);
      timer = this.#armTimer(() => {
        child.off("exit", onExit);
        reject(new Error(`Timed out after ${timeoutMs} ms: ${description}`));
      }, timeoutMs);

      if (hasExited(child)) {
        cleanup();
        resolve({ code: child.exitCode, signal: child.signalCode });
      }
    });
  }

  async closeServer(server: Net.Server, timeoutMs = 2_000): Promise<void> {
    if (!this.#servers.delete(server) || !server.listening) return;
    await this.withTimeout(
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
      timeoutMs,
      "close test-owned loopback server",
    );
  }

  async dispose(): Promise<void> {
    const cleanupErrors: unknown[] = [];

    for (const request of this.#requests) request.destroy();
    this.#requests.clear();
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();

    for (const server of [...this.#servers]) {
      try {
        if ("closeAllConnections" in server) {
          (server as Http.Server).closeAllConnections();
        }
        await this.closeServer(server);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    for (const child of this.#children) {
      try {
        if (!hasExited(child)) {
          child.kill("SIGTERM");
          await this.waitForChildExit(child, 2_000, "terminate test-owned direct child").catch(
            async () => {
              if (!hasExited(child)) child.kill("SIGKILL");
              await this.waitForChildExit(child, 2_000, "force terminate test-owned direct child");
            },
          );
        }
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    this.#children.clear();

    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();

    for (const directory of this.#tempDirs) {
      try {
        await FsPromises.rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 4,
          retryDelay: 50,
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    this.#tempDirs.clear();

    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Failed to clean Windows shutdown test resources");
    }
  }
}

interface CapturedChild {
  readonly child: ChildProcess.ChildProcess;
  readonly output: { stdout: string; stderr: string };
}

async function waitForSpawn(
  resources: TestResources,
  child: ChildProcess.ChildProcess,
  description: string,
): Promise<void> {
  if (child.pid !== undefined) return;
  await resources.withTimeout(
    new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.off("error", onError);
        resolve();
      };
      const onError = (error: Error): void => {
        child.off("spawn", onSpawn);
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    }),
    5_000,
    description,
  );
}

async function spawnCapturedChild(
  resources: TestResources,
  command: string,
  args: readonly string[],
  options: ChildProcess.SpawnOptions,
): Promise<CapturedChild> {
  const stdout = new BoundedByteTail();
  const stderr = new BoundedByteTail();
  const output = {
    get stdout(): string {
      return stdout.toString();
    },
    get stderr(): string {
      return stderr.toString();
    },
  };
  const child = resources.trackChild(
    ChildProcess.spawn(command, [...args], {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }),
  );
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout.append(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr.append(chunk);
  });
  child.on("error", (error) => {
    stderr.append(`${error.stack ?? error.message}\n`);
  });
  await waitForSpawn(resources, child, `spawn ${Path.basename(command)}`);
  return { child, output };
}

async function spawnIdleChild(resources: TestResources): Promise<ChildProcess.ChildProcess> {
  return (
    await spawnCapturedChild(
      resources,
      process.execPath,
      ["-e", "setInterval(() => {}, 1_000);"],
      {},
    )
  ).child;
}

async function reserveLoopbackPort(resources: TestResources): Promise<number> {
  const lease = resources.trackServer(Net.createServer());
  await resources.withTimeout(
    new Promise<void>((resolve, reject) => {
      lease.once("error", reject);
      lease.listen(0, "127.0.0.1", () => {
        lease.off("error", reject);
        resolve();
      });
    }),
    2_000,
    "reserve loopback port",
  );
  const address = lease.address();
  if (!address || typeof address === "string") {
    throw new Error("Loopback port reservation did not return a TCP address");
  }
  const port = address.port;
  await resources.closeServer(lease);
  return port;
}

async function listenHungLoopbackServer(
  resources: TestResources,
): Promise<{ readonly server: Http.Server; readonly origin: string }> {
  const server = resources.trackServer(
    Http.createServer((_request, _response) => {
      // Intentionally never acknowledge: production request cancellation must
      // release this socket when the child exits or the deadline is reached.
    }),
  );
  await resources.withTimeout(
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    }),
    2_000,
    "listen on hung loopback transport",
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Hung transport did not return a TCP address");
  }
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function requestJson(
  resources: TestResources,
  input: {
    readonly url: string;
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
  },
): Promise<{ readonly statusCode: number; readonly body: unknown }> {
  const requestHolder: { current: Http.ClientRequest | null } = { current: null };
  const response = new Promise<{ readonly statusCode: number; readonly body: unknown }>(
    (resolve, reject) => {
      const request = resources.trackRequest(
        Http.request(
          input.url,
          {
            method: input.method ?? "GET",
            agent: false,
            headers: { Connection: "close", ...input.headers },
          },
          (incoming) => {
            let body = "";
            incoming.setEncoding("utf8");
            incoming.on("data", (chunk: string) => {
              body += chunk;
              if (body.length > 64 * 1024) {
                incoming.destroy(new Error("Test HTTP response exceeded 64 KiB"));
              }
            });
            incoming.once("error", reject);
            incoming.once("end", () => {
              try {
                resolve({
                  statusCode: incoming.statusCode ?? 0,
                  body: body.length > 0 ? JSON.parse(body) : null,
                });
              } catch (error) {
                reject(error);
              }
            });
          },
        ),
      );
      requestHolder.current = request;
      request.once("error", reject);
      request.end();
    },
  );

  try {
    return await resources.withTimeout(
      response,
      input.timeoutMs ?? 2_000,
      `${input.method ?? "GET"} ${input.url}`,
    );
  } finally {
    requestHolder.current?.destroy();
  }
}

function makeIsolatedServerEnvironment(input: {
  readonly homeDir: string;
  readonly port: number;
  readonly shutdownToken: string;
}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "SYNARA_ALLOW_INSECURE_REMOTE",
    "SYNARA_AUTH_TOKEN",
    "SYNARA_HOME",
    "SYNARA_HOST",
    "SYNARA_MODE",
    "SYNARA_PORT",
    "SYNARA_PUBLIC_URL",
    "VITE_DEV_SERVER_URL",
  ]) {
    delete environment[key];
  }
  return {
    ...environment,
    SYNARA_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0",
    SYNARA_CLAUDE_KEEPALIVE: "0",
    SYNARA_DESKTOP_SHUTDOWN_TOKEN: input.shutdownToken,
    SYNARA_HOME: input.homeDir,
    SYNARA_HOST: "127.0.0.1",
    SYNARA_MODE: "desktop",
    SYNARA_NO_BROWSER: "1",
    SYNARA_PORT: String(input.port),
  };
}

async function launchRealServer(
  resources: TestResources,
  input: {
    readonly entrypoint: string;
    readonly homeDir: string;
    readonly port: number;
    readonly shutdownToken: string;
  },
): Promise<CapturedChild> {
  const nodeExecutable = process.versions.bun ? "node" : process.execPath;
  return await spawnCapturedChild(
    resources,
    nodeExecutable,
    [
      input.entrypoint,
      "--mode",
      "desktop",
      "--host",
      "127.0.0.1",
      "--port",
      String(input.port),
      "--home-dir",
      input.homeDir,
      "--no-browser",
      "--no-auto-bootstrap-project-from-cwd",
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: makeIsolatedServerEnvironment(input),
    },
  );
}

async function buildRealServerEntrypoint(resources: TestResources): Promise<string> {
  const buildDirectory = await resources.makeTempDir(
    ".vitest-windows-shutdown-build-",
    SERVER_DIRECTORY,
  );
  const bunExecutable = process.versions.bun ? process.execPath : "bun";
  const { child, output } = await spawnCapturedChild(
    resources,
    bunExecutable,
    ["tsdown", "--out-dir", buildDirectory, "--format", "esm"],
    { cwd: SERVER_DIRECTORY, env: { ...process.env } },
  );
  const exit = await resources.waitForChildExit(child, 60_000, "build real server entrypoint");
  if (exit.code !== 0) {
    throw new Error(
      `Real server build failed (code=${exit.code}, signal=${exit.signal}).\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
    );
  }
  const entrypoint = Path.join(buildDirectory, "index.mjs");
  if (!Fs.existsSync(entrypoint)) {
    throw new Error(
      `Real server build did not produce ${entrypoint}.\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
    );
  }
  return entrypoint;
}

const describeWindows = process.platform === "win32" ? describe : describe.skip;

describeWindows("Windows desktop backend shutdown integration", () => {
  it("retains only the final raw diagnostic bytes before decoding", () => {
    const tail = new BoundedByteTail();
    const input = Buffer.alloc(MAX_CAPTURED_CHILD_OUTPUT_BYTES + 9);
    for (let index = 0; index < input.byteLength; index += 1) {
      input[index] = index % 251;
    }

    tail.append(input);

    expect(tail.byteLength).toBe(MAX_CAPTURED_CHILD_OUTPUT_BYTES);
    expect(tail.toBuffer()).toEqual(input.subarray(9));
  });

  it("authenticates a real server, deduplicates shutdown, drains its runtime, and clears its finalizer artifact", async () => {
    const resources = new TestResources();
    try {
      const homeDir = await resources.makeTempDir("synara-windows-shutdown-");
      const port = await reserveLoopbackPort(resources);
      const shutdownToken = Crypto.randomBytes(32).toString("hex");
      const runtimeStatePath = Path.join(homeDir, RUNTIME_STATE_RELATIVE_PATH);
      const origin = `http://127.0.0.1:${port}`;
      const entrypoint = await buildRealServerEntrypoint(resources);
      const { child, output } = await launchRealServer(resources, {
        entrypoint,
        homeDir,
        port,
        shutdownToken,
      });

      await resources.waitFor(
        async () => {
          if (hasExited(child)) return true;
          const health = await requestJson(resources, {
            url: `${origin}/health`,
            timeoutMs: 1_000,
          });
          return (
            health.statusCode === 200 &&
            typeof health.body === "object" &&
            health.body !== null &&
            "startupReady" in health.body &&
            health.body.startupReady === true
          );
        },
        60_000,
        "real server readiness",
      );
      if (hasExited(child)) {
        throw new Error(
          `Real server exited before readiness (code=${child.exitCode}, signal=${child.signalCode}).\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
        );
      }

      expect(Fs.existsSync(runtimeStatePath)).toBe(true);
      const runtimeState = JSON.parse(await FsPromises.readFile(runtimeStatePath, "utf8")) as {
        readonly pid: number;
        readonly origin: string;
      };
      expect(runtimeState).toMatchObject({ pid: child.pid, origin });

      const rejected = await requestJson(resources, {
        url: `${origin}${DESKTOP_BACKEND_SHUTDOWN_PATH}`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${Crypto.randomBytes(32).toString("hex")}`,
          "Content-Length": "0",
        },
      });
      expect(rejected.statusCode).toBe(401);
      expect(hasExited(child)).toBe(false);
      expect(Fs.existsSync(runtimeStatePath)).toBe(true);

      let forceCalls = 0;
      const firstShutdown = stopWindowsBackendAndWait({
        child: child as BackendShutdownProcess,
        backendHttpUrl: origin,
        shutdownToken,
        forceKillDelayMs: 8_000,
        timeoutMs: 10_000,
        forceTerminate: (ownedChild) => {
          forceCalls += 1;
          ownedChild.kill("SIGTERM");
        },
      });
      const duplicateShutdown = stopWindowsBackendAndWait({
        child: child as BackendShutdownProcess,
        backendHttpUrl: origin,
        shutdownToken,
        forceKillDelayMs: 8_000,
        timeoutMs: 10_000,
        forceTerminate: (ownedChild) => {
          forceCalls += 1;
          ownedChild.kill("SIGTERM");
        },
      });

      expect(duplicateShutdown).toBe(firstShutdown);
      expect(Fs.existsSync(runtimeStatePath)).toBe(true);
      await expect(
        resources.withTimeout(firstShutdown, 15_000, "graceful real-server shutdown"),
      ).resolves.toEqual({ type: "exited", forced: false });
      expect(forceCalls).toBe(0);
      expect(hasExited(child)).toBe(true);
      if (child.exitCode !== 0) {
        throw new Error(
          `Real server drained but exited with code ${child.exitCode}.\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
        );
      }
      expect(Fs.existsSync(runtimeStatePath)).toBe(false);
    } finally {
      await resources.dispose();
    }
  }, 90_000);

  it("cancels a hung shutdown transport and force-terminates its test-owned child once", async () => {
    const resources = new TestResources();
    try {
      const { origin } = await listenHungLoopbackServer(resources);
      const child = await spawnIdleChild(resources);
      let forceCalls = 0;
      let requestOutcome: Promise<DesktopBackendShutdownRequestOutcome> | null = null;
      const startRequest: StartDesktopBackendShutdownRequest = (input) => {
        const pending = startDesktopBackendShutdownRequest(input);
        requestOutcome = pending.outcome;
        return pending;
      };

      const shutdown = stopWindowsBackendAndWait({
        child: child as BackendShutdownProcess,
        backendHttpUrl: origin,
        shutdownToken: Crypto.randomBytes(32).toString("hex"),
        forceKillDelayMs: 150,
        timeoutMs: 2_000,
        startRequest,
        forceTerminate: (ownedChild) => {
          forceCalls += 1;
          ownedChild.kill("SIGTERM");
        },
      });

      await expect(
        resources.withTimeout(shutdown, 3_000, "hung transport fallback"),
      ).resolves.toEqual({ type: "exited", forced: true });
      expect(requestOutcome).not.toBeNull();
      await expect(requestOutcome!).resolves.toEqual({ type: "cancelled" });
      expect(forceCalls).toBe(1);
      await resources.delay(250);
      expect(forceCalls).toBe(1);
    } finally {
      await resources.dispose();
    }
  }, 10_000);

  it("bounds an unavailable transport with one direct-child force fallback", async () => {
    const resources = new TestResources();
    try {
      const unavailablePort = await reserveLoopbackPort(resources);
      const origin = `http://127.0.0.1:${unavailablePort}`;
      const shutdownToken = Crypto.randomBytes(32).toString("hex");
      const probe = startDesktopBackendShutdownRequest({
        backendHttpUrl: origin,
        shutdownToken,
      });
      await expect(
        resources.withTimeout(probe.outcome, 2_000, "unavailable transport refusal"),
      ).resolves.toEqual({ type: "error" });
      probe.cancel();

      const child = await spawnIdleChild(resources);
      let forceCalls = 0;
      const shutdown = stopWindowsBackendAndWait({
        child: child as BackendShutdownProcess,
        backendHttpUrl: origin,
        shutdownToken,
        forceKillDelayMs: 150,
        timeoutMs: 2_000,
        forceTerminate: (ownedChild) => {
          forceCalls += 1;
          ownedChild.kill("SIGTERM");
        },
      });

      await expect(
        resources.withTimeout(shutdown, 3_000, "unavailable transport fallback"),
      ).resolves.toEqual({ type: "exited", forced: true });
      expect(forceCalls).toBe(1);
      await resources.delay(250);
      expect(forceCalls).toBe(1);
    } finally {
      await resources.dispose();
    }
  }, 10_000);

  it("does not request or force an already-exited test-owned child", async () => {
    const resources = new TestResources();
    try {
      const { child } = await spawnCapturedChild(
        resources,
        process.execPath,
        ["-e", "process.exit(0);"],
        {},
      );
      await resources.waitForChildExit(child, 2_000, "short-lived direct child exit");
      let requestCalls = 0;
      let forceCalls = 0;

      await expect(
        stopWindowsBackendAndWait({
          child: child as BackendShutdownProcess,
          backendHttpUrl: "http://127.0.0.1:1",
          shutdownToken: Crypto.randomBytes(32).toString("hex"),
          forceKillDelayMs: 150,
          timeoutMs: 2_000,
          startRequest: () => {
            requestCalls += 1;
            throw new Error("already-exited child must not create a request");
          },
          forceTerminate: () => {
            forceCalls += 1;
          },
        }),
      ).resolves.toEqual({ type: "already-exited", forced: false });
      expect(requestCalls).toBe(0);
      expect(forceCalls).toBe(0);
    } finally {
      await resources.dispose();
    }
  });
});

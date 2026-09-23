import { AsyncResource } from "node:async_hooks";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

import { asarUnpackedPath } from "../platform/asarUnpackedPath.ts";

import {
  JsonRpcStdioFramer,
  JsonRpcStdioRequestRegistry,
  JsonRpcStdioTransportError,
  JsonRpcStdioWriter,
} from "@synara/shared/jsonrpc-stdio";

import type { ComputerRect, ComputerWindow } from "@synara/contracts";
import type { AtspiClientSize, AtspiWindowTree } from "./atspiTreeTargeting.ts";
import { assertDesktopOperationActive, desktopOperationSignal } from "./DesktopOperationQueue.ts";

const HELPER_READ_TREE_METHOD = "read-tree";
const HELPER_SET_TEXT_METHOD = "set-text";
const HELPER_VALIDATE_NODE_METHOD = "validate-node";
const HELPER_PROBE_METHOD = "probe";
/**
 * The wire contract `atspi_helper.py` speaks (its `PROTOCOL_VERSION`). Every
 * request carries it and every reply names it, so a helper from another build
 * — a stale file, a `SYNARA_ATSPI_HELPER` override — is refused as unavailable
 * instead of having its trees misread.
 */
export const ATSPI_HELPER_PROTOCOL = 2;
/** The helper could not reach the accessibility bus (it answers; it does not crash). */
const HELPER_BUS_UNAVAILABLE_ERROR = -32010;
/** The helper refused this client's protocol version. */
const HELPER_PROTOCOL_MISMATCH_ERROR = -32011;
const HELPER_MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** How much of the helper's stderr to keep for the diagnostic when it dies. */
const HELPER_STDERR_TAIL_CHARS = 4 * 1024;
const HELPER_REQUEST_TIMEOUT_MS = 10_000;
const HELPER_RECONNECT_BASE_DELAY_MS = 250;
const HELPER_RECONNECT_MAX_DELAY_MS = 5_000;
/** How long a SIGTERM'd helper has to exit before dispose escalates to SIGKILL. */
const ATSPI_KILL_GRACE_MS = 1_000;
/**
 * How long "unavailable" holds before a request may look again, doubling up to
 * the cap. A machine that has no accessibility bus now may get one (a session
 * whose launcher starts late), but rediscovering its absence on every read is
 * what turned a crashing helper into a respawn storm.
 */
const UNAVAILABLE_RETRY_BASE_MS = 30_000;
const UNAVAILABLE_RETRY_MAX_MS = 5 * 60_000;

/**
 * A semantic text write addressed the same way the tree was read: the window
 * descriptor the helper matched, plus the child-index path it emitted. The
 * helper re-resolves both on every call, so nothing depends on the process that
 * produced the tree still being alive.
 */
export interface AtspiTextWrite {
  readonly window: ComputerWindow;
  readonly path: readonly number[];
  readonly text: string;
  /** Checked against the live node so tree drift cannot redirect the write. */
  readonly role?: string;
  readonly label?: string | null;
}

/**
 * The helper answering "no", as opposed to the helper being gone.
 *
 * A JSON-RPC error envelope is a well-formed response from a live process: a
 * window that closed while its tree was being walked, an unknown method on an
 * older helper build. Killing the process over one turns every routine
 * semantic-target miss into a respawn and ratchets the reconnect backoff to five
 * seconds, so the next few perception requests are slow for no reason.
 */
class AtspiHelperMethodError extends Error {
  readonly code: number | undefined;

  constructor(message: string, code?: number) {
    super(message);
    this.name = "AtspiHelperMethodError";
    this.code = code;
  }
}

/**
 * The helper cannot run on this machine at all: no `python3`, PyGObject
 * without the AT-SPI bindings, a helper that died before it ever answered.
 * Distinct from a transient failure so callers can stop retrying and show
 * the diagnostic instead.
 */
export class AtspiHelperUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "AtspiHelperUnavailableError";
  }
}

/** A node a tree read addressed, checked against the live application at dispatch. */
export interface AtspiNodeCheck {
  readonly window: ComputerWindow;
  readonly path: readonly number[];
  readonly role: string;
  readonly label: string | null;
}

/**
 * The live node still is the one the tree named: its extents now, in the
 * window's coordinates, and the window's client size to place them with.
 */
export type AtspiNodeValidation =
  | {
      readonly ok: true;
      readonly frame: ComputerRect;
      readonly clientSize: AtspiClientSize;
      readonly showing: boolean | null;
    }
  | { readonly ok: false; readonly reason: string };

export interface AtspiReadOptions {
  /**
   * How old a tree the helper may answer from its event-validated cache. The
   * helper serves one only when the application has sent no event since the
   * walk; the caller bounds the age further by what it did itself, because
   * its own input is the change most likely to have arrived without one yet.
   */
  readonly maxAgeMs?: number;
}

export interface AtspiTreeReader {
  /**
   * Trees for the windows the helper could resolve. A window missing from the
   * result was not found, was ambiguous, or was cut off by the helper's own
   * deadline; the caller derives per-window completeness from which ids came
   * back and from each tree's own `status`.
   */
  readonly readTrees: (
    windows: readonly ComputerWindow[],
    options?: AtspiReadOptions,
  ) => Promise<readonly AtspiWindowTree[]>;
  /** Resolves `false` when the helper refused the write; rejects when it failed. */
  readonly setText: (write: AtspiTextWrite) => Promise<boolean>;
  /**
   * Re-reads one node a tree read named — identity by role and label, and
   * fresh extents — so an action can use a tree without walking it again.
   * Absent on readers that cannot address nodes.
   */
  readonly validateNode?: (check: AtspiNodeCheck) => Promise<AtspiNodeValidation>;
  /**
   * Start the helper once and ask whether it can read trees. Resolves either
   * way; `unavailableReason` carries the outcome. Calling it again re-probes a
   * reader that latched unavailable, which is how a machine that gained
   * `python-gi` or an accessibility bus mid-session recovers on the next
   * connect.
   */
  readonly probe?: () => Promise<void>;
  /**
   * Why the reader latched unavailable, or `undefined` while it is usable,
   * unprobed, or due for another look.
   */
  readonly unavailableReason?: () => string | undefined;
  /**
   * Stops the helper process without disposing the reader: the next request
   * starts a fresh one. For a backend letting an idle desktop go.
   */
  readonly release?: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}

export interface AtspiHelperClientOptions {
  readonly pythonPath?: string;
  readonly scriptPath?: string;
  readonly requestTimeoutMs?: number;
  /**
   * Environment overrides for the helper process. The accessibility bus is
   * reached through the session bus, so a nested session hands its own
   * `DBUS_SESSION_BUS_ADDRESS` here to keep perception inside that session.
   */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * `false`: the helper gets exactly `env`, none of this server's own
   * environment underneath it. A nested session needs that: merged over the
   * server's environment, a host `AT_SPI_BUS_ADDRESS` would point the helper
   * at the human's accessibility bus, whatever session bus `env` names.
   */
  readonly inheritEnv?: boolean;
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
  ) => ChildProcessWithoutNullStreams;
  /** Wall clock for the unavailable latch's retry window; tests move it by hand. */
  readonly now?: () => number;
}

/** The helper process's environment; see `AtspiHelperClientOptions.inheritEnv`. */
export function atspiHelperEnvironment(
  options: Pick<AtspiHelperClientOptions, "env" | "inheritEnv">,
  serverEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...(options.inheritEnv === false ? {} : serverEnv),
    ...options.env,
    PYTHONUNBUFFERED: "1",
  };
}

type RequestPriority = "high" | "normal";

interface QueuedRequest {
  readonly start: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Supervises the small PyGObject AT-SPI reader. The helper keeps only caches
 * it can rebuild: a crashed process loses one perception request and the next
 * request starts a fresh process after a bounded backoff.
 */
export class AtspiHelperClient implements AtspiTreeReader {
  private process: ChildProcessWithoutNullStreams | null = null;
  private framer: JsonRpcStdioFramer | null = null;
  private writer: JsonRpcStdioWriter | null = null;
  private registry: JsonRpcStdioRequestRegistry | null = null;
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;
  private reconnectFailures = 0;
  private startPromise: Promise<void> | null = null;
  private disposed = false;
  /**
   * The helper answers one request at a time, so requests wait here. Writes,
   * node checks and one-window reads go first: a semantic write or a scoped
   * read must not sit behind a desktop-wide walk it has nothing to do with.
   */
  private readonly lanes: Record<RequestPriority, QueuedRequest[]> = { high: [], normal: [] };
  private requestActive = false;
  private queuedRequests = 0;
  /** Set by the first well-formed reply from any helper process. */
  private answered = false;
  /** Set by the first tree a helper process delivered. */
  private treeAnswered = false;
  /**
   * A helper that cannot read trees here. Every read would otherwise pay a
   * spawn and up to five seconds of backoff to rediscover the same missing
   * interpreter or bus, with its traceback drained unread. Held until
   * `retryAt`, after which the next request probes again.
   */
  private unavailable: {
    readonly summary: string;
    readonly stderr: StderrTail;
    readonly retryAt: number;
  } | null = null;
  private unavailableLatches = 0;
  private probePromise: Promise<void> | null = null;

  constructor(private readonly options: AtspiHelperClientOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? HELPER_REQUEST_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  async readTrees(
    windows: readonly ComputerWindow[],
    options: AtspiReadOptions = {},
  ): Promise<readonly AtspiWindowTree[]> {
    if (windows.length === 0) return [];
    const result = await this.request(
      HELPER_READ_TREE_METHOD,
      {
        protocol: ATSPI_HELPER_PROTOCOL,
        windows: windows.map(helperWindow),
        ...(options.maxAgeMs !== undefined && options.maxAgeMs > 0
          ? { maxAgeMs: Math.round(options.maxAgeMs) }
          : {}),
      },
      windows.length === 1 ? "high" : "normal",
    );
    if (!isRecord(result) || !Array.isArray(result.trees)) {
      throw new Error("AT-SPI helper returned no tree list.");
    }
    this.assertProtocol(result);
    this.treeAnswered = true;
    this.unavailableLatches = 0;
    // A reply flagged `partial` is the helper stopping at its own deadline
    // with the trees it had: a well-formed answer from a healthy process.
    return result.trees.filter(isAtspiWindowTree);
  }

  async setText(write: AtspiTextWrite): Promise<boolean> {
    let result: unknown;
    try {
      result = await this.request(
        HELPER_SET_TEXT_METHOD,
        {
          protocol: ATSPI_HELPER_PROTOCOL,
          window: helperWindow(write.window),
          path: [...write.path],
          text: write.text,
          ...(write.role ? { role: write.role } : {}),
          ...(write.label !== undefined ? { label: write.label ?? "" } : {}),
        },
        "high",
      );
    } catch (error) {
      // No helper at all is a refusal, not a failure: the caller falls back
      // to keystrokes the same way it does for a control that is not editable.
      if (error instanceof AtspiHelperUnavailableError) return false;
      throw error;
    }
    return isRecord(result) && result.ok === true;
  }

  async validateNode(check: AtspiNodeCheck): Promise<AtspiNodeValidation> {
    let result: unknown;
    try {
      result = await this.request(
        HELPER_VALIDATE_NODE_METHOD,
        {
          protocol: ATSPI_HELPER_PROTOCOL,
          window: helperWindow(check.window),
          path: [...check.path],
          role: check.role,
          label: check.label ?? "",
        },
        "high",
      );
    } catch (error) {
      if (error instanceof AtspiHelperUnavailableError) return { ok: false, reason: "unavailable" };
      throw error;
    }
    if (!isRecord(result)) return { ok: false, reason: "no-reply" };
    if (result.ok === true && isRect(result.frame) && isClientSize(result.clientSize)) {
      return {
        ok: true,
        frame: result.frame as ComputerRect,
        clientSize: result.clientSize as AtspiClientSize,
        showing: typeof result.showing === "boolean" ? result.showing : null,
      };
    }
    return { ok: false, reason: typeof result.reason === "string" ? result.reason : "refused" };
  }

  probe(): Promise<void> {
    if (this.probePromise) return this.probePromise;
    // An explicit probe is a fresh start: the latch, its retry window and the
    // backoff a dead helper left behind all go, and the outcome replaces them.
    this.unavailable = null;
    this.unavailableLatches = 0;
    this.reconnectFailures = 0;
    this.probePromise = this.request(HELPER_PROBE_METHOD, {}, "high")
      .then(
        (result) => this.noteProbe(result),
        (error: unknown) => this.noteProbeFailure(error),
      )
      .finally(() => {
        this.probePromise = null;
      });
    return this.probePromise;
  }

  unavailableReason(): string | undefined {
    if (!this.unavailable || this.now() >= this.unavailable.retryAt) return undefined;
    return this.unavailableText();
  }

  private unavailableText(): string {
    if (!this.unavailable) return "AT-SPI helper unavailable";
    const stderr = this.unavailable.stderr.text();
    return stderr ? `${this.unavailable.summary}\n${stderr}` : this.unavailable.summary;
  }

  private noteProbe(result: unknown): void {
    if (!isRecord(result) || result.protocol !== ATSPI_HELPER_PROTOCOL) {
      this.latchUnavailable(protocolMismatch(isRecord(result) ? result.protocol : undefined));
      return;
    }
    if (result.atspi === false) {
      const reason = typeof result.reason === "string" ? result.reason : "unknown reason";
      this.latchUnavailable(`AT-SPI is unavailable: ${reason}`);
      return;
    }
    // The retry window keeps growing until a tree actually arrives: a helper
    // that probes fine and then dies on every walk is still broken.
    this.unavailable = null;
  }

  private noteProbeFailure(error: unknown): void {
    // A latch set on the way here (a helper that died, a bus it could not
    // reach) already says more than the probe's own error does.
    if (this.unavailable) return;
    this.latchUnavailable(
      `AT-SPI helper probe failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  private latchUnavailable(summary: string, stderr = new StderrTail()): void {
    const delay = Math.min(
      UNAVAILABLE_RETRY_MAX_MS,
      UNAVAILABLE_RETRY_BASE_MS * 2 ** this.unavailableLatches,
    );
    this.unavailableLatches += 1;
    this.unavailable = { summary, stderr, retryAt: this.now() + delay };
  }

  private assertProtocol(result: Record<string, unknown>): void {
    if (result.protocol === ATSPI_HELPER_PROTOCOL) return;
    this.latchUnavailable(protocolMismatch(result.protocol));
    throw new AtspiHelperUnavailableError(this.unavailableText());
  }

  async release(): Promise<void> {
    if (this.disposed || this.process === null) return;
    // Detached first, like every kill of ours, so its exit is not read as a
    // crash; and it is not a failure, so the next start carries no backoff.
    this.resetProcess(new Error("AT-SPI helper released while the desktop is idle."));
    this.reconnectFailures = 0;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const process = this.process;
    this.process = null;
    this.framer?.close();
    this.writer?.close(new Error("AT-SPI helper disposed"));
    this.registry?.processExited(new Error("AT-SPI helper disposed"));
    this.framer = null;
    this.writer = null;
    this.registry = null;
    for (const queued of [...this.lanes.high.splice(0), ...this.lanes.normal.splice(0)]) {
      queued.reject(new Error("AT-SPI helper is disposed."));
    }
    if (process) terminateHelper(process);
    await this.startPromise?.catch(() => undefined);
    this.startPromise = null;
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    priority: RequestPriority,
  ): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("AT-SPI helper is disposed."));
    if (this.queuedRequests >= 64)
      return Promise.reject(new Error("AT-SPI request queue is full."));
    this.queuedRequests += 1;
    const signal = desktopOperationSignal();
    // Run in the caller's async context, not whichever request happened to
    // finish before it: the operation checks below read that context.
    const start = AsyncResource.bind(() => {
      signal?.throwIfAborted();
      return this.requestNow(method, params);
    });
    return new Promise<unknown>((resolve, reject) => {
      this.lanes[priority].push({ start, resolve, reject });
      this.pumpRequests();
    }).finally(() => {
      this.queuedRequests -= 1;
    });
  }

  private pumpRequests(): void {
    if (this.requestActive) return;
    const next = this.lanes.high.shift() ?? this.lanes.normal.shift();
    if (!next) return;
    this.requestActive = true;
    void (async () => {
      try {
        next.resolve(await next.start());
      } catch (error) {
        next.reject(error);
      } finally {
        this.requestActive = false;
        this.pumpRequests();
      }
    })();
  }

  private async requestNow(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.disposed) throw new Error("AT-SPI helper is disposed.");
    if (this.unavailable && method !== HELPER_PROBE_METHOD) {
      if (this.now() < this.unavailable.retryAt) {
        throw new AtspiHelperUnavailableError(this.unavailableText());
      }
      // The retry window passed: one probe decides whether this request runs.
      try {
        this.noteProbe(await this.transportRequest(HELPER_PROBE_METHOD, {}));
      } catch (error) {
        if (!(this.unavailable && this.now() < this.unavailable.retryAt)) {
          this.latchUnavailable(
            `AT-SPI helper probe failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (this.unavailable) throw new AtspiHelperUnavailableError(this.unavailableText());
    }
    return await this.transportRequest(method, params);
  }

  private async transportRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    await this.ensureStarted();
    // Restart backoff can outlive the operation's permission or cancellation.
    // Check again before sending a write to the replacement helper.
    assertDesktopOperationActive();
    const registry = this.registry;
    const writer = this.writer;
    if (!registry || !writer) throw new Error("AT-SPI helper transport is unavailable.");
    try {
      const result = await registry.request(
        method,
        params,
        (message) => writer.write(message),
        this.requestTimeoutMs,
      );
      this.reconnectFailures = 0;
      return result;
    } catch (error) {
      // The peer answered, so the transport is healthy and the backoff is
      // cleared exactly as it would be for a success. Only the request failed.
      if (error instanceof AtspiHelperMethodError) {
        this.reconnectFailures = 0;
        if (
          error.code === HELPER_BUS_UNAVAILABLE_ERROR ||
          error.code === HELPER_PROTOCOL_MISMATCH_ERROR
        ) {
          // Nothing about this machine changes by asking again right away.
          this.latchUnavailable(
            error.code === HELPER_PROTOCOL_MISMATCH_ERROR
              ? protocolMismatch(undefined, error.message)
              : `AT-SPI is unavailable: ${error.message}`,
          );
          throw new AtspiHelperUnavailableError(this.unavailableText());
        }
        throw error;
      }
      this.resetProcess(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.process !== null && this.registry !== null && this.writer !== null) return;
    if (this.startPromise) return this.startPromise;

    const delay =
      this.reconnectFailures === 0
        ? 0
        : Math.min(
            HELPER_RECONNECT_MAX_DELAY_MS,
            HELPER_RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectFailures,
          );
    const wait =
      delay === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delay);
            // A pending reconnect is not work the process should be kept
            // alive for; the next request re-arms it.
            timer.unref?.();
          });
    this.startPromise = wait
      .then(() => {
        if (this.disposed) return;
        this.startProcess();
      })
      .finally(() => {
        this.startPromise = null;
      });
    await this.startPromise;
  }

  private startProcess(): void {
    const command = this.options.pythonPath ?? process.env.SYNARA_ATSPI_PYTHON ?? "python3";
    const scriptPath =
      this.options.scriptPath ??
      process.env.SYNARA_ATSPI_HELPER ??
      asarUnpackedPath(fileURLToPath(new URL("./atspi_helper.py", import.meta.url)));
    const spawnProcess =
      this.options.spawnProcess ??
      ((spawnCommand, args) =>
        spawn(spawnCommand, args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: atspiHelperEnvironment(this.options),
        }));
    const child = spawnProcess(command, ["-u", scriptPath]);
    this.process = child;
    this.framer = new JsonRpcStdioFramer(HELPER_MAX_FRAME_BYTES);
    this.writer = new JsonRpcStdioWriter(child.stdin, HELPER_MAX_FRAME_BYTES);
    this.registry = new JsonRpcStdioRequestRegistry({
      requestTimeoutMs: this.requestTimeoutMs,
      includeJsonRpcVersion: true,
      // Only a well-formed response envelope carrying an error reaches this
      // hook; timeouts and transport failures come through their own paths. The
      // distinct type is how `request` tells the two apart.
      responseError: ({ error }) =>
        new AtspiHelperMethodError(
          typeof error.message === "string" ? error.message : "AT-SPI helper request failed",
          typeof error.code === "number" ? error.code : undefined,
        ),
    });
    this.registry.processStarted();
    const stderr = new StderrTail();
    // Streams can fail after a write has completed or after the helper was
    // replaced. Keep these listeners attached so late errors are contained.
    const onTransportError = (error: Error) => {
      if (this.process === child) this.resetProcess(error);
    };
    child.on("error", (error: Error) => {
      // A spawn failure (no interpreter on PATH, not executable) before any
      // reply: nothing about this machine will change by retrying.
      if (this.process === child && !this.answered) {
        this.latchUnavailable(`AT-SPI helper could not be started: ${error.message}`, stderr);
      }
      onTransportError(error);
    });
    child.stdin.on("error", onTransportError);
    child.stdout.on("error", onTransportError);
    child.stderr.on("error", onTransportError);
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.process === child) this.consumeStdout(chunk);
    });
    // Collected regardless of which process is current: the diagnostic for a
    // helper that died is whatever it printed last, which may still be
    // arriving when the exit event fires.
    child.stderr.on("data", (chunk: Buffer | string) => stderr.push(chunk));
    child.on("exit", (code, signal) => {
      if (this.process !== child) return;
      const summary = `AT-SPI helper exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
      // A non-zero exit before the first reply is an interpreter that could
      // not run the script at all — a missing module, an unreadable file. A
      // signal before the first tree is a helper the desktop kills, the way
      // libatspi aborted on an unreachable bus: respawning it for every read
      // is a crash loop with a core dump each time. Our own kills never get
      // here — they detach the process first.
      if (
        (!this.answered && typeof code === "number" && code !== 0) ||
        (!this.treeAnswered && signal !== null)
      ) {
        this.latchUnavailable(summary, stderr);
      }
      const trace = stderr.text();
      this.resetProcess(new Error(trace ? `${summary}\n${trace}` : summary));
    });
  }

  private consumeStdout(chunk: Buffer): void {
    const framer = this.framer;
    if (!framer) return;
    try {
      for (const line of framer.push(chunk)) {
        const message = parseJson(line);
        if (!isRecord(message) || !("id" in message)) continue;
        const id = message.id;
        if (typeof id !== "number" && typeof id !== "string") continue;
        const error = isRecord(message.error) ? message.error : undefined;
        this.answered = true;
        this.registry?.handleResponse({
          id,
          result: message.result,
          ...(error
            ? {
                error: {
                  ...(typeof error.code === "number" ? { code: error.code } : {}),
                  ...(typeof error.message === "string" ? { message: error.message } : {}),
                },
              }
            : {}),
        });
      }
    } catch (error) {
      if (error instanceof JsonRpcStdioTransportError) this.resetProcess(error);
    }
  }

  private resetProcess(error: Error): void {
    const child = this.process;
    this.process = null;
    this.framer?.close();
    this.writer?.close(error);
    this.registry?.processExited(error);
    this.framer = null;
    this.writer = null;
    this.registry = null;
    this.reconnectFailures = Math.min(this.reconnectFailures + 1, 5);
    if (child) terminateHelper(child);
  }
}

/** The last few kilobytes of a stream, for a diagnostic. */
class StderrTail {
  private tail = "";

  push(chunk: Buffer | string): void {
    this.tail = `${this.tail}${chunk.toString()}`.slice(-HELPER_STDERR_TAIL_CHARS);
  }

  text(): string {
    return this.tail.trim();
  }
}

/** Timed-out helpers need the same bounded shutdown as an explicitly disposed one. */
function terminateHelper(child: ChildProcessWithoutNullStreams): void {
  child.stdin.end();
  if (child.exitCode != null || child.signalCode != null) return;
  const survivor = setTimeout(() => child.kill("SIGKILL"), ATSPI_KILL_GRACE_MS);
  survivor.unref?.();
  child.once("exit", () => clearTimeout(survivor));
  if (!child.killed) child.kill("SIGTERM");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The window descriptor the helper matches against the live AT-SPI desktop. */
function helperWindow(window: ComputerWindow): Record<string, unknown> {
  return {
    id: window.id,
    title: window.title,
    appName: window.appName ?? null,
    pid: window.pid ?? null,
    bounds: window.bounds,
  };
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function isAtspiWindowTree(value: unknown): value is AtspiWindowTree {
  if (!isRecord(value)) return false;
  return (
    typeof value.windowId === "string" &&
    isClientSize(value.clientSize) &&
    isAtspiNode(value.root) &&
    isAtspiWindowTreeStatus(value.status) &&
    (value.truncated === undefined || typeof value.truncated === "boolean") &&
    (value.reason === undefined || typeof value.reason === "string")
  );
}

function isClientSize(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.width === "number" &&
    Number.isFinite(value.width) &&
    value.width > 0 &&
    typeof value.height === "number" &&
    Number.isFinite(value.height) &&
    value.height > 0
  );
}

function isAtspiWindowTreeStatus(value: unknown): boolean {
  return (
    value === undefined || value === "complete" || value === "partial" || value === "unavailable"
  );
}

function isAtspiNode(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.role === "string" &&
    (value.label === null || typeof value.label === "string") &&
    (value.value === null || typeof value.value === "string") &&
    (value.description === null || typeof value.description === "string") &&
    isRect(value.frame) &&
    (value.i === undefined || isChildIndex(value.i)) &&
    (value.editable === undefined || typeof value.editable === "boolean") &&
    (value.truncated === undefined || typeof value.truncated === "boolean") &&
    Array.isArray(value.children) &&
    value.children.every(isAtspiNode)
  );
}

function isChildIndex(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function protocolMismatch(protocol: unknown, detail?: string): string {
  return (
    `The AT-SPI helper speaks protocol ${JSON.stringify(protocol ?? "unknown")}; this server ` +
    `needs ${ATSPI_HELPER_PROTOCOL}. The helper script does not match this build` +
    (detail ? `: ${detail}` : ".")
  );
}

function isRect(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y) &&
    typeof value.width === "number" &&
    Number.isFinite(value.width) &&
    value.width >= 0 &&
    typeof value.height === "number" &&
    Number.isFinite(value.height) &&
    value.height >= 0
  );
}

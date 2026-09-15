import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { readdirSync, rmSync, statSync } from "node:fs";
import { access, chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  cuaRequest,
  CUA_DRIVER_VERSION,
  CUA_NATIVE_REVISION,
  CUA_SETUP_TIMEOUT_MS,
  CUA_READ_TOOLS,
  CUA_ACTION_TOOLS,
  type CuaReply,
  type CuaToolResult,
  type CuaComputerTask,
  type CuaPreviewTarget,
  parseCuaComputerTask,
  cuaComputerTaskKey,
} from "@synara/shared/cuaDriverProtocol";
import type { ComputerFrameTapHost } from "./computerFrameTap";

interface Generation {
  child: ChildProcess;
  socket: string;
  session: string;
  exited: Promise<void>;
  didExit: boolean;
  retired: boolean;
  cancellationReady: boolean;
  inputInFlight: boolean;
  /** Stays set once any action tool was dispatched to this generation, so a
   * driver that wedges before ever receiving input stays distinguishable
   * from one that may still hold OS input it never confirmed releasing. */
  inputEverDispatched: boolean;
  retirement?: Promise<void>;
}

interface HostPermissions {
  accessibility: boolean;
  screenRecording: boolean;
}

function permissionsChanged(a: HostPermissions, b: HostPermissions): boolean {
  return a.accessibility !== b.accessibility || a.screenRecording !== b.screenRecording;
}

const log = (message: string) => console.info(`[desktop-cua] ${message}`);

/**
 * Match names for a launch_app prime: the agent names an app ("Calculator")
 * or a bundle id ("com.apple.Calculator") while the daemon reports process
 * names ("Calculator"). Compare lowercased, with the bundle tail as a second
 * candidate so both spellings resolve without a bundle registry.
 */
function launchAppMatchNames(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const args = input as Record<string, unknown>;
  const names: string[] = [];
  if (typeof args.name === "string" && args.name.length > 0) names.push(args.name.toLowerCase());
  if (typeof args.bundle_id === "string" && args.bundle_id.length > 0) {
    names.push(args.bundle_id.toLowerCase());
    const tail = args.bundle_id.split(".").pop();
    if (tail) names.push(tail.toLowerCase());
  }
  return names;
}

/**
 * A daemon whose host died by SIGKILL never sees retire() and its own stdin
 * watchdog can leave the process wedged: the tokio runtime exits but the
 * AppKit overlay keeps the process alive, leaking a ghost overlay window and
 * its socket dir. Kill any embedded daemon whose recorded host pid is gone.
 * A recycled pid reads as alive and is left alone — safe direction.
 */
export function sweepOrphanedCuaDrivers(): void {
  if (process.platform !== "darwin") return;
  let listing: string;
  try {
    listing = execFileSync("ps", ["-axo", "pid,args"], { encoding: "utf8" });
  } catch {
    return;
  }
  const liveSocketDirs = new Set<string>();
  for (const line of listing.split("\n")) {
    if (!/cua-driver\s+serve\s+--embedded/.test(line)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (!pid || pid === process.pid) continue;
    const socketDir = line.match(/--socket\s+(\S+)\//)?.[1];
    // The dir of every still-running daemon is protected whether or not its
    // env can be read: a transient ps failure or a daemon without the host
    // marker is skipped below but stays alive, and reaping its socket dir
    // would sever every new connection to it.
    if (socketDir) liveSocketDirs.add(socketDir);
    let env: string;
    try {
      env = execFileSync("ps", ["eww", "-p", String(pid), "-o", "command"], {
        encoding: "utf8",
      });
    } catch {
      continue;
    }
    const hostPid = Number(env.match(/CUA_DRIVER_EMBEDDED_HOST_PID=(\d+)/)?.[1]);
    if (!hostPid) continue;
    try {
      process.kill(hostPid, 0);
      continue;
    } catch {
      // Host is gone: the daemon is an orphan.
    }
    try {
      process.kill(pid, "SIGKILL");
      log(`killed orphaned cua-driver pid=${pid} (host pid ${hostPid} gone)`);
    } catch {
      // Already gone.
    }
  }
  // Every generation mkdtemps a synara-cua-* dir (host.sock, driver socket,
  // state) and nothing reaps it on a crash — hundreds accumulate over days.
  // A dir survives only while a live daemon still references its socket, or
  // while it is young enough to belong to a spawn still in flight.
  let entries: string[];
  try {
    entries = readdirSync(tmpdir());
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.startsWith("synara-cua-")) continue;
    const dir = join(tmpdir(), entry);
    if (liveSocketDirs.has(dir)) continue;
    try {
      if (now - statSync(dir).mtimeMs < 30_000) continue;
      rmSync(dir, { recursive: true, force: true });
      log(`removed stale driver directory ${entry}`);
    } catch {
      // Already gone or unreadable.
    }
  }
}

const DRIVER_SESSION_DEATH_CODES = new Set([
  "session_ended",
  "session-expired",
  "session_expired",
  "unknown_session",
  "session_not_found",
]);

/**
 * The native driver ended this session (restart, timeout, or eviction) while
 * the host still held it: every later call with the same id fails the same
 * way, and no model-side retry can heal it. The driver confirms nothing was
 * dispatched, so retiring the generation and starting fresh once is replay-safe.
 */
function isDriverSessionDeath(reply: CuaReply): boolean {
  if (!reply.ok) {
    // A transport rejection carries the same verdict in `error`: retired only
    // when dispatch is ruled out, so input that may have landed is never
    // replayed.
    return (
      reply.effect !== "dispatched-unknown" &&
      typeof reply.error === "string" &&
      reply.error.includes("has ended") &&
      reply.error.includes("start_session")
    );
  }
  const result = reply.result;
  if (!result?.isError) return false;
  const code = result.structuredContent?.code;
  if (typeof code === "string" && DRIVER_SESSION_DEATH_CODES.has(code)) return true;
  const texts: string[] = [];
  for (const part of result.content ?? []) {
    if (part && typeof part.text === "string") texts.push(part.text);
  }
  const message = result.structuredContent?.message;
  if (typeof message === "string") texts.push(message);
  const joined = texts.join("\n");
  return joined.includes("has ended") && joined.includes("start_session");
}

/** Lives in Electron's main process. Only this GUI process spawns the native
 * daemon: a bundle-id string sent by a standalone server cannot confer TCC. */
export class CuaDriverHost {
  private directory = "";
  private server: Server | undefined;
  private generation: Generation | undefined;
  private starting: Promise<Generation> | undefined;
  private retiring: Promise<void> = Promise.resolve();
  private closed = false;
  private suspended = false;
  private readonly desktopPauses = new Set<string>();
  private desktopObservationRequired = false;
  private desktopEpoch = 0;
  private operations: Promise<void> = Promise.resolve();
  private stopping: Promise<void> = Promise.resolve();
  private epoch = 0;
  private readonly connections = new Set<Socket>();
  private permissions: HostPermissions | undefined;
  private readonly pendingPermissionChecks = new Set<() => void>();
  private readonly userStoppedTasks = new Set<string>();
  private readonly endedFrameTasks = new Set<string>();
  private frameTapTask: CuaComputerTask | undefined;
  constructor(
    private readonly options: {
      binaryPath: string;
      bundleId: string;
      capability: string;
      setup: () => Promise<void>;
      checkPermissions?: () => Promise<HostPermissions>;
      releaseHeldInput?: () => Promise<void>;
      /** Bound on each post-handshake startup call; defaults to 5s. */
      startupTimeoutMs?: number;
      normalizeOverview?: (result: CuaToolResult) => CuaToolResult;
      frameTap?: ComputerFrameTapHost;
    },
  ) {}

  async listen(): Promise<string> {
    this.directory = await mkdtemp(join(tmpdir(), "synara-cua-"));
    await chmod(this.directory, 0o700);
    const endpoint = join(this.directory, "host.sock");
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, resolve);
    });
    await chmod(endpoint, 0o600);
    return endpoint;
  }

  private accept(socket: Socket): void {
    this.connections.add(socket);
    socket.once("close", () => this.connections.delete(socket));
    socket.on("error", () => undefined);
    const chunks: Buffer[] = [];
    let bytes = 0;
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        socket.destroy();
        return;
      }
      const end = chunk.indexOf(10);
      chunks.push(end < 0 ? chunk : chunk.subarray(0, end));
      if (end < 0) return;
      socket.removeAllListeners("data");
      let request: Record<string, unknown>;
      try {
        request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!request || typeof request !== "object" || Array.isArray(request))
          throw new Error("Invalid request");
      } catch {
        socket.destroy();
        return;
      }
      void this.handle(request, socket).then(
        (result) =>
          socket.end(JSON.stringify({ ...result, desktopEpoch: this.desktopEpoch }) + "\n"),
        (error) =>
          socket.end(
            JSON.stringify({
              ok: false,
              error: String(error),
              effect: "not-dispatched",
              desktopEpoch: this.desktopEpoch,
            }) + "\n",
          ),
      );
    });
    socket.setTimeout(60_000, () => socket.destroy());
  }

  private async handle(request: Record<string, unknown>, connection: Socket): Promise<CuaReply> {
    const supplied =
      typeof request.capability === "string" ? Buffer.from(request.capability) : Buffer.alloc(0);
    const expected = Buffer.from(this.options.capability);
    if (
      expected.length < 32 ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new Error("Computer host authority is required.");
    if (request.method === "stop") {
      await this.stop();
      return { ok: true };
    }
    const task = parseCuaComputerTask(request.task);
    if (request.task !== undefined && !task) throw new Error("Invalid computer task attribution.");
    if (request.method === "end_task") {
      if (!task) throw new Error("Computer task attribution is required.");
      this.rememberTask(this.endedFrameTasks, task);
      if (
        this.frameTapTask?.threadId === task.threadId &&
        (task.turnId === undefined || task.turnId === this.frameTapTask.turnId)
      ) {
        this.rememberTask(this.endedFrameTasks, this.frameTapTask);
        this.frameTapTask = undefined;
      }
      await this.options.frameTap?.endTask(task);
      return { ok: true };
    }
    if (this.closed) throw new Error("Computer host is closed.");
    if (this.suspended)
      throw new Error("Computer host is suspended while the backend is stopping.");
    if (request.method === "probe") {
      try {
        await access(this.options.binaryPath);
      } catch {
        return {
          ok: false,
          error:
            "Cua Driver is not bundled. Run the local provisioning script and relaunch Synara.",
        };
      }
      return { ok: true, result: { version: CUA_DRIVER_VERSION, running: !!this.generation } };
    }
    if (request.method === "setup") {
      connection.setTimeout(CUA_SETUP_TIMEOUT_MS);
      await this.stop();
      if (connection.destroyed || this.closed || this.suspended)
        return { ok: false, error: "Cancelled before permission setup.", effect: "not-dispatched" };
      await this.options.setup();
      return { ok: true };
    }
    const name = request.name;
    if (
      request.method !== "call" ||
      typeof name !== "string" ||
      (!CUA_READ_TOOLS.has(name) && !CUA_ACTION_TOOLS.has(name))
    )
      throw new Error("Unsupported computer host request.");
    if (this.desktopPauses.size > 0) return this.desktopPauseReply();
    // Observations and input share one native session. A pane capture must not
    // race input or turn a harmless concurrent read into a driver restart.
    const previous = this.operations;
    const stopping = this.stopping;
    const epoch = this.epoch;
    const operation = (async () => {
      await previous;
      await stopping;
      if (this.closed || this.suspended || connection.destroyed || epoch !== this.epoch)
        return {
          ok: false,
          error: "Cancelled before dispatch.",
          effect: "not-dispatched",
        } as const;
      if (this.desktopPauses.size > 0) return this.desktopPauseReply();
      if (task && this.userStoppedTasks.has(cuaComputerTaskKey(task))) {
        return {
          ok: false,
          error: "The user stopped computer use for this turn. Do not retry actions.",
          effect: "not-dispatched" as const,
        };
      }
      if (name === "check_permissions" && this.options.checkPermissions) {
        // AppSnap's short-lived helper avoids the embedded daemon's TCC cache.
        // This remains an authenticated, read-only host operation: prompt args
        // from tools never reach the permission request path.
        const check = this.options.checkPermissions;
        const cancelled = () =>
          this.closed || this.suspended || connection.destroyed || epoch !== this.epoch;
        let permissions = await this.checkPermissions(connection, check);
        if (!permissions || cancelled())
          return {
            ok: false,
            error: "Cancelled before permission check completed.",
            effect: "not-dispatched",
          } as const;
        if (this.permissions && permissionsChanged(this.permissions, permissions)) {
          // A single helper probe can read TCC mid-transition and report a
          // phantom change the next probe reverts. Arming on it deadlocks the
          // desktop: every action runs check_permissions first, so a flapping
          // helper re-arms the gate after each observation clears it. Only a
          // confirmed second read counts as a real change.
          const confirmed = await this.checkPermissions(connection, check);
          if (!confirmed || cancelled())
            return {
              ok: false,
              error: "Cancelled before permission check completed.",
              effect: "not-dispatched",
            } as const;
          permissions = confirmed;
        }
        if (this.permissions && permissionsChanged(this.permissions, permissions)) {
          this.epoch += 1;
          this.desktopEpoch += 1;
          this.desktopObservationRequired = true;
          log(
            `permission state changed accessibility ${this.permissions.accessibility} -> ${permissions.accessibility}, ` +
              `screen_recording ${this.permissions.screenRecording} -> ${permissions.screenRecording}; requiring fresh desktop observation`,
          );
          // Already inside the operation queue: stop() would wait for itself.
          // Retire directly, preserving its native cleanup acknowledgement.
          if (this.generation) await this.retire(this.generation);
        }
        this.permissions = permissions;
        return {
          ok: true,
          result: {
            structuredContent: {
              accessibility: permissions.accessibility,
              screen_recording: permissions.screenRecording,
              source: {
                attribution: "host",
                host_bundle_id: this.options.bundleId,
                probe: "appsnap-permission-helper",
              },
            },
          },
        };
      }
      if (
        this.desktopObservationRequired &&
        (CUA_ACTION_TOOLS.has(name) || name === "check_input_ready")
      ) {
        log(`refused ${name}: fresh desktop observation still required`);
        return this.desktopPauseReply();
      }
      if (task && (request.modelObservation === true || CUA_ACTION_TOOLS.has(name)))
        this.frameTapTask = task;
      const reply = await this.call(
        name,
        request.args,
        connection,
        request.modelObservation === true,
      );
      // Frame tap updates carry no frames through this queue: they only point
      // the dedicated helper channel at the task's window target.
      if (
        task &&
        !this.endedFrameTasks.has(cuaComputerTaskKey(task)) &&
        !this.userStoppedTasks.has(cuaComputerTaskKey(task)) &&
        epoch === this.epoch &&
        !connection.destroyed &&
        reply.ok &&
        !reply.result?.isError &&
        (request.modelObservation === true || CUA_ACTION_TOOLS.has(name))
      ) {
        const target = this.frameTapTarget(task, request.args);
        if (target) {
          try {
            this.options.frameTap?.update(target);
          } catch (error) {
            log(`computer frame tap update failed: ${String(error)}`);
          }
        } else if (name === "launch_app") {
          // launch_app carries no window (bundle/name only), so the tap would
          // otherwise sit out the whole cold start until the first
          // window-attributed call. Resolve the launched app's main window
          // off the reply path: the agent's launch already returned.
          void this.primeTapAfterLaunch(task, request.args, connection, epoch).catch(
            (error: unknown) => log(`computer frame tap launch prime failed: ${String(error)}`),
          );
        }
      }
      return reply;
    })();
    this.operations = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private checkPermissions(
    connection: Socket,
    check: () => Promise<HostPermissions>,
  ): Promise<HostPermissions | undefined> {
    // Stop and disconnected status readers must release native admission even
    // while a different feature owns a macOS prompt in the shared helper queue.
    // Abandon only this wait; do not cancel AppSnap's permission request.
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.pendingPermissionChecks.delete(cancel);
        connection.removeListener("close", cancel);
      };
      const cancel = () => {
        cleanup();
        resolve(undefined);
      };
      this.pendingPermissionChecks.add(cancel);
      connection.once("close", cancel);
      void Promise.resolve()
        .then(check)
        .then(
          (permissions) => {
            cleanup();
            resolve(permissions);
          },
          (error) => {
            cleanup();
            reject(error);
          },
        );
    });
  }

  private async call(
    name: string,
    input: unknown,
    connection: Socket,
    modelObservation: boolean,
  ): Promise<CuaReply> {
    let generation: Generation | undefined;
    let dispatched = false;
    const admittedEpoch = this.epoch;
    const admittedDesktopEpoch = this.desktopEpoch;
    // A failed cleanup remains the admission barrier. Consume this detached
    // rejection here; the next call/stop reports the retained failure.
    const abort = () => {
      if (generation) void this.retire(generation).catch(() => undefined);
    };
    connection.once("close", abort);
    try {
      let reply: CuaReply | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        generation = await this.ensureStarted();
        if (
          connection.destroyed ||
          generation.retired ||
          admittedEpoch !== this.epoch ||
          this.desktopPauses.size > 0
        )
          throw new Error("Cancelled before dispatch.");
        const args = input && typeof input === "object" && !Array.isArray(input) ? input : {};
        dispatched = true;
        generation.inputInFlight = CUA_ACTION_TOOLS.has(name);
        generation.inputEverDispatched ||= generation.inputInFlight;
        const attemptReply = await cuaRequest<CuaReply>(
          generation.socket,
          {
            method: "call",
            name,
            args: { ...args, session: generation.session },
          },
          { timeoutMs: 30_000, mutation: CUA_ACTION_TOOLS.has(name) },
        );
        generation.inputInFlight = false;
        if (attempt === 0 && isDriverSessionDeath(attemptReply)) {
          await this.retire(generation).catch(() => undefined);
          continue;
        }
        reply = attemptReply;
        break;
      }
      if (!reply || !generation) throw new Error("Cancelled before dispatch.");
      if (admittedDesktopEpoch !== this.desktopEpoch && CUA_READ_TOOLS.has(name)) {
        log(
          `refused stale ${name} read (desktop epoch ${admittedDesktopEpoch} -> ${this.desktopEpoch})`,
        );
        return this.desktopPauseReply();
      }
      if (
        modelObservation &&
        !connection.destroyed &&
        !generation.retired &&
        !generation.didExit &&
        admittedEpoch === this.epoch &&
        this.desktopPauses.size === 0 &&
        (name === "get_window_state" || name === "get_desktop_state") &&
        reply.ok &&
        !reply.result?.isError &&
        reply.result !== undefined &&
        reply.result.structuredContent?.screenshot_frame_valid !== false &&
        (reply.result.content?.some((part) => part.type === "image" && !!part.data) ||
          Array.isArray(reply.result.structuredContent?.elements))
      ) {
        this.desktopObservationRequired = false;
        log(`fresh desktop observation via ${name}; input gate cleared`);
      }
      if (name === "get_desktop_state" && reply.result && this.options.normalizeOverview)
        this.options.normalizeOverview(reply.result);
      return reply;
    } catch (error) {
      let detail = String(error);
      if (generation) {
        try {
          await this.retire(generation);
        } catch (cleanupError) {
          detail += `; ${String(cleanupError)}`;
        }
      }
      return {
        ok: false,
        error: detail,
        effect: dispatched && CUA_ACTION_TOOLS.has(name) ? "dispatched-unknown" : "not-dispatched",
      };
    } finally {
      connection.removeListener("close", abort);
    }
  }

  private ensureStarted(): Promise<Generation> {
    if (this.starting) return this.starting;
    const start = async () => {
      await this.retiring;
      if (this.closed) throw new Error("Computer host is closed.");
      if (this.generation && !this.generation.retired && !this.generation.didExit)
        return this.generation;
      if (this.generation) await this.retire(this.generation);
      await access(this.options.binaryPath);
      const endpoint = join(this.directory, `driver-${randomUUID().slice(0, 8)}.sock`);
      const child = spawn(
        this.options.binaryPath,
        ["serve", "--embedded", "--socket", endpoint, "--compact-cursor", "--idle-hide-ms", "900"],
        {
          stdio: ["pipe", "ignore", "pipe"],
          env: {
            ...process.env,
            CUA_DRIVER_EMBEDDED: "1",
            CUA_DRIVER_HOST_BUNDLE_ID: this.options.bundleId,
            CUA_DRIVER_PERMISSION_MODE: "standard",
            CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
            // Upgrade lifecycle belongs to the app, not the managed driver —
            // the self-update check is an upstream network call plus a stderr
            // banner on every spawn.
            CUA_DRIVER_RS_UPDATE_CHECK: "0",
            // Owned by the GUI host, not supplied through public tool arguments.
            // The native driver applies this only after foreground input cleanup.
            SYNARA_CUA_FOREGROUND_OBSERVATION_MS: "100",
            // The detector watches for windows/foreground changes the action
            // spawned — typically within ~200ms — not for the target's own
            // content. 350ms keeps the wildcard focus-steal suppressor armed
            // past the typical case while saving ~650ms per background action
            // over the default one-second window.
            SYNARA_CUA_BACKGROUND_OBSERVATION_MS: "350",
            CUA_DRIVER_PARENT_LIVENESS_STDIN: "1",
            CUA_DRIVER_EMBEDDED_HOST_PID: String(process.pid),
            CUA_DRIVER_RS_HOME: join(this.directory, "state"),
          },
        },
      );
      // Keep a short stderr tail so a wedged or panicking daemon is diagnosable
      // after the fact; payloads may be private, so only lines are kept and only
      // surfaced on exit, never streamed.
      const stderrTail: string[] = [];
      child.stderr?.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split("\n")) {
          if (!line.trim()) continue;
          stderrTail.push(line.slice(0, 200));
          if (stderrTail.length > 20) stderrTail.shift();
        }
      });
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.once("error", () => resolve());
      });
      void exited.then(() => {
        if (stderrTail.length) log(`driver stderr tail: ${stderrTail.join(" | ")}`);
      });
      const generation: Generation = {
        child,
        socket: endpoint,
        session: `synara-${randomUUID()}`,
        exited,
        didExit: false,
        retired: false,
        cancellationReady: false,
        inputInFlight: false,
        inputEverDispatched: false,
      };
      this.generation = generation;
      void exited.then(() => {
        generation.didExit = true;
      });
      try {
        let metadata: CuaReply | undefined;
        for (let attempt = 0; attempt < 80; attempt++) {
          if (generation.retired || generation.didExit)
            throw new Error("Cua Driver stopped during startup.");
          try {
            metadata = await cuaRequest<CuaReply>(
              endpoint,
              { method: "metadata" },
              { timeoutMs: 200 },
            );
            break;
          } catch {
            await delay(50);
          }
        }
        if (
          !metadata?.ok ||
          metadata.result?.driver_version !== CUA_DRIVER_VERSION ||
          metadata.result?.synara_native_revision !== CUA_NATIVE_REVISION ||
          metadata.result?.embedded !== true ||
          metadata.result?.pid !== child.pid
        )
          throw new Error("Cua Driver identity/version/native revision handshake failed.");
        if (generation.retired || generation.didExit)
          throw new Error("Cua Driver stopped during startup.");
        generation.cancellationReady = true;
        await chmod(endpoint, 0o600);
        if (generation.retired || generation.didExit)
          throw new Error("Cua Driver stopped during startup.");
        const startupTimeoutMs = this.options.startupTimeoutMs ?? 5_000;
        const session = await cuaRequest<CuaReply>(
          endpoint,
          {
            method: "call",
            name: "start_session",
            args: { session: generation.session },
          },
          { timeoutMs: startupTimeoutMs },
        );
        if (!session.ok || session.result?.isError)
          throw new Error("Cua session initialization failed.");
        // Configure once per native generation, not before each input. The
        // cursor remains visible without making travel distance delay the action.
        const motion = await cuaRequest<CuaReply>(
          endpoint,
          {
            method: "call",
            name: "set_agent_cursor_motion",
            args: {
              session: generation.session,
              glide_duration_ms: 100,
              dwell_after_click_ms: 0,
            },
          },
          { timeoutMs: startupTimeoutMs },
        );
        if (!motion.ok || motion.result?.isError)
          throw new Error("Cua cursor initialization failed.");
        return generation;
      } catch (error) {
        await this.retire(generation);
        throw error;
      }
    };
    this.starting = start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async terminate(generation: Generation): Promise<void> {
    if (generation.didExit) return;
    // End the lifetime pipe too: Tokio's blocking stdin reader otherwise
    // keeps the native runtime alive during graceful shutdown.
    generation.child.stdin?.end();
    const graceful = setTimeout(() => generation.child.kill("SIGTERM"), 500);
    const force = setTimeout(() => generation.child.kill("SIGKILL"), 1_500);
    try {
      // Every retire branch that reaches terminate() has already proven the
      // generation cannot hold OS input, so even a kernel-wedged process
      // that survives SIGKILL must not hang the whole retirement chain.
      await Promise.race([generation.exited, delay(4_000)]);
    } finally {
      clearTimeout(graceful);
      clearTimeout(force);
    }
    if (!generation.didExit)
      log(
        `driver pid=${generation.child.pid} did not exit after SIGKILL; releasing the generation anyway`,
      );
  }

  private retire(generation: Generation): Promise<void> {
    if (generation.retirement) return generation.retirement;
    generation.retired = true;
    this.retiring = this.retiring.then(async () => {
      // Captured up front: the flag clears on confirmed cleanup, and a driver
      // exit event can land after the dead socket already broke the request —
      // either ordering leaves the OS believing a synthetic button or modifier
      // is held, and a user click landing under it feels dead system-wide.
      const inputUncertain = generation.inputInFlight;
      const releaseHeldInput = async () => {
        if (!inputUncertain || !this.options.releaseHeldInput) return false;
        try {
          await this.options.releaseHeldInput();
          log("released held input left by the dead driver generation");
          return true;
        } catch (error) {
          log(`held-input release failed: ${String(error)}`);
          return false;
        }
      };
      if (generation.didExit && generation.inputInFlight) {
        // A confirmed release makes the desktop provably clean again — the
        // generation clears and the next request spawns a replacement. Without
        // a confirmed release the held state is unprovable: keep the dead
        // generation referenced so every later request fails closed instead
        // of a replacement compounding the uncertainty.
        if (await releaseHeldInput()) {
          if (this.generation === generation) this.generation = undefined;
          await rm(generation.socket, { force: true });
          return;
        }
        throw new Error(
          "Cua Driver exited during input without confirming native cleanup. Computer admission is closed.",
        );
      }
      if (!generation.didExit && generation.cancellationReady) {
        let cleanupConfirmed = false;
        try {
          const reply = await cuaRequest<CuaReply>(
            generation.socket,
            {
              method: "cancel_input",
              args: { expected_pid: generation.child.pid },
            },
            { timeoutMs: 5_000 },
          );
          const cleanup = reply.result;
          cleanupConfirmed =
            reply.ok === true &&
            cleanup?.pid === generation.child.pid &&
            cleanup?.input_admission_closed === true &&
            cleanup?.cleanup_complete === true &&
            cleanup?.pending_input === 0;
        } catch {
          cleanupConfirmed = false;
        }
        if (!cleanupConfirmed) {
          // A dead socket can outrun the exit event: the process may already
          // be gone, in which case this is the crash path, not a live driver
          // withholding its acknowledgement. Give the exit a short grace.
          if (!generation.didExit) await Promise.race([generation.exited, delay(500)]);
          if (generation.didExit) {
            // No input in flight means nothing is uncertain — the dead
            // generation clears outright. With input in flight, only a
            // confirmed release clears it.
            const cleared = !generation.inputInFlight || (await releaseHeldInput());
            if (cleared) {
              if (this.generation === generation) this.generation = undefined;
              await rm(generation.socket, { force: true });
              return;
            }
            throw new Error(
              "Cua Driver exited during input without confirming native cleanup. Computer admission is closed.",
            );
          }
          if (!generation.inputEverDispatched) {
            // The driver only ever holds OS input in response to a dispatched
            // action, and none ever reached this generation — a wedge during
            // startup or between reads cannot leave input held. Terminate and
            // clear so the next request spawns a replacement instead of
            // closing admission for the host's lifetime.
            await this.terminate(generation);
            if (this.generation === generation) this.generation = undefined;
            await rm(generation.socket, { force: true });
            return;
          }
          // The process is genuinely alive and its acknowledgement could not
          // be trusted — the in-gate releases may never have run, so the
          // helper posts the OS-level ups before admission closes on this
          // uncertainty. The driver is not killed or replaced.
          await releaseHeldInput();
          throw new Error(
            "Cua Driver did not confirm native input cleanup. Computer admission is closed; the driver was not killed or replaced.",
          );
        }
        generation.inputInFlight = false;
      }
      // Before the validated handshake no action can have been dispatched.
      // Otherwise the authenticated acknowledgement above covers all matching
      // releases and native context restoration before termination is allowed.
      await this.terminate(generation);
      if (this.generation === generation) this.generation = undefined;
      await rm(generation.socket, { force: true });
    });
    generation.retirement = this.retiring;
    // The rejection belongs to whoever retired this generation — not to the
    // sequencing chain. A cleanup that throws ("admission closed") must not
    // leave `this.retiring` rejected forever, or one mid-input daemon death
    // would refuse every generation the host ever tries to spawn.
    this.retiring = this.retiring.then(
      () => undefined,
      () => undefined,
    );
    return generation.retirement;
  }

  stop(): Promise<void> {
    this.epoch += 1;
    // A read dispatched before a stop must not be admitted as a fresh
    // observation afterwards: bumping the desktop epoch turns that silent
    // clear-void into a visible stale-read refusal.
    this.desktopEpoch += 1;
    for (const cancel of this.pendingPermissionChecks) cancel();
    const admitted = this.operations;
    const frameTapStopped = this.options.frameTap?.stop();
    // Same discipline as `stopping` below: the stop caller sees the failure
    // through the returned promise, never through an unhandled rejection.
    void frameTapStopped?.catch(() => undefined);
    const stopping = this.stopping.then(async () => {
      if (this.generation) await this.retire(this.generation);
      await this.starting?.catch(() => undefined);
      if (this.generation) await this.retire(this.generation);
      await admitted;
      await this.retiring;
      await frameTapStopped;
    });
    // Same discipline as `retiring`: the caller sees the failure but the
    // chain must not — one admission-closed stop must not refuse every
    // later stop() for the host's lifetime.
    this.stopping = stopping.then(
      () => undefined,
      () => undefined,
    );
    return stopping;
  }

  /** User Stop revokes the turn without changing OS grants. */
  stopTaskByUser(task: CuaComputerTask): Promise<void> {
    this.rememberTask(this.userStoppedTasks, task);
    return this.stop();
  }

  private rememberTask(set: Set<string>, task: CuaComputerTask): void {
    set.add(cuaComputerTaskKey(task));
    while (set.size > 256) set.delete(set.values().next().value!);
  }

  /** The native call args carry the agent's window target; task attribution
   * alone does not say which window the tap should stream. */
  private frameTapTarget(task: CuaComputerTask, input: unknown): CuaPreviewTarget | undefined {
    if (!input || typeof input !== "object") return undefined;
    const args = input as Record<string, unknown>;
    if (
      typeof args.pid !== "number" ||
      !Number.isSafeInteger(args.pid) ||
      args.pid <= 0 ||
      args.pid > 0x7fffffff ||
      typeof args.window_id !== "number" ||
      !Number.isSafeInteger(args.window_id) ||
      args.window_id <= 0 ||
      args.window_id > 0xffffffff
    )
      return undefined;
    return { task, pid: args.pid, windowId: args.window_id };
  }

  /**
   * Best-effort tap prime after a successful launch_app: find the launched
   * app's main on-screen window and point the frame tap at it, so the preview
   * is live from the cold start instead of the first window-attributed call.
   * Detached from the agent's reply (which already returned); every guard the
   * synchronous path checks is re-verified before pointing the tap. Never
   * throws: failures keep the status quo (the tap starts on the next
   * attributed call) and log one line.
   */
  private async primeTapAfterLaunch(
    task: CuaComputerTask,
    input: unknown,
    connection: Socket,
    epoch: number,
  ): Promise<void> {
    const candidates = launchAppMatchNames(input);
    if (candidates.length === 0 || !this.options.frameTap) return;
    const reply = await this.call("list_windows", {}, connection, false);
    if (
      epoch !== this.epoch ||
      this.endedFrameTasks.has(cuaComputerTaskKey(task)) ||
      this.userStoppedTasks.has(cuaComputerTaskKey(task)) ||
      !reply.ok ||
      reply.result?.isError
    )
      return;
    const windows = (reply.result?.structuredContent as { windows?: unknown } | undefined)?.windows;
    if (!Array.isArray(windows)) return;
    let best: { pid: number; windowId: number; area: number } | undefined;
    for (const row of windows) {
      if (!row || typeof row !== "object") continue;
      const record = row as Record<string, unknown>;
      const pid = record.pid;
      const windowId = record.window_id;
      const bounds = record.bounds as { width?: unknown; height?: unknown } | undefined;
      const width = typeof bounds?.width === "number" ? bounds.width : 0;
      const height = typeof bounds?.height === "number" ? bounds.height : 0;
      if (
        typeof pid !== "number" ||
        !Number.isSafeInteger(pid) ||
        pid <= 0 ||
        typeof windowId !== "number" ||
        !Number.isSafeInteger(windowId) ||
        windowId <= 0 ||
        record.is_on_screen !== true ||
        width <= 0 ||
        height <= 0
      )
        continue;
      const appName = typeof record.app_name === "string" ? record.app_name.toLowerCase() : "";
      if (!candidates.some((candidate) => appName === candidate || appName.includes(candidate)))
        continue;
      const area = width * height;
      if (!best || area > best.area) best = { pid, windowId, area };
    }
    if (!best) {
      log("computer frame tap launch prime: no on-screen window matched the launched app");
      return;
    }
    if (
      epoch !== this.epoch ||
      this.endedFrameTasks.has(cuaComputerTaskKey(task)) ||
      this.userStoppedTasks.has(cuaComputerTaskKey(task))
    )
      return;
    log(`computer frame tap launch prime: streaming pid ${best.pid} window ${best.windowId}`);
    this.options.frameTap.update({ task, pid: best.pid, windowId: best.windowId });
  }

  /** Backend shutdown must reject later requests as well as cancel admitted
   * work. Ordinary turn Stop remains reusable without a backend restart. */
  suspend(): Promise<void> {
    this.suspended = true;
    return this.stop();
  }

  resume(): void {
    if (!this.closed) this.suspended = false;
  }

  /** OS desktop state is independent of backend restarts. A backend resume
   * cannot reopen input while the screen is locked or another user is active. */
  pauseDesktop(reason: string): Promise<void> {
    this.desktopPauses.add(reason);
    this.desktopObservationRequired = true;
    log(`desktop input paused (${reason}); requiring fresh desktop observation`);
    return this.stop();
  }

  resumeDesktop(reason: string): void {
    if (this.desktopPauses.delete(reason))
      log(`desktop pause "${reason}" lifted; ${this.desktopPauses.size} pause(s) remain`);
  }

  private desktopPauseReply(): CuaReply {
    const message =
      this.desktopPauses.size > 0
        ? "Computer input is paused because the desktop is locked, asleep or inactive. Return to the desktop, then read fresh state before continuing."
        : "Computer input remains paused after the desktop resumed. Call computer_screenshot and inspect what it shows before continuing; do not replay an uncertain action.";
    return {
      ok: true,
      result: {
        isError: true,
        content: [{ type: "text", text: message }],
        structuredContent: { effect: "refused", code: "desktop_input_paused", message },
      },
    };
  }

  async dispose(): Promise<void> {
    this.closed = true;
    try {
      await this.stop();
    } finally {
      await this.options.frameTap?.dispose().catch(() => undefined);
      for (const socket of this.connections) socket.destroy();
      await new Promise<void>((resolve) => {
        if (this.server) this.server.close(() => resolve());
        else resolve();
      });
      if (this.directory && !this.generation)
        await rm(this.directory, { recursive: true, force: true });
    }
  }
}

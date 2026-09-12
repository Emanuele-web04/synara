import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
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
import type { ComputerNativePreviewHost } from "./computerNativePreview";

interface Generation {
  child: ChildProcess;
  socket: string;
  session: string;
  exited: Promise<void>;
  didExit: boolean;
  retired: boolean;
  cancellationReady: boolean;
  inputInFlight: boolean;
  retirement?: Promise<void>;
}

interface HostPermissions {
  accessibility: boolean;
  screenRecording: boolean;
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
  private readonly endedPreviewTasks = new Set<string>();
  private readonly userStoppedTasks = new Set<string>();
  private previewTask: CuaComputerTask | undefined;
  constructor(
    private readonly options: {
      binaryPath: string;
      bundleId: string;
      capability: string;
      setup: () => Promise<void>;
      checkPermissions?: () => Promise<HostPermissions>;
      normalizeOverview?: (result: CuaToolResult) => CuaToolResult;
      preview?: ComputerNativePreviewHost;
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
      this.rememberTask(this.endedPreviewTasks, task);
      if (
        this.previewTask?.threadId === task.threadId &&
        (task.turnId === undefined || task.turnId === this.previewTask.turnId)
      ) {
        this.rememberTask(this.endedPreviewTasks, this.previewTask);
        this.previewTask = undefined;
      }
      await this.options.preview?.endTask(task);
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
        const permissions = await this.checkPermissions(connection, this.options.checkPermissions);
        if (
          !permissions ||
          this.closed ||
          this.suspended ||
          connection.destroyed ||
          epoch !== this.epoch
        )
          return {
            ok: false,
            error: "Cancelled before permission check completed.",
            effect: "not-dispatched",
          } as const;
        if (
          this.permissions &&
          (permissions.accessibility !== this.permissions.accessibility ||
            permissions.screenRecording !== this.permissions.screenRecording)
        ) {
          this.epoch += 1;
          this.desktopEpoch += 1;
          this.desktopObservationRequired = true;
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
      )
        return this.desktopPauseReply();
      if (task && (request.modelObservation === true || CUA_ACTION_TOOLS.has(name)))
        this.previewTask = task;
      const reply = await this.call(
        name,
        request.args,
        connection,
        request.modelObservation === true,
      );
      if (
        task &&
        !this.endedPreviewTasks.has(cuaComputerTaskKey(task)) &&
        !this.userStoppedTasks.has(cuaComputerTaskKey(task)) &&
        epoch === this.epoch &&
        !connection.destroyed &&
        reply.ok &&
        !reply.result?.isError &&
        (request.modelObservation === true || CUA_ACTION_TOOLS.has(name))
      ) {
        const target = this.previewTarget(task, request.args);
        if (target) {
          try {
            this.options.preview?.update(target);
          } catch (error) {
            console.warn("[computer-preview] Could not update preview", error);
          }
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
      const reply = await cuaRequest<CuaReply>(
        generation.socket,
        {
          method: "call",
          name,
          args: { ...args, session: generation.session },
        },
        { timeoutMs: 30_000, mutation: CUA_ACTION_TOOLS.has(name) },
      );
      generation.inputInFlight = false;
      if (admittedDesktopEpoch !== this.desktopEpoch && CUA_READ_TOOLS.has(name))
        return this.desktopPauseReply();
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
      )
        this.desktopObservationRequired = false;
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
            // Owned by the GUI host, not supplied through public tool arguments.
            // The native driver applies this only after foreground input cleanup.
            SYNARA_CUA_FOREGROUND_OBSERVATION_MS: "100",
            CUA_DRIVER_PARENT_LIVENESS_STDIN: "1",
            CUA_DRIVER_EMBEDDED_HOST_PID: String(process.pid),
            CUA_DRIVER_RS_HOME: join(this.directory, "state"),
          },
        },
      );
      // Consume diagnostics without retaining potentially private tool payloads.
      child.stderr?.on("data", () => undefined);
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.once("error", () => resolve());
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
        const session = await cuaRequest<CuaReply>(endpoint, {
          method: "call",
          name: "start_session",
          args: { session: generation.session },
        });
        if (!session.ok || session.result?.isError)
          throw new Error("Cua session initialization failed.");
        // Configure once per native generation, not before each input. The
        // cursor remains visible without making travel distance delay the action.
        const motion = await cuaRequest<CuaReply>(endpoint, {
          method: "call",
          name: "set_agent_cursor_motion",
          args: { session: generation.session, glide_duration_ms: 100, dwell_after_click_ms: 0 },
        });
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

  private retire(generation: Generation): Promise<void> {
    if (generation.retirement) return generation.retirement;
    generation.retired = true;
    const previewStopped = this.options.preview?.stop();
    // Retain the failure for the cleanup barrier without an unhandled rejection.
    void previewStopped?.catch(() => undefined);
    this.retiring = this.retiring.then(async () => {
      if (generation.didExit && generation.inputInFlight)
        throw new Error(
          "Cua Driver exited during input without confirming native cleanup. Computer admission is closed.",
        );
      if (!generation.didExit && generation.cancellationReady) {
        const reply = await cuaRequest<CuaReply>(
          generation.socket,
          {
            method: "cancel_input",
            args: { expected_pid: generation.child.pid },
          },
          { timeoutMs: 5_000 },
        );
        const cleanup = reply.result;
        if (
          !reply.ok ||
          cleanup?.pid !== generation.child.pid ||
          cleanup?.input_admission_closed !== true ||
          cleanup?.cleanup_complete !== true ||
          cleanup?.pending_input !== 0
        ) {
          throw new Error(
            "Cua Driver did not confirm native input cleanup. Computer admission is closed; the driver was not killed or replaced.",
          );
        }
        generation.inputInFlight = false;
      }
      await previewStopped;
      // Before the validated handshake no action can have been dispatched.
      // Otherwise the authenticated acknowledgement above covers all matching
      // releases and native context restoration before termination is allowed.
      if (!generation.didExit) {
        // End the lifetime pipe too: Tokio's blocking stdin reader otherwise
        // keeps the native runtime alive during graceful shutdown.
        generation.child.stdin?.end();
        const terminate = setTimeout(() => generation.child.kill("SIGTERM"), 500);
        const force = setTimeout(() => generation.child.kill("SIGKILL"), 1_500);
        try {
          await generation.exited;
        } finally {
          clearTimeout(terminate);
          clearTimeout(force);
        }
      }
      if (this.generation === generation) this.generation = undefined;
      await rm(generation.socket, { force: true });
    });
    generation.retirement = this.retiring;
    return this.retiring;
  }

  stop(): Promise<void> {
    this.epoch += 1;
    for (const cancel of this.pendingPermissionChecks) cancel();
    const admitted = this.operations;
    const previewStopped = this.options.preview?.stop();
    void previewStopped?.catch(() => undefined);
    this.stopping = this.stopping.then(async () => {
      if (this.generation) await this.retire(this.generation);
      await this.starting?.catch(() => undefined);
      if (this.generation) await this.retire(this.generation);
      await admitted;
      await this.retiring;
      await previewStopped;
    });
    return this.stopping;
  }

  /** Native preview Stop revokes the active turn without changing OS grants. */
  stopTaskByUser(task: CuaComputerTask): Promise<void> {
    this.rememberTask(this.userStoppedTasks, task);
    if (this.previewTask && cuaComputerTaskKey(this.previewTask) !== cuaComputerTaskKey(task))
      return Promise.resolve();
    return this.stop();
  }

  private rememberTask(set: Set<string>, task: CuaComputerTask): void {
    set.add(cuaComputerTaskKey(task));
    while (set.size > 256) set.delete(set.values().next().value!);
  }

  private previewTarget(task: CuaComputerTask, input: unknown): CuaPreviewTarget | undefined {
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
    let cursor: CuaPreviewTarget["cursor"];
    const bounds = args.expected_window_bounds as { width?: unknown; height?: unknown } | undefined;
    if (
      args.coordinate_space === "window_points" &&
      typeof args.x === "number" &&
      Number.isFinite(args.x) &&
      typeof args.y === "number" &&
      Number.isFinite(args.y) &&
      typeof bounds?.width === "number" &&
      bounds.width > 0 &&
      typeof bounds.height === "number" &&
      bounds.height > 0
    ) {
      const x = args.x / bounds.width,
        y = args.y / bounds.height;
      if (x >= 0 && x <= 1 && y >= 0 && y <= 1) cursor = { x, y };
    }
    return { task, pid: args.pid, windowId: args.window_id, ...(cursor ? { cursor } : {}) };
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
    this.desktopEpoch += 1;
    this.desktopPauses.add(reason);
    this.desktopObservationRequired = true;
    return this.stop();
  }

  resumeDesktop(reason: string): void {
    this.desktopPauses.delete(reason);
  }

  private desktopPauseReply(): CuaReply {
    const message =
      this.desktopPauses.size > 0
        ? "Computer input is paused because the desktop is locked, asleep or inactive. Return to the desktop, then read fresh state before continuing."
        : "Computer input remains paused after the desktop resumed. Read fresh window or desktop state before continuing; do not replay an uncertain action.";
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

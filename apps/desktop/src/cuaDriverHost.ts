import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { access, chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  cuaRequest,
  cuaCleanupAcknowledged,
  CUA_DRIVER_VERSION,
  CUA_NATIVE_REVISION,
  CUA_SETUP_TIMEOUT_MS,
  CUA_READ_TOOLS,
  CUA_ACTION_TOOLS,
  CUA_BROWSER_TOOLS,
  CUA_BROWSER_MUTATION_TOOLS,
  type CuaReply,
  type CuaToolResult,
  type CuaComputerTask,
  type CuaPreviewTarget,
  parseCuaComputerTask,
  parseCuaShieldArgs,
  cuaComputerTaskKey,
} from "@synara/shared/cuaDriverProtocol";
import type { ComputerFrameTapHost } from "./computerFrameTap";
import { linuxBrowserCallIsReadOnly, linuxCuaAdmissionRefusal } from "./linuxCuaAdmission";
import {
  cuaHostProcessIsAlive,
  markCuaRuntimeDirectory,
  sweepOwnedCuaRuntimeDirectories,
} from "./cuaRuntimeOwnership";
import type { ComputerShieldHost } from "./computerShield";
import type { ComputerInputMonitorState, PhysicalComputerInput } from "./escapeKillSwitchMonitor";
import {
  cuaActionDiagnosticMessage,
  parseCuaActionDiagnostics,
} from "@synara/shared/cuaActionDiagnostics";

interface TaskCursor {
  task: CuaComputerTask;
  firstActionObserved: boolean;
  enabled: boolean;
}

interface TaskRequest {
  readonly task: CuaComputerTask;
  stopped: boolean;
}

// Keep the marker through ordinary model turns, with a native expiry backstop
// if task-end cleanup cannot reach the overlay. This wait does not repaint.
export const CUA_CURSOR_IDLE_HIDE_MS = 60_000;
/** A raw ENOENT names a path, not a remedy; source builds stage the driver themselves. */
const CUA_DRIVER_MISSING_MESSAGE =
  "Cua Driver is not bundled. Run the provisioning script (`node apps/desktop/scripts/provision-cua-driver.mjs`, needs the pinned Rust toolchain) in this checkout, then relaunch Synara.";

interface ControlledTarget {
  pid: number;
  windowId?: number;
  threadId?: string;
  browserTargetId?: string;
  browserTabId?: string;
}

interface Generation {
  nativeInputEpoch: number;
  browserInputControl: boolean;
  child: ChildProcess;
  socket: string;
  session: string;
  exited: Promise<void>;
  didExit: boolean;
  retired: boolean;
  cancellationReady: boolean;
  inputInFlight: boolean;
  /** Exact task owning input that has not yet acknowledged its release. */
  inputTask: CuaComputerTask | undefined;
  browserInputInFlight: boolean;
  /** Stays set once any action tool was dispatched to this generation, so a
   * driver that wedges before ever receiving input stays distinguishable
   * from one that may still hold OS input it never confirmed releasing. */
  inputEverDispatched: boolean;
  /**
   * The session half of startup, opened lazily on the first call that needs
   * it. A generation the warm path spawned may be handshake-validated with no
   * session yet; assigning this promise is what makes session setup once-only.
   */
  sessionOpening?: Promise<void>;
  /**
   * The transport-owner id every browser call rides under. It belongs to one
   * persistent control connection that opened with `session_begin`: while that
   * connection lives the driver counts it an active proxy session (which is
   * what lets browser_download receive the host approval injection), and its
   * EOF reaps every lifecycle session this transport owns — grants, endpoints,
   * and owned browsers included. Closing it early is the teardown path; there
   * is no session_end call to forget.
   */
  controlSession: string;
  controlSocket: Socket | undefined;
  /**
   * Browser lifecycle labels this host has seen end — either because
   * `end_browser_thread` ran or because the driver reported the session dead.
   * The next call on an ended label revives it with `start_session` first,
   * the documented revival path; a revived label starts empty (targets and
   * refs do not survive session end) but stays a usable capability namespace.
   */
  endedBrowserSessions: Set<string>;
  /**
   * Labels dispatched under this generation's control session. Kept so a
   * control-connection reconnect can mark them all ended — the driver's EOF
   * reaper has already torn down everything the old transport owned.
   */
  liveBrowserSessions: Set<string>;
  /**
   * Per-task desktop session labels the driver reported ended (idle expiry
   * or driver-side eviction). Mirrored from `endedBrowserSessions`: the next
   * dispatch on an ended label revives it with `start_session` first — a
   * session-scoped heal that must not retire the whole generation the way a
   * shared-session death does.
   */
  endedTaskSessions: Set<string>;
  /**
   * The normalized cursor style (JSON) the session last acknowledged, `""`
   * for stock. Lets a live preference change skip redundant pushes and know
   * whether a switch back to stock must reset a customized cursor.
   */
  appliedCursorStyle: string;
  /**
   * Per task cursor session (`agent·…`), the custom style last applied, keyed
   * by label. Task cursors are seeded from the driver's launch template and
   * never inherit the shared session's style, so each one is styled before
   * its first dispatch and skipped afterwards. Stock is never recorded: a
   * task that never had custom colors sends nothing.
   */
  appliedSessionCursorStyles: Map<string, string>;
  /** Latest turn using each cursor label. A delayed old-turn end cannot hide it. */
  taskCursors: Map<string, TaskCursor>;
  retirement?: Promise<void>;
}

/**
 * The driver-side lifecycle label for one thread's browser namespace. Kept
 * deterministic — same thread, same label — so `end_browser_thread` can name
 * it and so an ended label revives in place instead of stranding the model's
 * cached target ids under a new namespace each call. Thread ids are unique,
 * so reuse after deletion cannot alias a different conversation's browser.
 */
function browserSessionLabel(threadId: string): string {
  return `synara-browser-${threadId}`;
}

/**
 * The driver-side lifecycle label for one task's desktop session. The driver
 * derives everything about that cursor's identity from this one string: the
 * overlay keys cursor state by it, tints the badge from its hash, and paints
 * it verbatim as the badge text (the registry stamps `_public_session_label`
 * from `session`, and the badge clips at 28 chars — so the string leads with
 * the human label and embeds the full thread id at the tail). Every
 * attributed call runs under its own label rather than the shared generation
 * session, so each concurrent agent gets a distinguishable cursor and two
 * threads that share a display label still get distinct cursors and tints.
 * The `agent·` prefix is compact because badge space is scarce, and it keeps
 * task-derived labels out of the `synara-browser-*` lifecycle namespace, the
 * anonymous `default` cursor, and the `__cua_runtime_` runtime-key space —
 * none of which can be spelled with the prefix in place.
 */
const AGENT_SESSION_LABEL_PREFIX = "agent·";
const AGENT_SESSION_LABEL_MAX_CHARS = 120;
const agentBadgeComponent = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
function agentSessionLabel(task: CuaComputerTask): string {
  const threadId = agentBadgeComponent(task.threadId) || "task";
  const label = [...agentBadgeComponent(task.label ?? "")]
    .slice(0, AGENT_SESSION_LABEL_MAX_CHARS)
    .join("");
  if (label.length === 0) return `${AGENT_SESSION_LABEL_PREFIX}${threadId}`;
  return `${AGENT_SESSION_LABEL_PREFIX}${label}·${threadId}`;
}

/**
 * The agent cursor overlay's colors, pushed to the driver session as
 * `set_agent_cursor_style`. Every field is optional: an omitted channel keeps
 * the driver's stock treatment for it, and a style with no usable color at
 * all means the stock monochrome cursor — no call is made.
 */
export interface CuaCursorStyle {
  readonly fill?: string;
  readonly rim?: string;
  readonly shadow?: string;
}

const CUA_CURSOR_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

function normalizeCuaCursorColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim().toLowerCase();
  return CUA_CURSOR_COLOR_PATTERN.test(candidate) ? candidate : undefined;
}

/** Drop unusable channels so a half-typed color never reaches the driver. */
function normalizeCuaCursorStyle(
  style: CuaCursorStyle | null | undefined,
): CuaCursorStyle | undefined {
  if (!style || typeof style !== "object") return undefined;
  const fill = normalizeCuaCursorColor(style.fill);
  const rim = normalizeCuaCursorColor(style.rim);
  const shadow = normalizeCuaCursorColor(style.shadow);
  if (!fill && !rim && !shadow) return undefined;
  return {
    ...(fill ? { fill } : {}),
    ...(rim ? { rim } : {}),
    ...(shadow ? { shadow } : {}),
  };
}

interface HostPermissions {
  accessibility: boolean;
  screenRecording: boolean;
  inputMonitoring?: boolean;
}

function permissionsChanged(a: HostPermissions, b: HostPermissions): boolean {
  return a.accessibility !== b.accessibility || a.screenRecording !== b.screenRecording;
}

const log = (message: string) => console.info(`[desktop-cua] ${message}`);
const safeNativeId = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff
    ? value
    : undefined;
const LOGGABLE_CUA_CODES = new Set([
  "computer_input_paused",
  "desktop_input_paused",
  "same_pid_keyboard_ambiguity",
  "cua_action_failed",
  "cua_refusal",
  "invalid_arguments",
  "input_admission_closed",
  "target_not_on_active_space",
  "target_unavailable",
  "auth_sheet_focused",
  "input_monitor_unavailable",
  "gui_host_required",
  "background_pixel_focus_unavailable",
]);

/**
 * How long a physical Escape keeps new mutating dispatch refused while the
 * interrupted input settles — the cooldown is a deadline, never a latch: it
 * lapses on its own, a repeated press only re-arms it, and the next action
 * afterwards dispatches with no user action and no re-arm. Reads are never
 * gated by it.
 */
export const ESCAPE_INPUT_COOLDOWN_MS = 1_500;

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
  // ps/env scanning exists on every unix the standalone host can run on;
  // Windows orphan reaping is a different mechanism entirely.
  if (process.platform === "win32") return;
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
    if (cuaHostProcessIsAlive(hostPid)) continue;
    try {
      process.kill(pid, "SIGKILL");
      log(`killed orphaned cua-driver pid=${pid} (host pid ${hostPid} gone)`);
    } catch {
      // Already gone.
    }
  }
  for (const entry of sweepOwnedCuaRuntimeDirectories({ directory: tmpdir(), liveSocketDirs }))
    log(`removed stale owned driver directory ${entry}`);
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

/** Lives in Electron's main process on macOS — only that GUI process spawns
 * the native daemon: a bundle-id string sent by a standalone server cannot
 * confer TCC. The standalone host entry (`cuaDriverHostStandalone`) runs the
 * same class on platforms where no such grant model exists. */
export class CuaDriverHost {
  private static readonly defaultOwnPids: ReadonlySet<number> = new Set([process.pid]);
  private directory = "";
  private server: Server | undefined;
  private generation: Generation | undefined;
  private starting: Promise<Generation> | undefined;
  private retiring: Promise<void> = Promise.resolve();
  private closed = false;
  private suspended = false;
  private inputMonitorArmed = false;
  private inputMonitorRequested = false;
  private nativeInputCleanupPending: Generation | undefined;
  private activeForegroundInput = false;
  private readonly controlledTargets = new Map<string, ControlledTarget>();
  private readonly takeoverTargets = new Map<string, ControlledTarget>();
  private readonly browserTargets = new Map<string, ControlledTarget>();
  private readonly repliedConnections = new WeakSet<Socket>();
  private activeInputTaskKey: string | undefined;
  private readonly monitoredTasks = new Map<string, string>();
  /**
   * Deadline until which mutating dispatch is refused after a physical
   * Escape interrupt — a timestamp, never a flag: it lapses on its own and
   * a repeated press just re-arms it. Reads are never gated by it.
   */
  private inputInterruptCooldownUntil = 0;
  /**
   * Abort handles for mutating calls whose driver request is live right now.
   * The input interrupt aborts them so the caller sees an immediate verdict
   * instead of waiting on a wedged action; the driver's side finishes on its
   * own clock and posts its matching releases. Reads never register — an
   * observation in flight is not input.
   */
  private readonly inFlightInputInterrupts = new Set<AbortController>();
  private readonly activeTaskCalls = new Map<AbortController, string>();
  private readonly desktopPauses = new Set<string>();
  private desktopObservationRequired = false;
  private browserObservationRequired = false;
  private readonly browserRecoveryObservations = new Map<string, number>();
  private desktopEpoch = 0;
  /**
   * Monotonic count of OS desktop interruptions this host has observed —
   * one per `pauseDesktop` signal (lock, sleep, session resign, or the
   * startup-locked probe), never reset. Unlike {@link desktopEpoch}, which
   * also advances on ordinary stops, this counts only real interruptions,
   * which is what lets the backend invalidate pre-interruption consent when
   * a lock/resume cycle netted back to "not paused" between two replies.
   */
  private desktopInterruptionCount = 0;
  /**
   * The `synara_native_revision` the live driver reported at handshake —
   * `undefined` until the first spawn answers, `0` when the driver is an
   * unpatched upstream build. Rides every reply so the backend can shape
   * advertised capabilities to the driver actually running.
   */
  private observedNativeRevision: number | undefined;
  private operations: Promise<void> = Promise.resolve();
  private stopping: Promise<void> = Promise.resolve();
  /** Serializes live cursor-style pushes so two rapid changes cannot race. */
  private cursorStyleUpdates: Promise<void> = Promise.resolve();
  private epoch = 0;
  /** Separates listener failures from real cancellation during activation. */
  private inputMonitorEpochChanges = 0;
  private readonly connections = new Set<Socket>();
  private permissions: HostPermissions | undefined;
  private readonly pendingPermissionChecks = new Map<() => void, string | undefined>();
  private readonly userStoppedTasks = new Set<string>();
  private readonly admittedTaskRequests = new Set<TaskRequest>();
  private readonly knownTasks = new Map<string, CuaComputerTask>();
  private readonly endedFrameTasks = new Set<string>();
  private frameTapTask: CuaComputerTask | undefined;
  constructor(
    private readonly options: {
      binaryPath: string;
      bundleId: string;
      capability: string;
      setup: () => Promise<void>;
      checkPermissions?: (options?: { readonly force: boolean }) => Promise<HostPermissions>;
      releaseHeldInput?: () => Promise<void>;
      /** Bound on each post-handshake startup call; defaults to 5s. */
      startupTimeoutMs?: number;
      normalizeOverview?: (result: CuaToolResult) => CuaToolResult;
      frameTap?: ComputerFrameTapHost;
      /**
       * Mirrors whether a live driver generation could dispatch input — the
       * window during which the physical Escape monitor must be listening.
       * The desktop wires this to the helper's `arm`/`disarm` commands.
       */
      onInputMonitorArmedChange?: (armed: boolean) => void;
      /** macOS listener health; omitted on hosts without this listener. */
      inputMonitorState?: () => ComputerInputMonitorState;
      activateInputMonitor?: () => Promise<void>;
      /**
       * The masked-activation shield surface. Absent means `engage` requests
       * are refused as unavailable — the caller must never fall back to an
       * unmasked excursion under an armed flag.
       */
      shield?: ComputerShieldHost;
      /**
       * The `synara_native_revision` the spawned driver must report at
       * handshake. Defaults to {@link CUA_NATIVE_REVISION} — the patched
       * build the macOS desktop provisions. `null` expects a provisioned
       * upstream driver: its metadata carries no Synara revision, so the
       * revision check and the patch-only spawn flags are skipped, and the
       * driver runs with the safety set upstream ships.
       */
      nativeRevision?: number | null;
      /**
       * Where the host socket listens. Defaults to a unix socket in the
       * private session directory — on Windows, a `\\.\pipe\` name, which
       * Node maps to a named pipe. The standalone host passes an explicit
       * endpoint so the server can be configured to reach it.
       */
      hostEndpoint?: string;
      /**
       * Pids belonging to this application (main, helpers, renderers).
       * Browser calls carrying one as `args.pid` are refused: the integrated
       * browser is a separate surface and computer use must never bind the
       * app that hosts it. Defaults to this process alone.
       */
      ownPids?: () => ReadonlySet<number>;
      /**
       * The agent cursor's colors, read at each session open. `undefined`
       * (or a style with no usable `#rrggbb` channel) keeps the driver's
       * stock monochrome cursor: no `set_agent_cursor_style` call is made.
       */
      cursorStyle?: () => CuaCursorStyle | null | undefined;
    },
  ) {}

  get isInputMonitorRequested(): boolean {
    return this.inputMonitorRequested;
  }

  async listen(): Promise<string> {
    this.directory = await mkdtemp(join(tmpdir(), "synara-cua-"));
    await chmod(this.directory, 0o700);
    await markCuaRuntimeDirectory(this.directory);
    // Named pipes are already private to the creating user on Windows; the
    // 0o600 owner check is a unix-socket protection, applied where it exists.
    const endpoint =
      this.options.hostEndpoint ??
      (process.platform === "win32"
        ? `\\\\.\\pipe\\synara-cua-host-${randomUUID().slice(0, 8)}`
        : join(this.directory, "host.sock"));
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, resolve);
    });
    if (process.platform !== "win32") await chmod(endpoint, 0o600);
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
        (result) => {
          this.repliedConnections.add(socket);
          socket.end(JSON.stringify({ ...result, ...this.desktopState() }) + "\n");
        },
        (error) => {
          this.repliedConnections.add(socket);
          socket.end(
            JSON.stringify({
              ok: false,
              error: String(error),
              effect: "not-dispatched",
              ...this.desktopState(),
            }) + "\n",
          );
        },
      );
    });
    socket.setTimeout(60_000, () => socket.destroy());
  }

  private async handle(request: Record<string, unknown>, connection: Socket): Promise<CuaReply> {
    const name = typeof request.name === "string" ? request.name : "";
    if (request.method !== "call" || !CUA_ACTION_TOOLS.has(name))
      return this.handleRequest(request, connection);
    const started = Date.now();
    let reply: CuaReply | undefined;
    try {
      reply = await this.handleRequest(request, connection);
      return reply;
    } finally {
      const task = reply ? parseCuaComputerTask(request.task) : undefined;
      const args =
        request.args && typeof request.args === "object"
          ? (request.args as Record<string, unknown>)
          : {};
      const structured = reply?.result?.structuredContent;
      const diagnostics = parseCuaActionDiagnostics(structured);
      const effect = structured?.effect ?? reply?.effect;
      const refusal = structured?.refusal as Record<string, unknown> | undefined;
      const code = structured?.code ?? refusal?.code;
      log(
        JSON.stringify({
          event: "computer_action",
          ts: new Date().toISOString(),
          thread: task?.threadId,
          turn: task?.turnId,
          tool: name,
          layer: "driver-host",
          code: typeof code === "string" && LOGGABLE_CUA_CODES.has(code) ? code : undefined,
          pid: safeNativeId(args.pid),
          windowId: safeNativeId(args.window_id),
          effect:
            typeof effect === "string" &&
            ["refused", "not-dispatched", "dispatched-unknown", "verified"].includes(effect)
              ? effect
              : "unknown",
          failed: !reply?.ok || reply.result?.isError === true,
          ...(diagnostics
            ? {
                diagnostics,
                reason: cuaActionDiagnosticMessage(diagnostics),
              }
            : {}),
          ms: Date.now() - started,
        }),
      );
    }
  }

  private async handleRequest(
    request: Record<string, unknown>,
    connection: Socket,
  ): Promise<CuaReply> {
    const supplied =
      typeof request.capability === "string" ? Buffer.from(request.capability) : Buffer.alloc(0);
    const expected = Buffer.from(this.options.capability);
    if (
      expected.length < 32 ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new Error("Computer host authority is required.");
    const task = parseCuaComputerTask(request.task);
    if (request.task !== undefined && !task) throw new Error("Invalid computer task attribution.");
    const admitted = request.method === "call" && task ? { task, stopped: false } : undefined;
    if (admitted) {
      this.admittedTaskRequests.add(admitted);
      const key = cuaComputerTaskKey(admitted.task);
      this.knownTasks.delete(key);
      this.knownTasks.set(key, admitted.task);
      while (this.knownTasks.size > 256)
        this.knownTasks.delete(this.knownTasks.keys().next().value!);
    }
    try {
      return await this.handleAuthenticatedRequest(request, connection, task, admitted);
    } finally {
      if (admitted) this.admittedTaskRequests.delete(admitted);
    }
  }

  private async handleAuthenticatedRequest(
    request: Record<string, unknown>,
    connection: Socket,
    task: CuaComputerTask | undefined,
    admitted: TaskRequest | undefined,
  ): Promise<CuaReply> {
    const taskStopped = () =>
      admitted?.stopped === true || (task && this.userStoppedTasks.has(cuaComputerTaskKey(task)));
    if (request.method === "stop") {
      if (task) {
        const scope = await this.stopTaskInput(task);
        return { ok: true, result: { stop_scope: scope } };
      }
      // The backend's generic input-stop verb — turn Stop, control revoke,
      // the relayed physical-Escape notice, shutdown — all send it. While the
      // host is serving it means interrupt input, not retire the driver: the
      // generation, its sessions, and its browser bindings all survive, so
      // the next action dispatches without a cold restart. Full retirement
      // still belongs to the lifecycle callers — suspend(), dispose(),
      // setup() — and to a stop arriving after the host already left the
      // serving state.
      if (this.closed || this.suspended) await this.stop();
      else await this.interruptInput();
      return { ok: true };
    }
    if (request.method === "end_task") {
      if (!task) throw new Error("Computer task attribution is required.");
      await this.endTask(task, task.turnId === undefined);
      return { ok: true };
    }
    if (request.method === "shield") {
      // Answered before the closed/suspended gate on purpose: engage checks
      // those itself, while release must land in every host state — a shield
      // left up because teardown was gated is exactly the failure this
      // surface exists to prevent.
      return this.handleShield(request, task);
    }
    if (request.method === "end_browser_thread") {
      // Explicit browser teardown for a removed thread: end the thread's
      // lifecycle session so the driver runs its session-end hooks (targets,
      // grants, owned browsers) now rather than at control-connection EOF.
      // Queued like a call so it cannot race an in-flight call on the same
      // label — ending a session under a dispatching call would turn a
      // known-alive capability into a mid-flight session death.
      if (!task) throw new Error("Computer task attribution is required.");
      for (const [key, target] of this.browserTargets) {
        if (target.threadId === task.threadId) this.browserTargets.delete(key);
      }
      const endTask = task;
      const previousEnd = this.operations;
      const endOperation = (async () => {
        await previousEnd;
        await this.stopping;
        const generation = this.generation;
        const label = browserSessionLabel(endTask.threadId);
        if (
          this.closed ||
          !generation ||
          generation.retired ||
          generation.didExit ||
          !generation.controlSocket ||
          generation.controlSocket.destroyed ||
          // Nothing was ever dispatched under this label — no session exists
          // to end and none needs reviving later.
          (!generation.liveBrowserSessions.has(label) &&
            !generation.endedBrowserSessions.has(label))
        )
          return;
        try {
          await cuaRequest<CuaReply>(
            generation.socket,
            {
              method: "call",
              name: "end_session",
              args: { session: label },
              session_id: generation.controlSession,
            },
            { timeoutMs: 5_000 },
          );
          // Even a failed end marks the label ended for revival: the
          // transport EOF will finish whatever the explicit call could not,
          // and reviving an already-gone session is a no-op either way.
          generation.liveBrowserSessions.delete(label);
          generation.endedBrowserSessions.add(label);
        } catch {
          generation.liveBrowserSessions.delete(label);
          generation.endedBrowserSessions.add(label);
        }
      })();
      this.operations = endOperation.then(
        () => undefined,
        () => undefined,
      );
      await endOperation;
      return { ok: true };
    }
    if (this.closed) throw new Error("Computer host is closed.");
    if (this.suspended)
      throw new Error("Computer host is suspended while the backend is stopping.");
    if (taskStopped()) return this.taskStoppedReply();
    const activeComputerWork =
      request.method === "call" &&
      typeof request.name === "string" &&
      request.name !== "check_permissions" &&
      (process.platform !== "linux" || task !== undefined) &&
      (CUA_ACTION_TOOLS.has(request.name) ||
        (CUA_BROWSER_MUTATION_TOOLS.has(request.name) &&
          (process.platform !== "linux" ||
            !linuxBrowserCallIsReadOnly(request.name, request.args))) ||
        (task !== undefined &&
          request.modelObservation === true &&
          (CUA_READ_TOOLS.has(request.name) || CUA_BROWSER_TOOLS.has(request.name))));
    if (activeComputerWork) {
      this.inputMonitorRequested = true;
      const activationEpoch = this.epoch;
      const activationMonitorEpochChanges = this.inputMonitorEpochChanges;
      await this.options.activateInputMonitor?.();
      if (
        activationEpoch !== this.epoch ||
        connection.destroyed ||
        this.closed ||
        this.suspended ||
        taskStopped()
      ) {
        const monitor = this.options.inputMonitorState?.();
        // Listener failure fences input just like Stop. Preserve its useful
        // diagnosis only when no other cancellation occurred while activating.
        // The request still ends here without entering the operation queue.
        if (
          !connection.destroyed &&
          !this.closed &&
          !this.suspended &&
          monitor?.ready === false &&
          this.epoch - activationEpoch ===
            this.inputMonitorEpochChanges - activationMonitorEpochChanges
        )
          return this.inputMonitorUnavailableReply(monitor);
        return {
          ok: false,
          error: "Cancelled before listener activation completed.",
          effect: "not-dispatched",
        };
      }
      if (this.options.activateInputMonitor) this.inputMonitorArmed = true;
      if (task) {
        this.monitoredTasks.set(cuaComputerTaskKey(task), task.threadId);
        while (this.monitoredTasks.size > 256)
          this.monitoredTasks.delete(this.monitoredTasks.keys().next().value!);
      }
    }
    // Hosts without a permission bridge can warm on first touch. On macOS,
    // wait for the first granted snapshot below so the daemon cannot cache a
    // denied TCC result before setup completes.
    if (
      !this.options.checkPermissions &&
      (request.method === "probe" ||
        (request.method === "call" && request.name === "check_permissions"))
    )
      this.warm();
    if (request.method === "probe") {
      try {
        await access(this.options.binaryPath);
      } catch {
        return {
          ok: false,
          error: CUA_DRIVER_MISSING_MESSAGE,
        };
      }
      return {
        ok: true,
        result: { version: CUA_DRIVER_VERSION, running: !!this.generation },
      };
    }
    if (request.method === "setup") {
      connection.setTimeout(CUA_SETUP_TIMEOUT_MS);
      await this.stop();
      if (connection.destroyed || this.closed || this.suspended)
        return {
          ok: false,
          error: "Cancelled before permission setup.",
          effect: "not-dispatched",
        };
      await this.options.setup();
      return { ok: true };
    }
    const name = request.name;
    if (
      request.method !== "call" ||
      typeof name !== "string" ||
      (!CUA_READ_TOOLS.has(name) && !CUA_ACTION_TOOLS.has(name) && !CUA_BROWSER_TOOLS.has(name))
    )
      throw new Error("Unsupported computer host request.");
    if (process.platform === "linux" && !CUA_BROWSER_TOOLS.has(name)) {
      const refusal = linuxCuaAdmissionRefusal(name, request.args, request.deliveryMode);
      if (refusal) return refusal;
    }
    // Browser calls mint session-scoped capabilities. Without task attribution
    // there is no lifecycle label to scope them under, so they are refused at
    // admission rather than dropped into an anonymous namespace.
    if (CUA_BROWSER_TOOLS.has(name) && !task)
      throw new Error("Computer browser calls require task attribution.");
    if (CUA_BROWSER_TOOLS.has(name)) {
      const args =
        request.args && typeof request.args === "object" && !Array.isArray(request.args)
          ? (request.args as Record<string, unknown>)
          : {};
      const pid = args.pid;
      if (typeof pid === "number" && Number.isSafeInteger(pid) && this.ownPids().has(pid)) {
        const message =
          "Computer browser calls may never target this application's own processes; the integrated browser is a separate surface.";
        return {
          ok: true,
          result: {
            isError: true,
            content: [{ type: "text", text: message }],
            structuredContent: { effect: "refused", code: "browser_self_target", message },
          },
        };
      }
    }
    if (this.desktopPauses.size > 0) return this.desktopPauseReply();
    // Observations and input share one native session. A pane capture must not
    // race input or turn a harmless concurrent read into a driver restart.
    const previous = this.operations;
    const stopping = this.stopping;
    const epoch = this.epoch;
    const operation = (async (): Promise<CuaReply> => {
      await previous;
      await stopping;
      if (this.closed || this.suspended || connection.destroyed || epoch !== this.epoch)
        return {
          ok: false,
          error: "Cancelled before dispatch.",
          effect: "not-dispatched",
        } as const;
      if (this.desktopPauses.size > 0) return this.desktopPauseReply();
      if (process.platform === "linux" && CUA_BROWSER_TOOLS.has(name)) {
        // Capability comes only from the embedded child handshake. A cold
        // browser call must not trust model arguments or a configured path as
        // evidence that this Linux artifact implements input cancellation.
        const generation = await this.ensureSpawned();
        if (
          this.closed ||
          this.suspended ||
          connection.destroyed ||
          epoch !== this.epoch ||
          generation.retired ||
          generation.didExit
        )
          return { ok: false, error: "Cancelled before dispatch.", effect: "not-dispatched" };
        const refusal = linuxCuaAdmissionRefusal(
          name,
          request.args,
          request.deliveryMode,
          generation.browserInputControl,
        );
        if (refusal) return refusal;
      }
      if (!this.inputMonitorAvailable(name, request.args))
        return this.inputMonitorUnavailableReply();
      if (
        (CUA_ACTION_TOOLS.has(name) || CUA_BROWSER_MUTATION_TOOLS.has(name)) &&
        this.nativeInputCleanupPending
      ) {
        await this.interruptNativeInput(this.nativeInputCleanupPending);
        if (epoch !== this.epoch || connection.destroyed)
          return {
            ok: false,
            error: "Cancelled while waiting for native input cleanup.",
            effect: "not-dispatched",
          };
      }
      // A physical Escape's cooldown: mutating dispatch is refused with the
      // desktop-pause dialect until the deadline lapses — checked at dispatch
      // time, so a call queued past the window runs and one admitted inside
      // it is refused. Reads are never gated: the generation stays live and
      // observation flows through the whole cooldown.
      if (
        this.inputInterruptCooldownUntil > Date.now() &&
        (CUA_ACTION_TOOLS.has(name) || CUA_BROWSER_MUTATION_TOOLS.has(name))
      )
        return this.inputInterruptedReply();
      if (taskStopped()) {
        return this.taskStoppedReply();
      }
      if (name === "check_permissions" && this.options.checkPermissions) {
        // AppSnap's short-lived helper avoids the embedded daemon's TCC cache.
        // This remains an authenticated, read-only host operation: prompt args
        // from tools never reach the permission request path.
        const check = this.options.checkPermissions;
        const cancelled = () =>
          this.closed ||
          this.suspended ||
          connection.destroyed ||
          epoch !== this.epoch ||
          taskStopped();
        let permissions = await this.checkPermissions(connection, check, false, task);
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
          const confirmed = await this.checkPermissions(connection, check, true, task);
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
          this.browserObservationRequired = true;
          log(
            `permission state changed accessibility ${this.permissions.accessibility} -> ${permissions.accessibility}, ` +
              `screen_recording ${this.permissions.screenRecording} -> ${permissions.screenRecording}; requiring fresh desktop observation`,
          );
          // Already inside the operation queue: stop() would wait for itself.
          // Retire directly, preserving its native cleanup acknowledgement.
          if (this.generation) await this.retire(this.generation);
        }
        this.permissions = permissions;
        if (
          permissions.accessibility &&
          permissions.screenRecording &&
          permissions.inputMonitoring !== false
        )
          this.warm();
        const monitor = this.inputMonitorRequested ? this.options.inputMonitorState?.() : undefined;
        return {
          ok: true,
          result: {
            structuredContent: {
              accessibility: permissions.accessibility,
              screen_recording: permissions.screenRecording,
              ...(permissions.inputMonitoring !== undefined
                ? { input_monitoring: permissions.inputMonitoring }
                : {}),
              ...(monitor
                ? {
                    input_monitor_ready: monitor.ready,
                    ...(monitor.error ? { input_monitor_error: monitor.error } : {}),
                  }
                : {}),
              source: {
                attribution: "host",
                host_bundle_id: this.options.bundleId,
                probe: "appsnap-permission-helper",
              },
            },
          },
        };
      }
      const browserRecoverySetup = this.isIsolatedBrowserSetup(name, request.args);
      const browserRecoveryObserved = this.hasBrowserRecoveryObservation(request.args, task);
      if (
        (this.desktopObservationRequired &&
          (CUA_ACTION_TOOLS.has(name) || name === "check_input_ready")) ||
        (this.browserObservationRequired &&
          CUA_BROWSER_MUTATION_TOOLS.has(name) &&
          !browserRecoverySetup &&
          !browserRecoveryObserved) ||
        ((this.takeoverTargets.has(task ? cuaComputerTaskKey(task) : "anonymous") ||
          (!task && this.takeoverTargets.size > 0)) &&
          (CUA_ACTION_TOOLS.has(name) ||
            (CUA_BROWSER_MUTATION_TOOLS.has(name) &&
              !browserRecoverySetup &&
              !browserRecoveryObserved) ||
            name === "check_input_ready"))
      ) {
        log(`refused ${name}: fresh desktop observation still required`);
        return this.desktopPauseReply();
      }
      if (
        task &&
        (request.modelObservation === true ||
          CUA_ACTION_TOOLS.has(name) ||
          CUA_BROWSER_TOOLS.has(name))
      )
        this.frameTapTask = task;
      const reply = await this.call(
        name,
        request.args,
        connection,
        request.modelObservation === true,
        task,
        request.deliveryMode === "foreground",
      );
      // Frame tap updates carry no frames through this queue: they only point
      // the dedicated helper channel at the task's window target.
      if (
        task &&
        !this.endedFrameTasks.has(cuaComputerTaskKey(task)) &&
        !taskStopped() &&
        epoch === this.epoch &&
        !connection.destroyed &&
        reply.ok &&
        !reply.result?.isError &&
        reply.result?.structuredContent?.effect !== "refused" &&
        reply.result?.structuredContent?.status !== "refused" &&
        (request.modelObservation === true ||
          CUA_ACTION_TOOLS.has(name) ||
          CUA_BROWSER_TOOLS.has(name))
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

  /**
   * The `shield` host method: engage is admission-gated (closed, suspended,
   * or desktop-paused hosts refuse so a mask never arms under an interrupted
   * desktop), while release and release_all are teardown — accepted in every
   * state and always safe to repeat. Shield commands never reach the driver
   * or the operation queue: the helper owns the panels, and a queued shield
   * request would deadlock an excursion whose cleanup waits on it.
   */
  private async handleShield(
    request: Record<string, unknown>,
    task: CuaComputerTask | undefined,
  ): Promise<CuaReply> {
    const args = parseCuaShieldArgs(request.args);
    if (!args) throw new Error("Invalid computer shield request.");
    const shield = this.options.shield;
    if (args.action === "engage") {
      if (this.closed || this.suspended) {
        return {
          ok: false,
          error: "The activation shield is unavailable while the computer host is stopped.",
          effect: "not-dispatched",
        };
      }
      if (this.desktopPauses.size > 0) {
        return {
          ok: false,
          error:
            "The activation shield is unavailable while the desktop is paused. " +
            "Observe the desktop again before activating windows.",
          effect: "not-dispatched",
        };
      }
      if (!shield) {
        return {
          ok: false,
          error: "The activation shield is not available in this build.",
          effect: "not-dispatched",
        };
      }
      try {
        await shield.engage(
          {
            shieldId: args.shieldId,
            frame: args.frame,
            windowId: args.windowId,
            pid: args.pid,
            ...(args.label !== undefined ? { label: args.label } : {}),
          },
          task,
        );
      } catch (error) {
        return {
          ok: false,
          error: `The activation shield could not be shown: ${
            error instanceof Error ? error.message : String(error)
          }`,
          effect: "not-dispatched",
        };
      }
      return { ok: true, result: { engaged: true, shield_id: args.shieldId } };
    }
    if (args.action === "release") {
      await shield?.release(args.shieldId);
      return { ok: true };
    }
    const released = (await shield?.releaseAll()) ?? 0;
    return { ok: true, result: { released } };
  }

  private checkPermissions(
    connection: Socket,
    check: (options?: { readonly force: boolean }) => Promise<HostPermissions>,
    force = false,
    task?: CuaComputerTask,
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
      this.pendingPermissionChecks.set(cancel, task ? cuaComputerTaskKey(task) : undefined);
      connection.once("close", cancel);
      void Promise.resolve()
        .then(() => check({ force }))
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
    task?: CuaComputerTask,
    foregroundDelivery = false,
  ): Promise<CuaReply> {
    let generation: Generation | undefined;
    let dispatched = false;
    let cursorEnabled: boolean | undefined;
    const admittedEpoch = this.epoch;
    const admittedDesktopEpoch = this.desktopEpoch;
    const isBrowser = CUA_BROWSER_TOOLS.has(name);
    const mutation = isBrowser ? CUA_BROWSER_MUTATION_TOOLS.has(name) : CUA_ACTION_TOOLS.has(name);
    // Browser labels are minted from the task's thread: one capability
    // namespace per thread, surviving turn boundaries, ended only by
    // `end_browser_thread` or transport teardown.
    const label = isBrowser && task ? browserSessionLabel(task.threadId) : undefined;
    // Desktop calls get a per-task cursor session: the overlay keys cursors —
    // and the badge each one carries — by session label, so each attributed
    // thread animates under its own color and name instead of the shared
    // generation session. Minted lazily on dispatch; no extra round trip.
    const agentLabel = !isBrowser && task ? agentSessionLabel(task) : undefined;
    // Per-call cancellation. The input interrupt aborts mutating calls
    // through this signal; a caller's connection closing mid-flight aborts
    // it too — the reply has no destination, so there is nothing to keep
    // waiting on. Optional preview priming may outlive a replied launch, so
    // only the host's explicit reply marker recognizes normal completion.
    // Node also sets writableEnded after peer EOF when allowHalfOpen is false. Neither
    // indicts the generation: a vanished caller or a pressed Escape says
    // nothing about driver health, so the catch below deliberately does not
    // retire on an aborted call.
    const callCancel = new AbortController();
    if (mutation) this.inFlightInputInterrupts.add(callCancel);
    if (task) this.activeTaskCalls.set(callCancel, cuaComputerTaskKey(task));
    const abort = () => {
      if (this.repliedConnections.has(connection)) return;
      const alreadyInterrupted = callCancel.signal.aborted;
      callCancel.abort();
      if (mutation && dispatched && !alreadyInterrupted) {
        // Closing a socket does not stop a native input loop. Fence queued
        // work immediately and keep subsequent admission behind the real
        // native drain, just as an explicit Stop does.
        void this.interruptInput().catch((error: unknown) =>
          log(`disconnected input cleanup failed: ${String(error)}`),
        );
      }
    };
    connection.once("close", abort);
    // Set only by the deliberate pre-dispatch guard below: a call cancelled
    // before anything reached the driver has no grounds to retire the
    // generation — whatever prompted the cancel has its own teardown path.
    let cancelledBeforeDispatch = false;
    try {
      let reply: CuaReply | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        generation = await this.ensureStarted();
        if (
          connection.destroyed ||
          generation.retired ||
          admittedEpoch !== this.epoch ||
          this.desktopPauses.size > 0 ||
          callCancel.signal.aborted
        ) {
          cancelledBeforeDispatch = !dispatched;
          throw new Error("Cancelled before dispatch.");
        }
        const args = input && typeof input === "object" && !Array.isArray(input) ? input : {};
        let browserSessionId: string | undefined;
        if (isBrowser && label) {
          // The transport owner must be a live proxy session for the driver's
          // boundary to inject download approval; re-begin if the control
          // connection died (its EOF already reaped every owned session).
          await this.ensureControlSession(generation);
          if (generation.endedBrowserSessions.has(label)) {
            // Revival is the documented re-entry path for an ended id. It is
            // attempted once here; a session that still reports dead after it
            // returns the death reply verbatim rather than another retry.
            const revived = await cuaRequest<CuaReply>(
              generation.socket,
              {
                method: "call",
                name: "start_session",
                args: { session: label },
                session_id: generation.controlSession,
              },
              { timeoutMs: 10_000 },
            );
            if (revived.ok && !revived.result?.isError)
              generation.endedBrowserSessions.delete(label);
          }
          browserSessionId = generation.controlSession;
        } else if (agentLabel && generation.endedTaskSessions.has(agentLabel)) {
          // The same documented revival path browser labels ride, minus the
          // transport envelope: a desktop task session owns itself, so the
          // plain call form of start_session is what revives it.
          const revived = await cuaRequest<CuaReply>(
            generation.socket,
            {
              method: "call",
              name: "start_session",
              args: { session: agentLabel },
            },
            { timeoutMs: 10_000 },
          );
          if (revived.ok && !revived.result?.isError) {
            generation.endedTaskSessions.delete(agentLabel);
            // A revived cursor is re-created from the driver's launch
            // template, so any style remembered from the previous life of
            // this label is stale: re-apply before the first action paints.
            generation.appliedSessionCursorStyles.delete(agentLabel);
          }
        }
        // The action paints under its own task session, not the shared
        // generation session, and the driver seeds every lazily-created
        // session cursor from its launch template. The user's colors must be
        // applied to the session the action actually paints, once per task.
        if (agentLabel) await this.applyCursorStyleForSession(generation, agentLabel);
        if (agentLabel && !generation.taskCursors.get(agentLabel)?.enabled) {
          // Showing/hiding a cursor must not end its driver session: that
          // session can still own retained accessibility refs across turns.
          cursorEnabled = await this.setTaskCursorEnabled(generation, agentLabel, true);
        }
        // Session setup can await I/O. Stop must win even if it arrived after
        // the initial dispatch guard and before the native request is sent.
        if (admittedEpoch !== this.epoch || connection.destroyed || callCancel.signal.aborted) {
          cancelledBeforeDispatch = !dispatched;
          throw new Error("Cancelled before dispatch.");
        }
        if (process.platform === "linux" && isBrowser) {
          const refusal = linuxCuaAdmissionRefusal(
            name,
            input,
            foregroundDelivery ? "foreground" : undefined,
            generation.browserInputControl,
          );
          if (refusal) return refusal;
        }
        if (!this.inputMonitorAvailable(name, input)) return this.inputMonitorUnavailableReply();
        if (mutation || modelObservation) {
          const target = this.controlledTarget(input, task, isBrowser);
          if (target) {
            this.controlledTargets.set(task ? cuaComputerTaskKey(task) : "anonymous", target);
            while (this.controlledTargets.size > 256)
              this.controlledTargets.delete(this.controlledTargets.keys().next().value!);
          }
        }
        if (mutation) {
          this.activeInputTaskKey = task ? cuaComputerTaskKey(task) : "anonymous";
          this.activeForegroundInput =
            foregroundDelivery ||
            (args as Record<string, unknown>).delivery_mode === "foreground" ||
            name === "bring_to_front";
        }
        dispatched = true;
        if (label) generation.liveBrowserSessions.add(label);
        if (mutation) {
          generation.inputInFlight = true;
          generation.browserInputInFlight = isBrowser;
          generation.inputTask = task;
        }
        generation.inputEverDispatched ||= generation.inputInFlight;
        const attemptReply = await cuaRequest<CuaReply>(
          generation.socket,
          {
            method: "call",
            name,
            ...(mutation && (this.options.nativeRevision !== null || generation.browserInputControl)
              ? { expected_input_epoch: generation.nativeInputEpoch }
              : {}),
            // The daemon sanitizes reserved keys anyway, but the spread order
            // is the real guard: the label overwrites any caller `session`,
            // and `_session_id`/`_transport_session_id` are injected by the
            // daemon from this request's envelope, never trusted from args.
            args: {
              ...args,
              session: label ?? agentLabel ?? generation.session,
            },
            ...(browserSessionId ? { session_id: browserSessionId } : {}),
          },
          { timeoutMs: 30_000, mutation, signal: callCancel.signal },
        );
        if (attemptReply.result?.structuredContent?.input_cleanup_unconfirmed === true) {
          // A tool reply is not a release acknowledgement. Keep CDP input
          // uncertainty across later reads and process exits; OS key-ups
          // cannot prove that the browser received its matching release.
          generation.inputInFlight = true;
          generation.browserInputInFlight ||= isBrowser;
          this.nativeInputCleanupPending = generation;
        } else if (mutation && this.nativeInputCleanupPending !== generation) {
          generation.inputInFlight = false;
          generation.browserInputInFlight = false;
          generation.inputTask = undefined;
        }
        if (isDriverSessionDeath(attemptReply)) {
          if (isBrowser && label) {
            // A browser session can die without the generation dying — the
            // lifecycle registry expires idle ids and transport EOF reaps
            // owned sessions. Mark it ended so the next attempt (and any
            // later call) revives before dispatching.
            generation.liveBrowserSessions.delete(label);
            generation.endedBrowserSessions.add(label);
            if (attempt === 0) continue;
          } else if (agentLabel) {
            // A task cursor session expires independently of the shared
            // generation session the same way browser labels do: reviving the
            // label in place keeps every other thread's cursor — and the
            // driver itself — alive, where the shared-session path correctly
            // retires the generation it can no longer trust.
            generation.endedTaskSessions.add(agentLabel);
            while (generation.endedTaskSessions.size > 256)
              generation.endedTaskSessions.delete(
                generation.endedTaskSessions.values().next().value!,
              );
            if (attempt === 0) continue;
          } else if (attempt === 0) {
            await this.retire(generation).catch(() => undefined);
            continue;
          }
        }
        reply = attemptReply;
        break;
      }
      if (!reply || !generation) throw new Error("Cancelled before dispatch.");
      if (
        mutation &&
        (reply.result?.structuredContent?.code === "focus_restore_failed" ||
          parseCuaActionDiagnostics(reply.result?.structuredContent)?.error_code ===
            "focus_restore_failed")
      ) {
        // Input may already have landed. Preserve that uncertain result, but
        // fence queued work and automatic observations after losing user focus.
        // Only a fresh model observation may reopen admission; never replay.
        this.desktopObservationRequired = true;
        this.epoch += 1;
        this.desktopEpoch += 1;
        const key = task ? cuaComputerTaskKey(task) : "anonymous";
        const target = this.controlledTargets.get(key);
        if (target) this.takeoverTargets.set(key, { ...target });
      }
      if (
        admittedDesktopEpoch !== this.desktopEpoch &&
        (CUA_READ_TOOLS.has(name) || name === "get_browser_state")
      ) {
        log(
          `refused stale ${name} read (desktop epoch ${admittedDesktopEpoch} -> ${this.desktopEpoch})`,
        );
        return this.desktopPauseReply();
      }
      if (isBrowser && task && reply.ok && !reply.result?.isError)
        this.rememberBrowserTarget(input, reply.result, task);
      if (
        modelObservation &&
        !connection.destroyed &&
        !generation.retired &&
        !generation.didExit &&
        admittedEpoch === this.epoch &&
        this.desktopPauses.size === 0 &&
        reply.ok &&
        !reply.result?.isError &&
        reply.result !== undefined
      ) {
        const nativeObservation =
          (name === "get_window_state" || name === "get_desktop_state") &&
          reply.result.structuredContent?.screenshot_frame_valid !== false &&
          (reply.result.content?.some((part) => part.type === "image" && !!part.data) ||
            Array.isArray(reply.result.structuredContent?.elements));
        const browserObservation =
          name === "get_browser_state" && this.isBrowserSnapshot(input, reply.result);
        if (nativeObservation || browserObservation) {
          if (nativeObservation) this.desktopObservationRequired = false;
          if (browserObservation) {
            const key = this.browserRecoveryKey(input, task);
            if (key) this.browserRecoveryObservations.set(key, this.desktopEpoch);
            while (this.browserRecoveryObservations.size > 256)
              this.browserRecoveryObservations.delete(
                this.browserRecoveryObservations.keys().next().value!,
              );
          }
          const key = task ? cuaComputerTaskKey(task) : "anonymous";
          const interrupted = this.takeoverTargets.get(key);
          if (interrupted && this.observationMatchesTarget(name, input, interrupted, reply.result))
            this.takeoverTargets.delete(key);
          log(`fresh model observation via ${name}; matching input gate cleared`);
        }
      }
      if (name === "get_desktop_state" && reply.result && this.options.normalizeOverview)
        this.options.normalizeOverview(reply.result);
      if (agentLabel && task && !isDriverSessionDeath(reply)) {
        const cursor = generation.taskCursors.get(agentLabel);
        const sameTurn = cursor && cuaComputerTaskKey(cursor.task) === cuaComputerTaskKey(task);
        const firstAction = mutation && (!sameTurn || !cursor.firstActionObserved);
        generation.taskCursors.delete(agentLabel);
        generation.taskCursors.set(agentLabel, {
          task,
          firstActionObserved: mutation || (sameTurn && cursor.firstActionObserved) || false,
          enabled: cursorEnabled ?? cursor?.enabled ?? false,
        });
        if (!cursor || firstAction)
          await this.logCursorState(
            generation,
            agentLabel,
            task,
            firstAction ? "first-action" : "session-created",
          );
        while (generation.taskCursors.size > 256) {
          const oldest = generation.taskCursors.keys().next().value!;
          if (!(await this.endCursorSession(generation, oldest))) {
            // Native idle expiry bounds a failed cosmetic cleanup. Preserve
            // retries under normal load without unbounded per-label metadata.
            generation.taskCursors.delete(oldest);
          }
        }
      }
      return reply;
    } catch (error) {
      let detail = String(error);
      // A call that was cancelled — by the interrupt's abort or before
      // anything was dispatched — proves nothing about the generation's
      // health: nothing it observed indicts the driver. Retiring here would
      // kill the process, its sessions, and its browser bindings on a
      // host-side verdict alone. Every real dispatch failure still retires.
      if (generation && !cancelledBeforeDispatch && !callCancel.signal.aborted) {
        try {
          await this.retire(generation);
        } catch (cleanupError) {
          detail += `; ${String(cleanupError)}`;
        }
      }
      return {
        ok: false,
        error: detail,
        effect: dispatched && mutation ? "dispatched-unknown" : "not-dispatched",
      };
    } finally {
      if (mutation) {
        this.activeForegroundInput = false;
        this.activeInputTaskKey = undefined;
      }
      connection.removeListener("close", abort);
      this.inFlightInputInterrupts.delete(callCancel);
      this.activeTaskCalls.delete(callCancel);
    }
  }

  /** A single bounded read after mint/first action, never periodic polling.
   * Enabled/position are driver state, not proof of pixels reaching a display. */
  private async logCursorState(
    generation: Generation,
    label: string,
    task: CuaComputerTask,
    stage: "session-created" | "first-action",
  ): Promise<void> {
    if (this.observedNativeRevision === 0) return;
    const fields: Record<string, unknown> = {
      event: "computer_cursor",
      ts: new Date().toISOString(),
      thread: task.threadId,
      turn: task.turnId,
      stage,
    };
    try {
      const reply = await cuaRequest<CuaReply>(
        generation.socket,
        {
          method: "call",
          name: "get_agent_cursor_state",
          args: { session: label },
        },
        { timeoutMs: 250 },
      );
      const state = reply.result?.structuredContent;
      const motion = state?.motion as Record<string, unknown> | undefined;
      fields.status = reply.ok && !reply.result?.isError ? "reported" : "unavailable";
      if (typeof state?.enabled === "boolean") fields.enabled = state.enabled;
      if (state && "position" in state) fields.has_position = state.position != null;
      if (typeof motion?.idle_hide_ms === "number" && Number.isFinite(motion.idle_hide_ms))
        fields.idle_hide_ms = motion.idle_hide_ms;
      if (typeof state?.overlay_ready === "boolean") fields.overlay_ready = state.overlay_ready;
      if (typeof state?.render_visible === "boolean") fields.render_visible = state.render_visible;
      if (state?.overlay_scope === "main_display") fields.overlay_scope = state.overlay_scope;
    } catch {
      fields.status = "query-failed";
    }
    log(JSON.stringify(fields));
  }

  private async endCursorSession(generation: Generation, label: string): Promise<boolean> {
    const cursor = generation.taskCursors.get(label);
    const hidden = await this.setTaskCursorEnabled(generation, label, false);
    // A lost reply can mean either visible or hidden. Keep its cleanup handle
    // until acknowledged, and re-enable explicitly if a later action reuses it.
    if (hidden) generation.taskCursors.delete(label);
    else if (cursor) cursor.enabled = false;
    log(
      JSON.stringify({
        event: "computer_cursor",
        ts: new Date().toISOString(),
        thread: cursor?.task.threadId,
        turn: cursor?.task.turnId,
        stage: "task-end",
        status: hidden ? "hidden" : "hide-failed",
      }),
    );
    return hidden;
  }

  private async setTaskCursorEnabled(
    generation: Generation,
    label: string,
    enabled: boolean,
  ): Promise<boolean> {
    try {
      const reply = await cuaRequest<CuaReply>(
        generation.socket,
        {
          method: "call",
          name: "set_agent_cursor_enabled",
          args: { session: label, enabled },
        },
        { timeoutMs: 500 },
      );
      return reply.ok && !reply.result?.isError;
    } catch {
      return false;
    }
  }

  /** End only the latest matching turn, in the same queue as native dispatch.
   * A late terminal for turn A must not remove turn B's reused cursor. */
  private async endTaskCursors(
    task: CuaComputerTask,
    allTurns = task.turnId === undefined,
  ): Promise<void> {
    const previous = this.operations;
    const operation = (async () => {
      await previous;
      const generation = this.generation;
      if (!generation || generation.retired || generation.didExit) return;
      for (const [label, cursor] of generation.taskCursors) {
        if (
          cursor.task.threadId === task.threadId &&
          (allTurns || cursor.task.turnId === task.turnId)
        )
          await this.endCursorSession(generation, label);
      }
    })();
    this.operations = operation.catch(() => undefined);
    await operation;
  }

  private async endTask(
    task: CuaComputerTask,
    allTurns: boolean,
    waitForCursor = true,
  ): Promise<void> {
    const taskKey = cuaComputerTaskKey(task);
    this.controlledTargets.delete(taskKey);
    this.takeoverTargets.delete(taskKey);
    this.monitoredTasks.delete(taskKey);
    if (allTurns) {
      for (const [key, target] of this.controlledTargets) {
        if (target.threadId === task.threadId) this.controlledTargets.delete(key);
      }
      for (const [key, target] of this.takeoverTargets) {
        if (target.threadId === task.threadId) this.takeoverTargets.delete(key);
      }
      for (const [key, threadId] of this.monitoredTasks) {
        if (threadId === task.threadId) this.monitoredTasks.delete(key);
      }
    }
    if (this.monitoredTasks.size === 0) {
      this.inputMonitorRequested = false;
      this.inputMonitorArmed = false;
      this.options.onInputMonitorArmedChange?.(false);
    }
    this.rememberTask(this.endedFrameTasks, task);
    if (
      this.frameTapTask?.threadId === task.threadId &&
      (allTurns || task.turnId === this.frameTapTask.turnId)
    ) {
      this.rememberTask(this.endedFrameTasks, this.frameTapTask);
      this.frameTapTask = undefined;
    }
    // Preview/shield authority ends immediately. Cosmetic cursor cleanup
    // stays on the native queue, but task Stop must not wait for another
    // task's long-running native action merely to hide this task's cursor.
    const cursorEnded = this.endTaskCursors(task, allTurns);
    if (!waitForCursor)
      void cursorEnded.catch((error: unknown) =>
        log(`stopped task cursor cleanup failed: ${String(error)}`),
      );
    await Promise.all([
      this.options.frameTap?.endTask(task),
      this.options.shield?.endTask(task),
      ...(waitForCursor ? [cursorEnded] : []),
    ]);
  }

  /**
   * `SYNARA_CUA_WARM_ON_FIRST_TOUCH=1` asks the host to run the spawn plus
   * validated handshake on first touch, after known grants on a host with a
   * permission bridge. The initial check answers without the driver, so its
   * cold start can overlap subsequent work without caching pre-grant TCC. Warming
   * stops there on purpose: it opens no session, moves no focus, captures no
   * pixels, and fires at most once per host lifetime so a retired driver is
   * never re-warmed by polling alone.
   */
  private warmAttempted = false;

  private warm(): void {
    if (this.warmAttempted || this.closed || this.suspended) return;
    const raw = process.env.SYNARA_CUA_WARM_ON_FIRST_TOUCH?.trim().toLowerCase();
    if (raw !== "1" && raw !== "true" && raw !== "on" && raw !== "yes") return;
    this.warmAttempted = true;
    void this.ensureSpawned().catch((error: unknown) => {
      log(`driver warm-up failed: ${String(error)}`);
    });
  }

  /**
   * Open (or reopen) this generation's persistent control connection: the one
   * socket that sends `session_begin` and then stays open. The driver ties
   * two things to its lifetime — the active-proxy flag that lets
   * browser_download carry the host approval bit, and the EOF reaper that
   * tears down every lifecycle session the transport owns — so the id is
   * reused on reconnect rather than minted fresh: re-beginning the same id
   * re-arms it, and the just-reaped labels sit in `endedBrowserSessions`
   * waiting for revival.
   */
  private async ensureControlSession(generation: Generation): Promise<void> {
    if (generation.controlSocket && !generation.controlSocket.destroyed) return;
    // The dead connection's EOF already reaped its owned sessions on the
    // driver side; mirror that here so callers revive instead of dispatching
    // into a capability namespace the driver no longer holds.
    if (generation.controlSocket) {
      for (const label of generation.liveBrowserSessions)
        generation.endedBrowserSessions.add(label);
      generation.liveBrowserSessions.clear();
    }
    const socket = createConnection(generation.socket);
    generation.controlSocket = socket;
    socket.on("error", () => undefined);
    try {
      const reply = await new Promise<CuaReply>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const timeout = setTimeout(() => reject(new Error("session_begin timed out")), 10_000);
        const fail = () => {
          clearTimeout(timeout);
          reject(new Error("session_begin connection closed"));
        };
        socket.once("close", fail);
        socket.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          const end = Buffer.concat(chunks).indexOf(10);
          if (end < 0) return;
          clearTimeout(timeout);
          socket.removeListener("close", fail);
          socket.removeAllListeners("data");
          try {
            resolve(JSON.parse(Buffer.concat(chunks).subarray(0, end).toString("utf8")));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
        socket.write(
          JSON.stringify({
            method: "session_begin",
            session_id: generation.controlSession,
          }) + "\n",
        );
      });
      if (!reply.ok) throw new Error(reply.error ?? "session_begin refused.");
    } catch (error) {
      socket.destroy();
      if (generation.controlSocket === socket) generation.controlSocket = undefined;
      throw error;
    }
    // Late EOF after a successful begin still means the sessions are gone —
    // keep the dead socket referenced only until the next check notices it.
  }

  /**
   * Spawn plus the validated handshake — the warmable half of startup. The
   * returned generation has no session yet: `openSession` runs that half on
   * the first call that needs it.
   */
  private ensureSpawned(): Promise<Generation> {
    if (this.starting) return this.starting;
    const start = async () => {
      await this.retiring;
      if (this.closed) throw new Error("Computer host is closed.");
      if (this.generation && !this.generation.retired && !this.generation.didExit)
        return this.generation;
      if (this.generation) await this.retire(this.generation);
      try {
        await access(this.options.binaryPath);
      } catch {
        // Same wording as the probe: a raw ENOENT names a path, not a remedy.
        throw new Error(CUA_DRIVER_MISSING_MESSAGE);
      }
      const endpoint =
        process.platform === "win32"
          ? `\\\\.\\pipe\\synara-cua-driver-${randomUUID().slice(0, 8)}`
          : join(this.directory, `driver-${randomUUID().slice(0, 8)}.sock`);
      // Park the compact cursor between actions until end_task removes it,
      // with a one-minute native expiry if cleanup cannot be acknowledged.
      // Idle compact cursors sleep without repainting; model latency must not
      // make the only agent indicator disappear. Upstream cannot parse these flags.
      const expectsPatched = this.options.nativeRevision !== null;
      const child = spawn(
        this.options.binaryPath,
        [
          "serve",
          "--embedded",
          "--socket",
          endpoint,
          ...(expectsPatched
            ? ["--compact-cursor", "--idle-hide-ms", String(CUA_CURSOR_IDLE_HIDE_MS)]
            : []),
        ],
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
      let stderrPending = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        const lines = (stderrPending + chunk.toString("utf8")).split("\n");
        stderrPending = lines.pop()!.slice(-4096);
        for (const line of lines) {
          if (!line.trim()) continue;
          // These native literals carry no app content. Other stderr remains
          // private to the bounded shutdown tail; never stream arbitrary text.
          const overlay = line.match(
            /^synara_cua_overlay_init code=(overlay_display_unavailable|overlay_window_unavailable)$/,
          );
          const restore = line.match(
            /^synara_cua_focus_restore status=(not-needed|restored|failed|unobservable|user-changed)$/,
          );
          if (overlay || restore)
            log(
              JSON.stringify({
                event: overlay ? "computer_cursor_init" : "computer_focus_restore",
                ts: new Date().toISOString(),
                ...(overlay ? { code: overlay[1] } : { status: restore![1] }),
              }),
            );
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
        nativeInputEpoch: 0,
        browserInputControl: false,
        child,
        socket: endpoint,
        session: `synara-${randomUUID()}`,
        exited,
        didExit: false,
        retired: false,
        cancellationReady: false,
        inputInFlight: false,
        inputTask: undefined,
        browserInputInFlight: false,
        inputEverDispatched: false,
        controlSession: `synara-transport-${randomUUID()}`,
        controlSocket: undefined,
        endedBrowserSessions: new Set<string>(),
        liveBrowserSessions: new Set<string>(),
        endedTaskSessions: new Set<string>(),
        appliedCursorStyle: "",
        appliedSessionCursorStyles: new Map<string, string>(),
        taskCursors: new Map<string, TaskCursor>(),
      };
      this.generation = generation;
      this.updateInputMonitorArmed();
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
        // `nativeRevision: null` expects an unpatched upstream driver — its
        // metadata carries no Synara revision and the field must not be
        // required. A patched build is still accepted there: a superset of
        // the expected identity is never a downgrade.
        const expectedNativeRevision =
          this.options.nativeRevision === undefined
            ? CUA_NATIVE_REVISION
            : this.options.nativeRevision;
        const reportedRevision = metadata?.result?.synara_native_revision;
        if (
          !metadata?.ok ||
          metadata.result?.driver_version !== CUA_DRIVER_VERSION ||
          (expectedNativeRevision !== null && reportedRevision !== expectedNativeRevision) ||
          metadata.result?.embedded !== true ||
          metadata.result?.pid !== child.pid
        )
          throw new Error("Cua Driver identity/version/native revision handshake failed.");
        this.observedNativeRevision =
          typeof reportedRevision === "number" && Number.isSafeInteger(reportedRevision)
            ? reportedRevision
            : 0;
        generation.browserInputControl =
          process.platform === "linux" &&
          reportedRevision === CUA_NATIVE_REVISION &&
          metadata.result?.synara_browser_input_control === 1;
        if (generation.retired || generation.didExit)
          throw new Error("Cua Driver stopped during startup.");
        generation.cancellationReady =
          expectedNativeRevision !== null || generation.browserInputControl;
        if (process.platform !== "win32") await chmod(endpoint, 0o600);
        if (generation.retired || generation.didExit)
          throw new Error("Cua Driver stopped during startup.");
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

  /**
   * The session half of startup: `start_session` plus the once-per-generation
   * cursor-motion setup, opened lazily on the first call that needs it so the
   * warm path can stop at the validated handshake. Runs once per generation;
   * a failure retires the generation so the next call starts clean rather
   * than reusing a half-opened session.
   */
  private async openSession(generation: Generation): Promise<void> {
    generation.sessionOpening ??= (async () => {
      const startupTimeoutMs = this.options.startupTimeoutMs ?? 5_000;
      if (generation.retired || generation.didExit)
        throw new Error("Cua Driver stopped during startup.");
      const session = await cuaRequest<CuaReply>(
        generation.socket,
        {
          method: "call",
          name: "start_session",
          args: { session: generation.session },
        },
        { timeoutMs: startupTimeoutMs },
      );
      if (!session.ok || session.result?.isError)
        throw new Error("Cua session initialization failed.");
      if (generation.retired || generation.didExit)
        throw new Error("Cua Driver stopped during startup.");
      // Configure once per native generation, not before each input. The
      // cursor remains visible without making travel distance delay the action.
      const motion = await cuaRequest<CuaReply>(
        generation.socket,
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
      // The user's cursor colors, read at the same once-per-generation timing
      // as the motion feel. Stock sends nothing at all, so a default install
      // keeps the driver's own monochrome art; an unpatched upstream driver
      // has no style tool, so a configured style stays stock there. The
      // shared session rarely paints an action (task calls carry their own
      // label), so this is best-effort: a cosmetic color must never retire a
      // driver, and the per-task application below carries the real work.
      const style = normalizeCuaCursorStyle(this.options.cursorStyle?.());
      if (style && this.observedNativeRevision !== 0) {
        try {
          const styled = await cuaRequest<CuaReply>(
            generation.socket,
            {
              method: "call",
              name: "set_agent_cursor_style",
              args: { session: generation.session, ...style },
            },
            { timeoutMs: startupTimeoutMs },
          );
          if (!styled.ok || styled.result?.isError) {
            log("shared cursor session style was refused; keeping the stock cursor");
          } else {
            generation.appliedCursorStyle = JSON.stringify(style);
          }
        } catch (error) {
          log(`shared cursor session style failed: ${String(error)}`);
        }
      }
    })();
    try {
      await generation.sessionOpening;
    } catch (error) {
      await this.retire(generation);
      throw error;
    }
  }

  private async ensureStarted(): Promise<Generation> {
    const generation = await this.ensureSpawned();
    await this.openSession(generation);
    return generation;
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
    this.browserTargets.clear();
    this.browserRecoveryObservations.clear();
    if (this.nativeInputCleanupPending === generation) this.nativeInputCleanupPending = undefined;
    this.updateInputMonitorArmed();
    // Browser teardown rides the control connection's lifetime: closing it
    // now lets the driver's EOF reaper end every session this transport owns
    // while the daemon is still alive to run its cleanup hooks, instead of
    // racing termination.
    generation.controlSocket?.destroy();
    generation.controlSocket = undefined;
    this.retiring = this.retiring.then(async () => {
      // Captured up front: the flag clears on confirmed cleanup, and a driver
      // exit event can land after the dead socket already broke the request —
      // either ordering leaves the OS believing a synthetic button or modifier
      // is held, and a user click landing under it feels dead system-wide.
      const inputUncertain = generation.inputInFlight;
      const releaseHeldInput = async () => {
        if (!inputUncertain || generation.browserInputInFlight || !this.options.releaseHeldInput)
          return false;
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
          cleanupConfirmed =
            reply.ok === true && cuaCleanupAcknowledged(reply.result, generation.child.pid);
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

  /**
   * Mirror a cursor-color change onto the live driver session. The preference
   * itself is durable in the caller; this only pushes it to a generation whose
   * session is already open, so changing a setting never spawns a driver. A
   * failed push is logged and never fatal — the next session open reads the
   * preference again. Passing null/undefined restores the stock cursor.
   */
  setCursorStyle(style: CuaCursorStyle | null | undefined): Promise<void> {
    const next = normalizeCuaCursorStyle(style);
    const nextJson = next ? JSON.stringify(next) : "";
    const apply = async (): Promise<void> => {
      const generation = this.generation;
      if (!generation || generation.retired || generation.didExit) return;
      // A generation without an opened session takes the preference at its
      // next open; a settings change must not warm or spawn a driver.
      if (!generation.sessionOpening) return;
      await generation.sessionOpening.catch(() => undefined);
      if (
        this.closed ||
        generation.retired ||
        generation.didExit ||
        generation.appliedCursorStyle === nextJson ||
        this.observedNativeRevision === 0
      )
        return;
      try {
        const reply = await cuaRequest<CuaReply>(
          generation.socket,
          {
            method: "call",
            name: "set_agent_cursor_style",
            args: next ? { session: generation.session, ...next } : { session: generation.session },
          },
          { timeoutMs: 5_000 },
        );
        if (!reply.ok || reply.result?.isError) {
          log("live cursor style push was refused; keeping the previous style");
          return;
        }
        generation.appliedCursorStyle = nextJson;
      } catch (error) {
        log(`live cursor style push failed: ${String(error)}`);
      }
    };
    this.cursorStyleUpdates = this.cursorStyleUpdates.then(apply, apply);
    return this.cursorStyleUpdates;
  }

  /**
   * Apply the current cursor preference to one task cursor session before its
   * first dispatch. Task sessions never inherit the shared generation
   * session's style — the driver seeds every lazily-created session cursor
   * from its launch template — so the user's colors must be sent to the
   * session the action actually paints under. Failures are logged and cost
   * the action nothing: the cursor keeps the style it already had.
   */
  private async applyCursorStyleForSession(generation: Generation, session: string): Promise<void> {
    const style = normalizeCuaCursorStyle(this.options.cursorStyle?.());
    const previous = generation.appliedSessionCursorStyles.get(session);
    // Stock with no prior override: the template default is already correct,
    // so nothing is sent (a default install never talks to the style tool).
    if (!style && previous === undefined) return;
    const styleJson = style ? JSON.stringify(style) : "";
    if (previous === styleJson) return;
    if (this.observedNativeRevision === 0) return;
    try {
      const reply = await cuaRequest<CuaReply>(
        generation.socket,
        {
          method: "call",
          name: "set_agent_cursor_style",
          args: style ? { session, ...style } : { session },
        },
        { timeoutMs: 5_000 },
      );
      if (!reply.ok || reply.result?.isError) {
        log("task cursor style was refused; keeping the previous cursor");
        return;
      }
      if (style) generation.appliedSessionCursorStyles.set(session, styleJson);
      else generation.appliedSessionCursorStyles.delete(session);
      while (generation.appliedSessionCursorStyles.size > 256) {
        generation.appliedSessionCursorStyles.delete(
          generation.appliedSessionCursorStyles.keys().next().value!,
        );
      }
    } catch (error) {
      log(`task cursor style setup failed: ${String(error)}`);
    }
  }

  stop(): Promise<void> {
    this.inputMonitorRequested = false;
    if (this.inputMonitorArmed) {
      this.inputMonitorArmed = false;
      this.options.onInputMonitorArmedChange?.(false);
    }
    this.controlledTargets.clear();
    this.takeoverTargets.clear();
    this.browserTargets.clear();
    this.browserRecoveryObservations.clear();
    this.monitoredTasks.clear();
    this.epoch += 1;
    // A read dispatched before a stop must not be admitted as a fresh
    // observation afterwards: bumping the desktop epoch turns that silent
    // clear-void into a visible stale-read refusal.
    this.desktopEpoch += 1;
    for (const cancel of this.pendingPermissionChecks.keys()) cancel();
    const admitted = this.operations;
    const frameTapStopped = this.options.frameTap?.stop();
    // Any shield still up belongs to an excursion this stop interrupts: drop
    // it (and its helper) in parallel with the driver retire, same discipline.
    const shieldStopped = this.options.shield?.stop();
    // Same discipline as `stopping` below: the stop caller sees the failure
    // through the returned promise, never through an unhandled rejection.
    void frameTapStopped?.catch(() => undefined);
    void shieldStopped?.catch(() => undefined);
    const stopping = this.stopping.then(async () => {
      if (this.generation) await this.retire(this.generation);
      await this.starting?.catch(() => undefined);
      if (this.generation) await this.retire(this.generation);
      await admitted;
      await this.retiring;
      await frameTapStopped;
      await shieldStopped;
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

  /** Interrupt native input without retiring browser/session identity. Socket
   * abort gives callers a prompt uncertain result; only the native gate's
   * acknowledged drain authorizes later input. */
  private interruptInput(): Promise<void> {
    this.epoch += 1;
    this.desktopEpoch += 1;
    for (const cancel of this.pendingPermissionChecks.keys()) cancel();
    const admitted = this.operations;
    const frameTapStopped = this.options.frameTap?.stop();
    const shieldStopped = this.options.shield?.stop();
    // Same discipline as stop(): the interrupt caller sees failures through
    // the returned promise, never through an unhandled rejection.
    void frameTapStopped?.catch(() => undefined);
    void shieldStopped?.catch(() => undefined);
    for (const interrupt of this.inFlightInputInterrupts) interrupt.abort();
    const interrupting = this.stopping.then(async () => {
      await this.starting?.catch(() => undefined);
      if (this.generation) await this.interruptNativeInput(this.generation);
      await admitted;
      await this.retiring;
      await frameTapStopped;
      await shieldStopped;
    });
    // Same discipline as `retiring`/`stopping` everywhere else: the caller
    // sees the failure but the chain must not — one failed interrupt must
    // not refuse every later one for the host's lifetime.
    this.stopping = interrupting.then(
      () => undefined,
      () => undefined,
    );
    return interrupting;
  }

  private async interruptNativeInput(generation: Generation): Promise<void> {
    if (generation.retired || generation.didExit) return;
    // The upstream Linux driver has no macOS native input gate. Preserve its
    // existing transport stop; this branch makes no native cleanup claim.
    if (this.options.nativeRevision === null && !generation.browserInputControl) return;
    this.nativeInputCleanupPending = generation;
    let confirmed = false;
    try {
      const reply = await cuaRequest<CuaReply>(
        generation.socket,
        { method: "interrupt_input", args: { expected_pid: generation.child.pid } },
        { timeoutMs: 5_000 },
      );
      const state = reply.result;
      confirmed =
        reply.ok === true &&
        state !== undefined &&
        state.pid === generation.child.pid &&
        state.input_interrupted === true &&
        state.input_admission_open === true &&
        state.cleanup_complete === true &&
        state.pending_input === 0 &&
        typeof state.input_epoch === "number" &&
        Number.isSafeInteger(state.input_epoch) &&
        state.input_epoch > generation.nativeInputEpoch;
      if (confirmed) generation.nativeInputEpoch = state!.input_epoch as number;
    } catch {
      confirmed = false;
    }
    if (generation.retired || generation.didExit) return;
    if (!confirmed) {
      // The native barrier stays closed. OS releases are only a fallback for
      // unconfirmed cleanup, never proof that the old input loop has stopped.
      if (!generation.browserInputInFlight)
        await this.options.releaseHeldInput?.().catch((error: unknown) => {
          log(`interrupted held-input release failed: ${String(error)}`);
        });
      throw new Error(
        "Cua Driver has not confirmed input interruption and cleanup. Input remains paused; a later attempt will recheck the native drain.",
      );
    }
    generation.inputInFlight = false;
    generation.browserInputInFlight = false;
    generation.inputTask = undefined;
    if (this.nativeInputCleanupPending === generation) this.nativeInputCleanupPending = undefined;
  }

  /**
   * Physical Escape interrupt — momentary and self-healing. The press arms
   * the {@link ESCAPE_INPUT_COOLDOWN_MS} cooldown and runs
   * {@link interruptInput}: queued work is cancelled, in-flight mutating
   * calls receive an uncertain result, and native input drains with its own
   * matching releases. The driver and browser bindings survive. A fresh model
   * observation is required before resuming, with no extra approval dialog.
   *
   * Returns whether the press engaged the interrupt. With no live or
   * spawning driver generation, Escape is an ordinary key: the desktop
   * ignores the event instead of interrupting a host nothing was driving.
   */
  emergencyStopInput(): boolean {
    if (this.closed) return false;
    if (this.generation === undefined && this.starting === undefined) return false;
    log("physical Escape: interrupting computer input");
    this.desktopObservationRequired = true;
    this.browserObservationRequired = true;
    this.inputInterruptCooldownUntil = Date.now() + ESCAPE_INPUT_COOLDOWN_MS;
    void this.interruptInput().catch((error: unknown) => {
      log(`emergency input interrupt failed: ${String(error)}`);
    });
    return true;
  }

  /** A human changing the controlled target invalidates the model's view.
   * Typing in a different app does not interrupt background control. */
  physicalInput(event: PhysicalComputerInput): boolean {
    if (this.closed || !this.generation || this.generation.retired) return false;
    const affected = [...this.controlledTargets].filter(
      ([key, target]) =>
        (this.activeForegroundInput && key === this.activeInputTaskKey) ||
        (event.pid !== undefined &&
          target.pid === event.pid &&
          (event.windowId === undefined ||
            target.windowId === undefined ||
            target.windowId === event.windowId)),
    );
    if (!this.activeForegroundInput && affected.length === 0) return false;
    const alreadyPaused =
      this.desktopObservationRequired ||
      this.browserObservationRequired ||
      this.takeoverTargets.size > 0;
    if (!alreadyPaused) {
      log(
        JSON.stringify({
          event: "computer_physical_input",
          ts: new Date().toISOString(),
          pid: safeNativeId(event.pid),
          windowId: safeNativeId(event.windowId),
          targets: affected.map(([, target]) => ({
            thread: target.threadId,
            pid: target.pid,
            windowId: target.windowId,
          })),
          foreground: this.activeForegroundInput,
        }),
      );
    }
    for (const [key, target] of affected) this.takeoverTargets.set(key, { ...target });
    if (this.activeForegroundInput && affected.length === 0) {
      this.desktopObservationRequired = true;
      this.browserObservationRequired = true;
    }
    const affectedInputInFlight =
      (this.activeForegroundInput || affected.some(([key]) => key === this.activeInputTaskKey)) &&
      [...this.inFlightInputInterrupts].some((input) => !input.signal.aborted);
    this.inputInterruptCooldownUntil = Date.now() + ESCAPE_INPUT_COOLDOWN_MS;
    if (alreadyPaused && !affectedInputInFlight) {
      // Repeated typing keeps observations stale without sending one native
      // cancellation RPC per key. No new mutation can enter this paused gate.
      this.epoch += 1;
      this.desktopEpoch += 1;
      return true;
    }
    void this.interruptInput().catch((error: unknown) =>
      log(`human takeover interrupt failed: ${String(error)}`),
    );
    return true;
  }

  inputMonitorStateChanged(state: ComputerInputMonitorState): void {
    if (
      state.ready ||
      state.error === "input_monitor_idle" ||
      state.error === "input_monitor_starting" ||
      this.closed ||
      !this.generation ||
      this.generation.retired
    )
      return;
    this.desktopObservationRequired = true;
    this.browserObservationRequired = true;
    this.inputMonitorEpochChanges += 1;
    void this.interruptInput().catch((error: unknown) =>
      log(`input listener interruption failed: ${String(error)}`),
    );
  }

  /**
   * The helper only reports Escape while a live generation could dispatch
   * input: armed on spawn, disarmed on retire, kill, or close.
   */
  private updateInputMonitorArmed(): void {
    const armed =
      !this.closed &&
      this.generation !== undefined &&
      !this.generation.retired &&
      (!this.options.activateInputMonitor || this.inputMonitorRequested);
    if (armed === this.inputMonitorArmed) return;
    this.inputMonitorArmed = armed;
    try {
      this.options.onInputMonitorArmedChange?.(armed);
    } catch {
      // Monitor plumbing must never take input admission down with it.
    }
  }

  private ownPids(): ReadonlySet<number> {
    return this.options.ownPids?.() ?? CuaDriverHost.defaultOwnPids;
  }

  /** User Stop revokes the turn without changing OS grants. */
  async stopTaskByUser(task: CuaComputerTask): Promise<void> {
    await this.stopTaskInput(task);
  }

  private async stopTaskInput(task: CuaComputerTask): Promise<"task" | "generation"> {
    const key = cuaComputerTaskKey(task);
    const matches = (candidate: CuaComputerTask) =>
      candidate.threadId === task.threadId &&
      (task.turnId === undefined || candidate.turnId === task.turnId);
    const stoppedKeys = new Set([key]);
    this.rememberTask(this.userStoppedTasks, task);
    for (const known of this.knownTasks.values()) {
      if (!matches(known)) continue;
      stoppedKeys.add(cuaComputerTaskKey(known));
      this.rememberTask(this.userStoppedTasks, known);
    }
    for (const admitted of this.admittedTaskRequests) {
      if (!matches(admitted.task)) continue;
      admitted.stopped = true;
      stoppedKeys.add(cuaComputerTaskKey(admitted.task));
      this.rememberTask(this.userStoppedTasks, admitted.task);
    }
    for (const [cancel, owner] of this.pendingPermissionChecks) {
      if (owner !== undefined && stoppedKeys.has(owner)) cancel();
    }
    for (const [cancel, owner] of this.activeTaskCalls) {
      if (stoppedKeys.has(owner)) cancel.abort();
    }
    // Native input is serialized but shares one cancellation gate. Once
    // this task dispatched input, stopping it must drain that generation
    // and fence queued siblings too. Idle/queued tasks and observations
    // need only their own revocation; they must not interrupt another task.
    // A thread-wide Stop matches its admitted/known turns. It must not
    // interrupt another thread just because the caller omitted a turn id.
    const scope =
      this.generation?.inputInFlight &&
      this.generation.inputTask !== undefined &&
      matches(this.generation.inputTask)
        ? "generation"
        : "task";
    const interrupted = scope === "generation" ? this.interruptInput() : Promise.resolve();
    await Promise.all([interrupted, this.endTask(task, task.turnId === undefined, false)]);
    log(
      JSON.stringify({
        event: "computer_task_stop",
        thread: task.threadId,
        turn: task.turnId,
        scope,
      }),
    );
    return scope;
  }

  private taskStoppedReply(): CuaReply {
    return {
      ok: false,
      error: "The user stopped computer use for this turn. Do not retry actions.",
      effect: "not-dispatched",
    };
  }

  private rememberTask(set: Set<string>, task: CuaComputerTask): void {
    set.add(cuaComputerTaskKey(task));
    while (set.size > 256) set.delete(set.values().next().value!);
  }

  private inputMonitorAvailable(name: string, input: unknown): boolean {
    const linuxBrowserMutation =
      process.platform === "linux" &&
      CUA_BROWSER_MUTATION_TOOLS.has(name) &&
      !linuxBrowserCallIsReadOnly(name, input);
    const required =
      CUA_ACTION_TOOLS.has(name) ||
      linuxBrowserMutation ||
      (process.platform === "darwin" &&
        this.options.nativeRevision !== null &&
        CUA_BROWSER_MUTATION_TOOLS.has(name));
    if (!required) return true;
    const monitor = this.options.inputMonitorState?.();
    // Existing portable native paths do not have a listener contract. The
    // verified Linux browser port does: missing integration is not readiness.
    return monitor?.ready ?? !linuxBrowserMutation;
  }

  /** A separate owned browser can be set up while old targets remain paused.
   * Setup itself grants no recovery: its exact target/tab still needs a model
   * snapshot before input, and a fresh page never unlocks an older target. */
  private isIsolatedBrowserSetup(name: string, input: unknown): boolean {
    if (name !== "browser_prepare" || !input || typeof input !== "object" || Array.isArray(input))
      return false;
    const args = input as Record<string, unknown>;
    const profile = args.profile;
    return (
      args.allow_launch === true &&
      args.pid === undefined &&
      args.window_id === undefined &&
      args.target_id === undefined &&
      args.strategy === undefined &&
      profile !== null &&
      typeof profile === "object" &&
      !Array.isArray(profile) &&
      ((profile as Record<string, unknown>).mode === "isolated_new" ||
        (profile as Record<string, unknown>).mode === "isolated_named")
    );
  }

  private browserRecoveryKey(
    input: unknown,
    task: CuaComputerTask | undefined,
  ): string | undefined {
    if (!task || !input || typeof input !== "object" || Array.isArray(input)) return undefined;
    const args = input as Record<string, unknown>;
    if (
      typeof args.target_id !== "string" ||
      args.target_id.length === 0 ||
      typeof args.tab_id !== "string" ||
      args.tab_id.length === 0
    )
      return undefined;
    return JSON.stringify([cuaComputerTaskKey(task), args.target_id, args.tab_id]);
  }

  private hasBrowserRecoveryObservation(
    input: unknown,
    task: CuaComputerTask | undefined,
  ): boolean {
    const key = this.browserRecoveryKey(input, task);
    return key !== undefined && this.browserRecoveryObservations.get(key) === this.desktopEpoch;
  }

  private controlledTarget(
    input: unknown,
    task: CuaComputerTask | undefined,
    browser: boolean,
  ): ControlledTarget | undefined {
    if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
    const args = input as Record<string, unknown>;
    if (browser && task && typeof args.target_id === "string") {
      const bound = this.browserTargets.get(JSON.stringify([task.threadId, args.target_id]));
      if (bound)
        return {
          ...bound,
          ...(typeof args.tab_id === "string" ? { browserTabId: args.tab_id } : {}),
        };
    }
    if (
      typeof args.pid !== "number" ||
      !Number.isSafeInteger(args.pid) ||
      args.pid <= 0 ||
      args.pid > 0x7fffffff
    )
      return undefined;
    return {
      pid: args.pid,
      ...(task ? { threadId: task.threadId } : {}),
      ...(typeof args.window_id === "number" &&
      Number.isSafeInteger(args.window_id) &&
      args.window_id > 0 &&
      args.window_id <= 0xffffffff
        ? { windowId: args.window_id }
        : {}),
    };
  }

  private rememberBrowserTarget(
    input: unknown,
    result: CuaToolResult | undefined,
    task: CuaComputerTask,
  ): void {
    const data = result?.structuredContent;
    if (data?.status !== "ok" || data.mode !== "bind" || typeof data.target_id !== "string") return;
    const target = this.controlledTarget(input, task, false);
    if (!target) return;
    const bound = { ...target, browserTargetId: data.target_id };
    this.browserTargets.set(JSON.stringify([task.threadId, data.target_id]), bound);
    while (this.browserTargets.size > 256)
      this.browserTargets.delete(this.browserTargets.keys().next().value!);
    this.controlledTargets.set(cuaComputerTaskKey(task), bound);
  }

  private isBrowserSnapshot(input: unknown, result: CuaToolResult): boolean {
    if (!input || typeof input !== "object" || Array.isArray(input)) return false;
    const args = input as Record<string, unknown>;
    const data = result.structuredContent;
    const snapshot = data?.snapshot;
    const snapshotId =
      data?.snapshot_id ??
      (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
        ? (snapshot as Record<string, unknown>).id
        : undefined);
    return (
      data?.status === "ok" &&
      data.mode === "snapshot" &&
      typeof args.target_id === "string" &&
      args.target_id.length > 0 &&
      typeof args.tab_id === "string" &&
      args.tab_id.length > 0 &&
      data.target_id === args.target_id &&
      data.tab_id === args.tab_id &&
      typeof snapshotId === "string" &&
      /^p[0-9]+$/.test(snapshotId) &&
      Array.isArray(data.refs)
    );
  }

  private observationMatchesTarget(
    name: string,
    input: unknown,
    target: ControlledTarget,
    result: CuaToolResult,
  ): boolean {
    if (!input || typeof input !== "object" || Array.isArray(input)) return false;
    const args = input as Record<string, unknown>;
    if (target.browserTargetId !== undefined) {
      if (name !== "get_browser_state") return false;
      return (
        args.target_id === target.browserTargetId &&
        (target.browserTabId === undefined || args.tab_id === target.browserTabId)
      );
    }
    // A model may deliberately re-aim at a usable sibling after the old window
    // closes or moves off-Space. Never let an overview, another app, a degraded
    // capture, or an empty sibling tree clear the task's takeover gate.
    const state = result.structuredContent;
    const exactWindow = args.window_id === target.windowId;
    return (
      name === "get_window_state" &&
      args.pid === target.pid &&
      state?.pid === target.pid &&
      safeNativeId(args.window_id) !== undefined &&
      state.window_id === args.window_id &&
      !state.degraded &&
      state.screenshot_frame_valid !== false &&
      (target.windowId === undefined ||
        exactWindow ||
        (state.window_is_on_screen === true &&
          state.window_on_current_space === true &&
          Array.isArray(state.elements) &&
          state.elements.length > 0))
    );
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
    this.options.frameTap.update({
      task,
      pid: best.pid,
      windowId: best.windowId,
    });
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

  /**
   * The interruption state every host reply piggybacks: the sorted pause
   * reasons active right now, and the never-reset interruption count. The
   * count is the load-bearing half — a lock that engages and releases between
   * two replies nets `desktopPauses` back to `[]`, so only the advancing
   * counter proves the interruption cycle ran at all.
   */
  private desktopState(): Pick<
    CuaReply,
    | "desktopEpoch"
    | "desktopPauses"
    | "desktopInterruptions"
    | "driverNativeRevision"
    | "driverBrowserInputControl"
    | "hostPlatform"
  > {
    return {
      desktopEpoch: this.desktopEpoch,
      desktopPauses: [...this.desktopPauses].toSorted(),
      desktopInterruptions: this.desktopInterruptionCount,
      hostPlatform: process.platform,
      ...(this.observedNativeRevision !== undefined
        ? { driverNativeRevision: this.observedNativeRevision }
        : {}),
      ...(process.platform === "linux"
        ? {
            driverBrowserInputControl:
              this.generation?.browserInputControl === true &&
              !this.generation.retired &&
              !this.generation.didExit,
          }
        : {}),
    };
  }

  /** OS desktop state is independent of backend restarts. A backend resume
   * cannot reopen input while the screen is locked or another user is active. */
  pauseDesktop(reason: string): Promise<void> {
    this.desktopPauses.add(reason);
    this.desktopInterruptionCount += 1;
    this.desktopObservationRequired = true;
    this.browserObservationRequired = true;
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
        : "Computer input was interrupted or the user changed the controlled window. Read fresh computer state and inspect it before continuing; do not replay an uncertain action.";
    return {
      ok: true,
      result: {
        isError: true,
        content: [{ type: "text", text: message }],
        structuredContent: {
          effect: "refused",
          code: "computer_input_paused",
          layer: "driver-host",
          message,
          requery_hint:
            "After physical input stops, observe a usable window of the affected app with computer_get_state and its exact window_id. Do not replay an uncertain action.",
        },
      },
    };
  }

  /**
   * The cooldown refusal a mutating call gets inside the physical-Escape
   * interrupt window. Same dialect as a desktop pause — the backend reads
   * `effect: "refused"` as `not-dispatched`. The deadline bounds the quiet
   * period; a separate fresh-observation gate prevents blind continuation.
   */
  private inputMonitorUnavailableReply(monitor = this.options.inputMonitorState?.()): CuaReply {
    const message =
      process.platform === "linux"
        ? "A working global Escape stop is unavailable in this Linux desktop session. Computer browser actions remain paused; browser observation is still available."
        : monitor?.error === "input-monitoring-required"
          ? "Allow Input Monitoring in System Settings, then wait for the computer input listener to reconnect before continuing."
          : "The computer input listener is unavailable. Input remains paused until the listener reconnects.";
    return {
      ok: true,
      result: {
        isError: true,
        content: [{ type: "text", text: message }],
        structuredContent: {
          effect: "refused",
          code: "input_monitor_unavailable",
          message,
          ...(monitor?.error ? { input_monitor_error: monitor.error } : {}),
        },
      },
    };
  }

  private inputInterruptedReply(): CuaReply {
    const message =
      "Computer input was interrupted by physical input. Wait for the user to finish, then read fresh computer state before continuing. Do not replay an uncertain action.";
    return {
      ok: true,
      result: {
        isError: true,
        content: [{ type: "text", text: message }],
        structuredContent: {
          effect: "refused",
          code: "computer_input_paused",
          layer: "driver-host",
          message,
          wait_seconds: Math.max(0, (this.inputInterruptCooldownUntil - Date.now()) / 1000),
          requery_hint:
            "Wait, then observe the affected target before deciding the next action. Waiting alone does not resume input.",
        },
      },
    };
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.updateInputMonitorArmed();
    try {
      await this.stop();
    } finally {
      await this.options.frameTap?.dispose().catch(() => undefined);
      await this.options.shield?.dispose().catch(() => undefined);
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

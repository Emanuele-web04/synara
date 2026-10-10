import { createConnection } from "node:net";
import release from "./cuaDriverRelease.json" with { type: "json" };

export const CUA_DRIVER_VERSION = release.version;
export const CUA_NATIVE_REVISION = release.nativeRevision;
export const CUA_DRIVER_SOURCE = release.source;
export const CUA_DRIVER_ARCHIVE_SHA256 = release.sha256;
export const CUA_HOST_SOCKET_ENV = "SYNARA_CUA_HOST_SOCKET";
// Setup includes native input retirement and a bounded, user-facing permission request.
export const CUA_SETUP_TIMEOUT_MS = 120_000;
export const CUA_MAX_RESPONSE_BYTES = 96 * 1024 * 1024;
/**
 * Host protocol notes for the pinned driver.
 *
 * The GUI host speaks newline-delimited JSON over the per-generation unix
 * socket `cuaRequest` dials: one request, one response, connection closed.
 * Two request shapes matter beyond the SDK tool calls in {@link CUA_READ_TOOLS}
 * and {@link CUA_ACTION_TOOLS}.
 *
 * `metadata` — the handshake. A fresh generation answers
 * `synara_native_revision`, which the host compares to
 * {@link CUA_NATIVE_REVISION} before any action tool may be dispatched: a
 * driver that cannot prove the patched cancellation revision is retired
 * seconds after spawn rather than trusted with held OS input.
 *
 * `cancel_input` — the private teardown method, accepted only from the
 * authenticated embedded parent connection and only for the exact child PID
 * the host spawned. The host sends `{method:"cancel_input", args:
 * {expected_pid}}` when a live generation must drain held input before
 * retirement. The driver's reply `result` is the cleanup acknowledgement:
 *
 * - `pid`: echoes the child PID that cleaned up. The host requires it to
 *   equal the spawned child's PID so a response cannot vouch for a process
 *   it did not clean.
 * - `input_admission_closed`: `true` once the driver's in-gate has stopped
 *   admitting new input — the point past which nothing else can begin.
 * - `cleanup_complete`: `true` once every registered input release and
 *   action context has drained; `false` while any is still pending.
 * - `pending_input`: the count of releases/contexts still outstanding; the
 *   acknowledgement is complete only at `0`.
 *
 * The host accepts the acknowledgement only when all four hold:
 * `pid === child.pid && input_admission_closed === true &&
 * cleanup_complete === true && pending_input === 0` — the exact check
 * {@link cuaCleanupAcknowledged} performs against {@link CuaCleanupAcknowledgement}.
 * When the acknowledgement
 * is absent or invalid the host does not kill or replace the generation —
 * an unverifiable driver may still be holding OS input, so admission closes
 * for the host's lifetime instead of compounding the uncertainty with a
 * replacement process. A generation that exits mid-input without the
 * acknowledgement fails closed the same way unless an OS-level held-input
 * release can be confirmed.
 *
 * Every dispatch carries the control-session id the generation minted
 * (`session_id` / the `session` arg), and replies may report a
 * `desktopEpoch` — the host's interruption generation — so a stale reply
 * from before a Space change or revocation cannot be mistaken for a live
 * one.
 *
 * Host replies additionally piggyback two desktop-availability fields so
 * the backend learns lock/session interruptions without an event channel:
 * `desktopPauses`, the sorted pause reasons active at reply time
 * (`"screen-lock"`, `"system-sleep"`, `"user-session"`), and
 * `desktopInterruptions`, a never-reset count of the host's `pauseDesktop`
 * transitions. The count is the signal that survives an unobserved cycle:
 * a lock that engages and releases between two replies nets `desktopPauses`
 * back to `[]`, so only the advancing count proves the interruption ran —
 * which is what the server uses to invalidate pre-interruption task
 * consent. Unlike `desktopEpoch`, which also advances on ordinary stops,
 * the counter moves only on real OS interruptions.
 *
 * `shield` — the masked-activation overlay method, answered by the GUI host
 * itself (never forwarded to the driver). Its args are validated by
 * {@link parseCuaShieldArgs}:
 *
 * - `{action:"engage", shield_id, frame, window_id, pid, label?}` shows the
 *   Synara-owned shield panel over `frame` (screen coordinates, top-left
 *   origin, points) and confirms once it is on screen. The host refuses
 *   while closed, suspended, or desktop-paused so a shield never arms under
 *   an interrupted desktop. `shield_id` is minted by the caller — a lost
 *   reply still leaves the caller holding the cleanup handle.
 * - `{action:"release", shield_id}` drops exactly that shield. Missing ids
 *   are acknowledged as already gone — release is idempotent.
 * - `{action:"release_all"}` is the forced-release escape hatch: it drops
 *   every live shield regardless of attribution and answers
 *   `{released: <count>}` so the caller can tell "nothing was up" from
 *   "shields were dropped".
 *
 * Release paths are accepted in every host state — teardown must never be
 * gated on admission health. The helper itself is the deeper backstop: it
 * watches its parent process, its stdin EOF, a per-shield TTL, and the
 * Space/display notifications, and WindowServer removes its windows outright
 * when the process dies.
 */
export interface CuaComputerTask {
  threadId: string;
  turnId?: string;
  label?: string;
}

export interface CuaPreviewTarget {
  task: CuaComputerTask;
  pid: number;
  windowId: number;
  cursor?: { x: number; y: number };
}

export function cuaComputerTaskKey(task: CuaComputerTask): string {
  return JSON.stringify([task.threadId, task.turnId ?? null]);
}

/**
 * Shield ids travel both directions of the `shield` request — the caller
 * mints them so a lost engage reply still leaves a releasable handle, and
 * the helper echoes them in its events. A conservative printable-ASCII shape
 * keeps the id safe to carry on the helper's whitespace-delimited stdin
 * command lines.
 */
export const CUA_SHIELD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Geometry bounds a shield may cover: display-scale points, never absurd. */
export const CUA_SHIELD_MAX_EXTENT = 32_768;
export const CUA_SHIELD_MAX_COORDINATE = 1_000_000;

export type CuaShieldArgs =
  | {
      readonly action: "engage";
      readonly shieldId: string;
      readonly frame: { x: number; y: number; width: number; height: number };
      readonly windowId: number;
      readonly pid: number;
      readonly label?: string;
    }
  | { readonly action: "release"; readonly shieldId: string }
  | { readonly action: "release_all" };

const shieldCoordinate = (value: unknown): number | undefined =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  Math.abs(value) <= CUA_SHIELD_MAX_COORDINATE
    ? value
    : undefined;

const shieldExtent = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 && value <= CUA_SHIELD_MAX_EXTENT
    ? value
    : undefined;

/**
 * Validates `args` on a `{method:"shield"}` host request. Returns the
 * discriminated action or `undefined` for anything malformed — the host
 * turns that into a `not-dispatched` refusal rather than dispatching on
 * half-parsed geometry.
 */
export function parseCuaShieldArgs(value: unknown): CuaShieldArgs | undefined {
  if (!value || typeof value !== "object") return undefined;
  const args = value as Record<string, unknown>;
  if (args.action === "release_all") return { action: "release_all" };
  const shieldId = args.shield_id;
  if (typeof shieldId !== "string" || !CUA_SHIELD_ID_PATTERN.test(shieldId)) return undefined;
  if (args.action === "release") return { action: "release", shieldId };
  if (args.action !== "engage") return undefined;
  const frame = args.frame as Record<string, unknown> | undefined;
  const x = shieldCoordinate(frame?.x);
  const y = shieldCoordinate(frame?.y);
  const width = shieldExtent(frame?.width);
  const height = shieldExtent(frame?.height);
  const windowId = args.window_id;
  const pid = args.pid;
  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined ||
    typeof windowId !== "number" ||
    !Number.isSafeInteger(windowId) ||
    windowId <= 0 ||
    windowId > 0xffffffff ||
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    pid > 0x7fffffff
  )
    return undefined;
  const label =
    typeof args.label === "string"
      ? // The helper paints the label verbatim: strip control/format
        // characters and cap it so a malicious or broken caller cannot smuggle
        // escape sequences or an unbounded string onto the operator's screen.
        args.label
          .replace(/[\p{Cc}\p{Cf}]/gu, "")
          .trim()
          .slice(0, 160) || undefined
      : undefined;
  return {
    action: "engage",
    shieldId,
    frame: { x, y, width, height },
    windowId,
    pid,
    ...(label !== undefined ? { label } : {}),
  };
}

export function parseCuaComputerTask(value: unknown): CuaComputerTask | undefined {
  if (!value || typeof value !== "object") return undefined;
  const task = value as Record<string, unknown>;
  const identifier = (v: unknown): v is string =>
    typeof v === "string" && v.length > 0 && v.length <= 256;
  if (!identifier(task.threadId) || (task.turnId !== undefined && !identifier(task.turnId)))
    return undefined;
  return {
    threadId: task.threadId,
    ...(task.turnId === undefined ? {} : { turnId: task.turnId }),
    ...(typeof task.label === "string" ? { label: task.label.slice(0, 160) } : {}),
  };
}
/**
 * How far a mutating call is known to have gone — the honesty taxonomy every
 * computer action reports instead of guessing:
 *
 * - `not-dispatched`: the call provably never reached the driver — refused,
 *   cancelled, or failed before dispatch. Nothing happened; retrying is safe.
 * - `dispatched-unknown`: the call crossed the dispatch boundary but its
 *   landing is unproven — a lost connection, an unverifiable delivery rung,
 *   a cancelled mid-flight write. It may have taken effect; it must never be
 *   replayed silently.
 * - `verified`: the backend observed the effect it was asked to produce —
 *   the click's target state, the frame it moved, the value it wrote.
 *
 * The audit log records the same three values for completed calls, plus
 * `refused`/`error` outcomes for calls that never produced a delivery verdict.
 */
export type CuaEffect = "not-dispatched" | "dispatched-unknown" | "verified";
export class CuaTransportError extends Error {
  constructor(
    message: string,
    readonly effect: CuaEffect,
  ) {
    super(message);
  }
}

/** One bounded request per connection. A timeout closes the connection; the GUI
 * broker retires the active driver before admitting its next generation. */
export function cuaRequest<T = unknown>(
  socketPath: string,
  request: unknown,
  options: {
    signal?: AbortSignal | undefined;
    timeoutMs?: number;
    mutation?: boolean;
  } = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new CuaTransportError("Cancelled before dispatch.", "not-dispatched"));
      return;
    }
    let encoded: string;
    try {
      encoded = JSON.stringify(request) + "\n";
      if (Buffer.byteLength(encoded) > 1024 * 1024)
        throw new Error("Request exceeds its byte budget.");
    } catch {
      reject(new CuaTransportError("Invalid or oversized computer request.", "not-dispatched"));
      return;
    }
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    let bytes = 0;
    let dispatched = false;
    let settled = false;
    const finish = (error?: Error, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(result as T);
    };
    const fail = (message: string) =>
      finish(
        new CuaTransportError(
          message,
          options.mutation && dispatched ? "dispatched-unknown" : "not-dispatched",
        ),
      );
    const abort = () =>
      fail(
        "Computer operation cancelled. Input already dispatched may have taken effect; do not replay.",
      );
    const timer = setTimeout(
      () => fail("Computer request timed out; do not replay an uncertain action."),
      options.timeoutMs ?? 15_000,
    );
    timer.unref?.();
    options.signal?.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => {
      if (options.signal?.aborted) {
        abort();
        return;
      }
      dispatched = true;
      socket.write(encoded);
    });
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > CUA_MAX_RESPONSE_BYTES) {
        fail("Computer response exceeded its byte budget.");
        return;
      }
      const end = chunk.indexOf(10);
      chunks.push(end < 0 ? chunk : chunk.subarray(0, end));
      if (end < 0) return;
      try {
        finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
      } catch {
        fail("Invalid computer response.");
      }
    });
    socket.once("error", (error) => fail(error.message));
    socket.once("close", () => {
      if (!settled) fail("Computer connection closed before a result.");
    });
  });
}

export interface CuaToolResult {
  content?: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}
/**
 * The `cancel_input` cleanup acknowledgement, as the embedded daemon reports it
 * in `CuaReply.result`. Every field must read exactly as documented in the
 * protocol notes above — a reply that merely echoes success text is not an
 * acknowledgement and must not retire a generation that may hold OS input.
 */
export interface CuaCleanupAcknowledgement {
  /** Echoes the spawned child's PID so a reply cannot vouch for another process. */
  readonly pid: number;
  /** `true` once the in-gate has stopped admitting new input. */
  readonly input_admission_closed: boolean;
  /** `true` once every registered input release and action context has drained. */
  readonly cleanup_complete: boolean;
  /** Outstanding releases/contexts; the acknowledgement is complete only at `0`. */
  readonly pending_input: number;
}
/**
 * Whether a `cancel_input` result is the complete cleanup acknowledgement for
 * the exact child the host spawned: `ok` transport plus `pid === expectedPid`,
 * admission closed, cleanup complete, and zero pending input. Anything less is
 * absent or invalid — the caller must not kill or replace that generation.
 */
export function cuaCleanupAcknowledged(
  result: CuaToolResult | Record<string, unknown> | undefined,
  expectedPid: number | undefined,
): boolean {
  const cleanup = result as Partial<CuaCleanupAcknowledgement> | undefined;
  return (
    expectedPid !== undefined &&
    cleanup?.pid === expectedPid &&
    cleanup?.input_admission_closed === true &&
    cleanup?.cleanup_complete === true &&
    cleanup?.pending_input === 0
  );
}
export interface CuaReply {
  ok: boolean;
  /** GUI-host desktop interruption generation; absent on direct native replies. */
  desktopEpoch?: number;
  /**
   * Sorted list of the host's currently-active desktop pause reasons
   * (`"screen-lock"`, `"system-sleep"`, `"user-session"`), piggybacked on
   * every reply so the backend learns lock/session interruptions even when no
   * event channel exists between them. Absent on direct native replies; an
   * empty or absent list never proves the desktop was never paused — use
   * {@link CuaReply.desktopInterruptions} to detect unobserved cycles.
   */
  desktopPauses?: string[];
  /**
   * Monotonic count of desktop pauses the host has observed since startup —
   * incremented once per `pauseDesktop` transition, never reset. Advancing
   * between two replies proves an interruption cycle (lock/sleep/session
   * switch) ran even when `desktopPauses` netted back to empty between them,
   * which is the signal the server uses to invalidate pre-interruption
   * approvals.
   */
  desktopInterruptions?: number;
  /**
   * The `synara_native_revision` the running driver reported at handshake —
   * a positive number for the patched build, `0` for an unpatched upstream
   * driver. Absent until the first driver spawn answers, and absent on
   * direct native replies. Backends use it to advertise only the
   * capabilities the live driver actually has.
   */
  driverNativeRevision?: number;
  /** Verified Linux browser-only dispatch-epoch and input-drain support.
   * This never certifies native desktop input, focus neutrality, or Escape.
   * False/absent until the running child completes the exact host handshake. */
  driverBrowserInputControl?: boolean;
  /**
   * The platform the host — and therefore the driver it supervises — runs
   * on (`"darwin"`, `"win32"`, `"linux"`). Always present on host replies;
   * backends key dialect and platform-specific semantics off the host's
   * truth rather than the local process, so a remote endpoint on another
   * OS still reports honestly.
   */
  hostPlatform?: string;
  /**
   * The tool's MCP-shaped result — and, for `cancel_input`, the cleanup
   * acknowledgement object (`pid`, `input_admission_closed`,
   * `cleanup_complete`, `pending_input`) documented above.
   */
  result?: CuaToolResult & Record<string, unknown>;
  error?: string;
  /** The delivery verdict a failed or uncertain action reports; see {@link CuaEffect}. */
  effect?: CuaEffect;
}
export const CUA_READ_TOOLS = new Set([
  "check_permissions",
  "check_input_ready",
  "list_windows",
  "list_spaces",
  "list_apps",
  "get_window_state",
  "get_screen_size",
  "get_desktop_state",
  "get_accessibility_tree",
  "get_agent_cursor_state",
  "get_cursor_position",
  "verify_state",
  "wait_for_settle",
  "zoom",
]);
export const CUA_ACTION_TOOLS = new Set([
  "click",
  "move_cursor",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "hotkey",
  "set_value",
  "select_text",
  "clipboard_read",
  "clipboard_write",
  "launch_app",
  "bring_to_front",
  "invoke_menu",
  "set_window_frame",
  "set_window_minimized",
  "set_app_visibility",
  "kill_app",
]);
/**
 * The pinned driver's CDP browser family. Browser tools are deliberately not
 * desktop tools: their targets are session-scoped `target_id`/`tab_id`/ref
 * capabilities, not native window ids, their input travels over CDP rather
 * than OS events, and their deliberate refusals arrive as structured
 * `status:"refused"` results rather than protocol errors. The host admits
 * them by exact name and keeps them out of the desktop-observation gate and
 * pixel geometry. Bind calls that carry a real `pid`/`window_id` do point
 * the frame tap at the bound window — a browser-driven task's preview is
 * otherwise stuck on the whole-desktop stills.
 */
export const CUA_BROWSER_TOOLS = new Set([
  "get_browser_state",
  "browser_prepare",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_dialog",
  "browser_set_input_files",
  "browser_download",
  "browser_pointer",
]);
/**
 * Browser calls whose in-flight loss must be reported as an uncertain effect.
 * `get_browser_state` is the only read in the family; every other name can
 * commit a page-visible or process-visible effect once dispatched
 * (browser_dialog's inspect action is read-only, but the conservative verdict
 * on a lost call is still "dispatched-unknown").
 */
export const CUA_BROWSER_MUTATION_TOOLS = new Set([
  "browser_prepare",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_dialog",
  "browser_set_input_files",
  "browser_download",
  "browser_pointer",
]);

import { setTimeout as waitForComputer } from "node:timers/promises";

import type {
  ComputerInputModifier,
  ComputerPoint,
  ComputerTarget,
  ComputerUiNode,
  ComputerWindow,
} from "@synara/contracts";

import {
  isProtectedComputerRole,
  sha256Hex,
  uiTreeNodeAtPath,
  type ComputerRecordedResolution,
  type ComputerRecordingDocument,
  type ComputerRecordingEnvironment,
  type ComputerRecordingStep,
} from "./computerRecording.ts";

/**
 * Replay for `computer_recording` sessions — the `computer_replay` path.
 *
 * The contract, because replay is where a recording stops being evidence and
 * starts being input again:
 *
 * - Fresh authorization happens above this module: `computer_replay` sits in
 *   the approval-required set, so the gate has already asked before a call
 *   reaches {@link classifyComputerReplay}. Nothing here may weaken that —
 *   the report says what was sent, and a dry run says what would be.
 * - Fresh target resolution happens per step: a recorded point, window id, or
 *   node path is a hint about where the target *was*, never proof it still
 *   is. Every step's target is re-established against a live window list and
 *   a live tree before it is declared ready, and the re-issued call carries
 *   the freshly resolved identity — the manager's own resolution path then
 *   checks it a second time at dispatch, exactly as a live call would.
 * - Mutating steps are never replayed silently: `execute` absent or false is
 *   a pure classification — no dispatch runs, no consent is consumed, and
 *   the report is the whole result. With `execute`, every step's outcome is
 *   enumerated in the report — dispatched, skipped, blocked, or failed, with
 *   the delivery verdict or the refusal code beside it.
 * - A step that cannot be re-issued honestly is blocked, not approximated:
 *   no resolved point, a window that no longer exists and cannot be remapped
 *   to exactly one same-app window, a payload the recording's fidelity did
 *   not capture, or a protected text field — each names its reason in the
 *   report rather than substituting a different target.
 *
 * Environment drift is measured before any step is looked at. A changed
 * platform, backend, dialect, or computer id marks the run `major` —
 * recorded window ids and coordinates may mean nothing — while display,
 * OS-release, tree-shape, and app-inventory differences mark `minor`. Drift
 * never *blocks* by itself (a semantic target can survive a display change);
 * it arms the per-step checks that can.
 *
 * @module computer/computerReplay
 */

export interface ComputerReplayOptions {
  /**
   * Re-dispatch every step that classifies `ready`. Absent or false is the
   * dry run: classification only, nothing is dispatched.
   */
  readonly execute?: boolean;
  /** First recorded seq to consider, inclusive; default is the session's start. */
  readonly fromSeq?: number;
  /** Last recorded seq to consider, inclusive; default is the session's end. */
  readonly toSeq?: number;
  /**
   * Cancellation for the re-issued run — the desktop operation signal the
   * tool layer already carries, so a revoked turn stops the replay between
   * steps exactly as it stops a `computer_run`.
   */
  readonly signal?: AbortSignal;
  /** The turn the replay runs under, for consent bookkeeping on second apps. */
  readonly turnId?: string;
}

export type ComputerReplayDrift = "none" | "minor" | "major";

export interface ComputerReplayEnvironmentField {
  readonly field:
    | "platform"
    | "osRelease"
    | "backend"
    | "dialect"
    | "computerId"
    | "display"
    | "elementTree"
    | "apps";
  readonly verdict: "same" | "changed" | "unobserved";
  readonly recorded?: string;
  readonly current?: string;
}

/** How one step's target held up against the live desktop. */
export interface ComputerReplayTargetReport {
  /** The resolution path the re-issue takes — the recorded via. */
  readonly via?: ComputerRecordedResolution["via"];
  readonly status: "resolved" | "remapped" | "unresolved" | "unneeded";
  /**
   * What the fresh check found — `window-gone`, `node-match`,
   * `node-changed`, `node-gone`, `display-drift`, `app-remap`,
   * `window-remap`, `absolute-point`, or a short detail naming the gap.
   */
  readonly detail?: string | undefined;
  /** The fresh window the step is re-issued against. */
  readonly windowId?: string | undefined;
  /** The fresh desktop point a coordinate step lands on. */
  readonly point?: ComputerPoint | undefined;
  /** The app the step drives — the key admission consents under. */
  readonly app?: string | undefined;
  /** The resolved control is a protected text field — payloads stay blocked. */
  readonly secure?: boolean | undefined;
}

export interface ComputerReplayStepReport {
  readonly seq: number;
  readonly tool: string;
  readonly actionClass: ComputerRecordingStep["actionClass"];
  readonly mutating: boolean;
  readonly verdict: "ready" | "skipped" | "blocked";
  readonly reason?: string;
  readonly target?: ComputerReplayTargetReport;
  /** Present only under `execute`, for the steps that were attempted. */
  readonly dispatch?: {
    readonly ok: boolean;
    readonly effect?: string;
    readonly code?: string;
    readonly error?: string;
  };
}

export interface ComputerReplayReport {
  readonly recordingId: string;
  readonly threadId: string;
  readonly executed: boolean;
  readonly environment: {
    readonly drift: ComputerReplayDrift;
    readonly fields: readonly ComputerReplayEnvironmentField[];
  };
  readonly steps: readonly ComputerReplayStepReport[];
  readonly summary: {
    readonly total: number;
    readonly ready: number;
    readonly dispatched: number;
    readonly skipped: number;
    readonly blocked: number;
    readonly failed: number;
  };
}

/**
 * The surface of {@link ComputerManager} replay needs — declared as an
 * interface rather than importing the class, so the cycle
 * (manager → replay → manager) is type-only and tests can fake it.
 */
export interface ComputerReplayManager {
  listWindows(): Promise<{ readonly windows: readonly ComputerWindow[] }>;
  listApps(): Promise<{
    readonly apps: readonly {
      readonly pid: number;
      readonly name: string;
      readonly running: boolean;
    }[];
  }>;
  getState(options: { readonly includeTree: boolean }): Promise<{
    readonly root?: ComputerUiNode | undefined;
  }>;
  admitDrivenApp(
    threadId: string | undefined,
    app: string,
    options: {
      readonly signal: AbortSignal;
      readonly turnId?: string | undefined;
      readonly toolName?: string | undefined;
    },
  ): Promise<void>;
  click(
    threadId: string | undefined,
    target: ComputerTarget,
    modifiers?: readonly ComputerInputModifier[],
  ): Promise<unknown>;
  doubleClick(
    threadId: string | undefined,
    target: ComputerTarget,
    modifiers?: readonly ComputerInputModifier[],
  ): Promise<unknown>;
  tripleClick(
    threadId: string | undefined,
    target: ComputerTarget,
    modifiers?: readonly ComputerInputModifier[],
  ): Promise<unknown>;
  rightClick(
    threadId: string | undefined,
    target: ComputerTarget,
    modifiers?: readonly ComputerInputModifier[],
  ): Promise<unknown>;
  moveCursor(threadId: string | undefined, target: ComputerTarget): Promise<unknown>;
  drag(
    threadId: string | undefined,
    from: ComputerTarget,
    to: ComputerTarget,
    durationMs?: number,
  ): Promise<unknown>;
  scroll(
    threadId: string | undefined,
    target: ComputerTarget | null,
    deltaX: number,
    deltaY: number,
  ): Promise<unknown>;
  typeText(threadId: string | undefined, text: string, windowId?: string): Promise<unknown>;
  typeTextAt(threadId: string | undefined, text: string, target: ComputerTarget): Promise<unknown>;
  pressKey(threadId: string | undefined, key: string, windowId?: string): Promise<unknown>;
  hotkey(
    threadId: string | undefined,
    keys: readonly string[],
    windowId?: string,
  ): Promise<unknown>;
  setValue(threadId: string | undefined, target: ComputerTarget, value: string): Promise<unknown>;
  performAction(
    threadId: string | undefined,
    target: ComputerTarget,
    action: string,
  ): Promise<unknown>;
  selectText(
    threadId: string | undefined,
    target: ComputerTarget,
    range: { readonly start: number; readonly length: number },
  ): Promise<unknown>;
  paste(threadId: string | undefined, text: string, windowId?: string): Promise<unknown>;
  writeClipboard(threadId: string | undefined, text: string): Promise<unknown>;
  launchApp(
    threadId: string | undefined,
    app: string,
    args: readonly string[],
    waitForWindowMs?: number,
    options?: { readonly hidden?: boolean },
  ): Promise<unknown>;
  activateWindow(threadId: string | undefined, windowId: string): Promise<unknown>;
  setWindowFrame(
    threadId: string | undefined,
    windowId: string,
    frame: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    },
  ): Promise<unknown>;
  invokeMenu(
    threadId: string | undefined,
    windowId: string,
    path: readonly string[],
  ): Promise<unknown>;
  killApp(threadId: string | undefined, windowId: string): Promise<unknown>;
  setWindowMinimized(
    threadId: string | undefined,
    windowId: string,
    minimized: boolean,
  ): Promise<unknown>;
  setAppVisibility(threadId: string | undefined, pid: number, hidden: boolean): Promise<unknown>;
}

// ── Environment drift ──────────────────────────────────────────────

function environmentFields(
  recorded: ComputerRecordingEnvironment | undefined,
  current: ComputerRecordingEnvironment,
): readonly ComputerReplayEnvironmentField[] {
  const fields: ComputerReplayEnvironmentField[] = [];
  const compare = (
    field: ComputerReplayEnvironmentField["field"],
    recordedValue: string | undefined,
    currentValue: string | undefined,
  ): void => {
    if (recordedValue === undefined || currentValue === undefined) {
      fields.push({ field, verdict: "unobserved" });
      return;
    }
    fields.push(
      recordedValue === currentValue
        ? { field, verdict: "same" }
        : { field, verdict: "changed", recorded: recordedValue, current: currentValue },
    );
  };
  compare("platform", recorded?.platform, current.platform);
  compare("osRelease", recorded?.osRelease, current.osRelease);
  compare("backend", recorded?.backend, current.backend);
  compare("dialect", recorded?.dialect, current.dialect);
  compare("computerId", recorded?.computerId, current.computerId);
  compare("display", recorded?.displayHash, current.displayHash);
  compare("elementTree", recorded?.elementTreeHash, current.elementTreeHash);
  const recordedApps = recorded?.apps.map((app) => `${app.name}@${app.version ?? "?"}`).toSorted();
  const currentApps = current.apps.map((app) => `${app.name}@${app.version ?? "?"}`).toSorted();
  compare(
    "apps",
    recordedApps === undefined ? undefined : sha256Hex(recordedApps.join("\n")),
    sha256Hex(currentApps.join("\n")),
  );
  return fields;
}

const MAJOR_DRIFT_FIELDS: ReadonlySet<ComputerReplayEnvironmentField["field"]> = new Set([
  "platform",
  "backend",
  "dialect",
  "computerId",
]);

function overallDrift(fields: readonly ComputerReplayEnvironmentField[]): ComputerReplayDrift {
  let drift: ComputerReplayDrift = "none";
  for (const field of fields) {
    if (field.verdict !== "changed") continue;
    if (MAJOR_DRIFT_FIELDS.has(field.field)) return "major";
    drift = "minor";
  }
  return drift;
}

// ── Recorded-argument reads ────────────────────────────────────────
// The step's args arrive already redacted; these readers tolerate every
// shape a fidelity may have left behind and take nothing on faith.

function argNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function argString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function argBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

function argStringArray(args: Record<string, unknown>, key: string): readonly string[] | undefined {
  const value = args[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as readonly string[])
    : undefined;
}

const REPLAY_MODIFIERS: ReadonlySet<string> = new Set(["ctrl", "alt", "shift", "meta"]);

function argModifiers(args: Record<string, unknown>): readonly ComputerInputModifier[] | undefined {
  const value = args.modifiers;
  if (!Array.isArray(value)) return undefined;
  const modifiers = value.filter(
    (item): item is ComputerInputModifier => typeof item === "string" && REPLAY_MODIFIERS.has(item),
  );
  return modifiers.length > 0 ? modifiers : undefined;
}

/**
 * A payload field is replayable only when a `full`-fidelity record kept the
 * string verbatim — a redacted record leaves `{chars, sha256}`, and a hash
 * cannot be retyped.
 */
function argPayload(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

// ── Step plans ─────────────────────────────────────────────────────

type ReplayTargetKind =
  | "semantic"
  | "pointer"
  | "pointer-optional"
  | "drag"
  | "window"
  | "keyboard"
  | "app"
  | "process"
  | "none";

interface ReplayCall {
  readonly manager: ComputerReplayManager;
  readonly threadId: string;
  readonly step: ComputerRecordingStep;
  readonly args: Record<string, unknown>;
  readonly signal: AbortSignal | undefined;
  /** The fresh target a semantic or pointer step re-issues against. */
  readonly target: ComputerTarget | undefined;
  /** The fresh window a window/keyboard step re-issues against. */
  readonly windowId: string | undefined;
  /** The fresh pid a process step re-issues against. */
  readonly pid: number | undefined;
  /** The drag's second endpoint, resolved the same way as `target`. */
  readonly toTarget: ComputerTarget | undefined;
}

interface ReplayStepPlan {
  readonly mutating: boolean;
  readonly target: ReplayTargetKind;
  /** The arg key a text/clipboard payload re-issues from, when the step has one. */
  readonly payloadKey?: string;
  readonly run: (call: ReplayCall) => Promise<unknown>;
}

function clickPlan(method: "click" | "doubleClick" | "tripleClick" | "rightClick"): ReplayStepPlan {
  return {
    mutating: true,
    target: "pointer",
    run: (call) => call.manager[method](call.threadId, call.target!, argModifiers(call.args)),
  };
}

/**
 * The dispatch table — one plan per replayable tool name. Anything not
 * listed classifies `skipped`: batch containers (their inner steps carry
 * their own records), read-only calls (re-issuing them answers nothing —
 * the recorded result was a summary, never the payload), and the recording
 * family's own calls.
 */
const REPLAY_PLANS: Record<string, ReplayStepPlan> = {
  computer_click: clickPlan("click"),
  computer_double_click: clickPlan("doubleClick"),
  computer_triple_click: clickPlan("tripleClick"),
  computer_right_click: clickPlan("rightClick"),
  computer_move_cursor: {
    mutating: true,
    target: "pointer",
    run: (call) => call.manager.moveCursor(call.threadId, call.target!),
  },
  computer_drag: {
    mutating: true,
    target: "drag",
    run: (call) =>
      call.manager.drag(
        call.threadId,
        call.target!,
        call.toTarget!,
        argNumber(call.args, "duration_ms") ?? 250,
      ),
  },
  computer_scroll: {
    mutating: true,
    target: "pointer-optional",
    run: (call) =>
      call.manager.scroll(
        call.threadId,
        call.target ?? null,
        argNumber(call.args, "delta_x") ?? 0,
        argNumber(call.args, "delta_y") ?? 0,
      ),
  },
  computer_type_text: {
    mutating: true,
    target: "keyboard",
    payloadKey: "text",
    run: (call) =>
      call.target?.label !== undefined || call.target?.role !== undefined
        ? call.manager.typeTextAt(call.threadId, argPayload(call.args, "text")!, call.target)
        : call.manager.typeText(call.threadId, argPayload(call.args, "text")!, call.windowId),
  },
  computer_press_key: {
    mutating: true,
    target: "keyboard",
    run: (call) =>
      call.manager.pressKey(call.threadId, argString(call.args, "key") ?? "", call.windowId),
  },
  computer_hotkey: {
    mutating: true,
    target: "keyboard",
    run: (call) =>
      call.manager.hotkey(call.threadId, argStringArray(call.args, "keys") ?? [], call.windowId),
  },
  computer_set_value: {
    mutating: true,
    target: "semantic",
    payloadKey: "value",
    run: (call) =>
      call.manager.setValue(call.threadId, call.target!, argPayload(call.args, "value")!),
  },
  computer_perform_action: {
    mutating: true,
    target: "semantic",
    run: (call) =>
      call.manager.performAction(call.threadId, call.target!, argString(call.args, "action") ?? ""),
  },
  computer_select_text: {
    mutating: true,
    target: "semantic",
    run: (call) =>
      call.manager.selectText(call.threadId, call.target!, {
        start: argNumber(call.args, "start") ?? 0,
        length: argNumber(call.args, "length") ?? 0,
      }),
  },
  computer_paste: {
    mutating: true,
    target: "keyboard",
    payloadKey: "text",
    run: (call) => call.manager.paste(call.threadId, argPayload(call.args, "text")!, call.windowId),
  },
  computer_write_clipboard: {
    mutating: true,
    target: "none",
    payloadKey: "text",
    run: (call) => call.manager.writeClipboard(call.threadId, argPayload(call.args, "text")!),
  },
  computer_launch_app: {
    mutating: true,
    target: "app",
    run: (call) =>
      call.manager.launchApp(
        call.threadId,
        argString(call.args, "app") ?? call.step.declaredTarget?.app ?? "",
        // Launch arguments are a payload list: verbatim only under `full`
        // fidelity, an empty list otherwise — never a fabricated guess.
        argStringArray(call.args, "arguments") ?? [],
        argBoolean(call.args, "wait_for_window") === false ? 0 : 2_000,
        argBoolean(call.args, "hidden") === true ? { hidden: true } : undefined,
      ),
  },
  computer_activate_window: {
    mutating: true,
    target: "window",
    run: (call) => call.manager.activateWindow(call.threadId, call.windowId!),
  },
  computer_set_window_frame: {
    mutating: true,
    target: "window",
    run: (call) =>
      call.manager.setWindowFrame(call.threadId, call.windowId!, {
        x: argNumber(call.args, "x") ?? 0,
        y: argNumber(call.args, "y") ?? 0,
        width: argNumber(call.args, "width") ?? 0,
        height: argNumber(call.args, "height") ?? 0,
      }),
  },
  computer_invoke_menu: {
    mutating: true,
    target: "window",
    run: (call) =>
      call.manager.invokeMenu(
        call.threadId,
        call.windowId!,
        argStringArray(call.args, "path") ?? [],
      ),
  },
  computer_kill_app: {
    mutating: true,
    target: "window",
    run: (call) => call.manager.killApp(call.threadId, call.windowId!),
  },
  computer_set_window_minimized: {
    mutating: true,
    target: "window",
    run: (call) =>
      call.manager.setWindowMinimized(
        call.threadId,
        call.windowId!,
        argBoolean(call.args, "minimized") ?? true,
      ),
  },
  computer_set_app_visibility: {
    mutating: true,
    target: "process",
    run: (call) =>
      call.manager.setAppVisibility(
        call.threadId,
        call.pid!,
        argBoolean(call.args, "hidden") ?? true,
      ),
  },
  computer_wait: {
    // The only non-mutating step worth re-issuing: a sequence's timing is
    // part of what made it work. The sleep is capped at the tool's own bound.
    mutating: false,
    target: "none",
    run: async (call) => {
      const ms = Math.min(Math.max(argNumber(call.args, "duration_ms") ?? 0, 0), 10_000);
      if (ms > 0) await waitForComputer(ms, undefined, { signal: call.signal });
      return { waitedMs: ms };
    },
  },
};

// ── Fresh target resolution ────────────────────────────────────────

interface FreshDesktop {
  readonly windows: readonly ComputerWindow[];
  readonly apps: readonly {
    readonly pid: number;
    readonly name: string;
    readonly running: boolean;
  }[];
  readonly root: ComputerUiNode | undefined;
  readonly displaySame: boolean;
}

/** The recorded resolution a step leans on most — the window-bearing one, else the first. */
function primaryResolution(step: ComputerRecordingStep): ComputerRecordedResolution | undefined {
  return (
    step.resolutions.find((resolution) => resolution.windowId !== undefined) ?? step.resolutions[0]
  );
}

/** Re-map a recorded desktop point through the window's fresh bounds. */
function remapPoint(
  point: ComputerPoint,
  recordedBounds:
    | { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
    | undefined,
  freshBounds:
    | { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
    | undefined,
): { readonly point: ComputerPoint; readonly detail: string } {
  if (
    recordedBounds !== undefined &&
    freshBounds !== undefined &&
    recordedBounds.width > 0 &&
    recordedBounds.height > 0
  ) {
    const relX = (point.x - recordedBounds.x) / recordedBounds.width;
    const relY = (point.y - recordedBounds.y) / recordedBounds.height;
    return {
      point: {
        x: freshBounds.x + relX * freshBounds.width,
        y: freshBounds.y + relY * freshBounds.height,
      },
      detail: "window-remap",
    };
  }
  return { point, detail: "absolute-point" };
}

/**
 * The one remap replay allows: exactly one live window whose app matches the
 * recorded one. Two or more candidates is an ambiguity, and dispatching onto
 * a guessed window is the failure mode this feature exists to prevent.
 */
function remapWindowByApp(
  app: string | undefined,
  windows: readonly ComputerWindow[],
): ComputerWindow | undefined {
  if (app === undefined) return undefined;
  const lowered = app.toLowerCase();
  const matches = windows.filter((window) => window.appName?.toLowerCase() === lowered);
  return matches.length === 1 ? matches[0] : undefined;
}

/** What a semantic resolution can still prove on a fresh tree. */
function semanticCheck(
  resolution: ComputerRecordedResolution | undefined,
  fresh: FreshDesktop,
): string | undefined {
  if (resolution?.nodePath === undefined || fresh.root === undefined) return undefined;
  const node = uiTreeNodeAtPath(fresh.root, resolution.nodePath);
  if (node === undefined) return "node-gone";
  if (resolution.role !== undefined && node.role !== resolution.role) return "node-changed";
  if (resolution.labelHash !== undefined) {
    const label = node.label;
    if (label === null || sha256Hex(label) !== resolution.labelHash) return "node-changed";
  }
  return "node-match";
}

interface WindowLookup {
  readonly window: ComputerWindow | undefined;
  readonly remapped: boolean;
  readonly app: string | undefined;
}

/**
 * Establish where a step's input would land *now*. A recorded coordinate,
 * window id, or pid is verified against the fresh window list or remapped
 * through the one rule replay allows; a target that proves neither is
 * `unresolved`.
 */
function resolveStepTarget(
  step: ComputerRecordingStep,
  plan: ReplayStepPlan,
  fresh: FreshDesktop,
): ComputerReplayTargetReport {
  const declared = step.declaredTarget;
  const resolution = primaryResolution(step);
  const kind = plan.target;
  const semantic = declared?.label !== undefined || declared?.role !== undefined;
  const declaredWindowId = declared?.windowId ?? resolution?.windowId;

  const windowFor = (windowId: string | undefined): WindowLookup => {
    const app = resolution?.app ?? declared?.app;
    if (windowId !== undefined) {
      const window = fresh.windows.find((candidate) => candidate.id === windowId);
      if (window !== undefined) return { window, remapped: false, app };
      const remapped = remapWindowByApp(app, fresh.windows);
      if (remapped !== undefined) return { window: remapped, remapped: true, app };
      return { window: undefined, remapped: false, app };
    }
    const remapped = remapWindowByApp(app, fresh.windows);
    return { window: remapped, remapped: remapped !== undefined, app };
  };

  if (kind === "none") {
    const app = resolution?.app ?? declared?.app;
    return { status: "unneeded", ...(app !== undefined ? { app } : {}) };
  }

  if (kind === "app") {
    return {
      via: "app",
      status: "resolved",
      detail: "launch-by-name",
      app: declared?.app ?? argString(step.args, "app") ?? resolution?.app,
    };
  }

  if (kind === "process") {
    const pid = declared?.pid ?? resolution?.pid;
    const live = pid !== undefined && fresh.apps.some((app) => app.pid === pid && app.running);
    const app = resolution?.app ?? declared?.app;
    if (live) {
      return { via: "process", status: "resolved", ...(app !== undefined ? { app } : {}) };
    }
    const remapped =
      app === undefined
        ? undefined
        : fresh.apps.find(
            (candidate) => candidate.running && candidate.name.toLowerCase() === app.toLowerCase(),
          );
    return remapped === undefined
      ? {
          via: "process",
          status: "unresolved",
          detail: pid === undefined ? "no-pid" : "process-gone",
          ...(app !== undefined ? { app } : {}),
        }
      : { via: "process", status: "remapped", detail: "app-remap", app: remapped.name };
  }

  if (semantic || kind === "semantic") {
    const { window, remapped, app } = windowFor(declaredWindowId);
    const check = semanticCheck(resolution, fresh);
    if (declaredWindowId !== undefined && window === undefined) {
      return {
        via: "semantic",
        status: "unresolved",
        detail: check ?? "window-gone",
        ...(app !== undefined ? { app } : {}),
      };
    }
    return {
      via: "semantic",
      status: remapped ? "remapped" : "resolved",
      ...(remapped || check !== undefined
        ? { detail: [remapped ? "app-remap" : undefined, check].filter(Boolean).join(" ") }
        : {}),
      ...(window !== undefined ? { windowId: window.id } : {}),
      ...(app !== undefined ? { app } : {}),
      ...(step.resolutions.some(
        (entry) => entry.secure === true || isProtectedComputerRole(entry.role),
      )
        ? { secure: true }
        : {}),
    };
  }

  if (kind === "window" || kind === "keyboard") {
    const { window, remapped, app } = windowFor(declaredWindowId);
    if (window === undefined) {
      return declaredWindowId === undefined && app === undefined
        ? { via: kind, status: "unneeded" }
        : {
            via: kind,
            status: "unresolved",
            detail: "window-gone",
            ...(app !== undefined ? { app } : {}),
          };
    }
    return {
      via: kind,
      status: remapped ? "remapped" : "resolved",
      ...(remapped ? { detail: "app-remap" } : {}),
      windowId: window.id,
      app: window.appName ?? app,
    };
  }

  // kind is "pointer", "pointer-optional", or "drag". A coordinate step's
  // authority is its recorded resolution: the desktop point it landed on and
  // the window it landed in. The declared x/y were screenshot pixels —
  // meaningless without their frame — so they are never re-issued.
  const pointResolution = step.resolutions.find((entry) => entry.point !== undefined);
  const point = pointResolution?.point;
  if (point === undefined) {
    if (kind === "pointer-optional") {
      // A scroll recorded no point but may still have been window-scoped:
      // re-issue that scope only when the window still resolves, so an
      // aimed scroll never silently becomes an unscoped one.
      const scoped = windowFor(declaredWindowId);
      if (declaredWindowId !== undefined && scoped.window === undefined) {
        return {
          via: "coordinate",
          status: "unresolved",
          detail: "window-gone",
          ...(scoped.app !== undefined ? { app: scoped.app } : {}),
        };
      }
      return {
        via: "coordinate",
        status: scoped.window === undefined ? "unneeded" : "resolved",
        ...(scoped.remapped ? { detail: "app-remap" } : {}),
        ...(scoped.window !== undefined ? { windowId: scoped.window.id } : {}),
        ...(scoped.app !== undefined ? { app: scoped.app } : {}),
      };
    }
    return {
      via: "coordinate",
      status: "unresolved",
      detail: "no-resolved-point",
      ...(resolution?.app !== undefined ? { app: resolution.app } : {}),
    };
  }
  const windowId = pointResolution?.windowId ?? declaredWindowId;
  const { window, remapped, app } = windowFor(windowId);
  if (windowId !== undefined && window === undefined) {
    return {
      via: "coordinate",
      status: "unresolved",
      detail: "window-gone",
      ...(app !== undefined ? { app } : {}),
    };
  }
  if (window === undefined) {
    // An unscoped absolute point survives only while the display it was
    // measured against does.
    return fresh.displaySame
      ? {
          via: "coordinate",
          status: "resolved",
          detail: "absolute-point",
          point,
          ...(app !== undefined ? { app } : {}),
        }
      : {
          via: "coordinate",
          status: "unresolved",
          detail: "display-drift",
          point,
          ...(app !== undefined ? { app } : {}),
        };
  }
  const remappedPoint = remapPoint(point, pointResolution?.windowBounds, window.bounds);
  return {
    via: "coordinate",
    status: remapped ? "remapped" : "resolved",
    detail: [remapped ? "app-remap" : undefined, remappedPoint.detail].filter(Boolean).join(" "),
    windowId: window.id,
    point: remappedPoint.point,
    app: window.appName ?? app,
  };
}

/** The `ComputerTarget` a re-issued semantic or pointer step carries. */
function reissueTarget(
  step: ComputerRecordingStep,
  target: ComputerReplayTargetReport | undefined,
): ComputerTarget | undefined {
  const declared = step.declaredTarget;
  if (declared?.label !== undefined || declared?.role !== undefined) {
    return {
      ...(declared.label !== undefined ? { label: declared.label } : {}),
      ...(declared.role !== undefined ? { role: declared.role } : {}),
      ...(target?.windowId !== undefined ? { windowId: target.windowId } : {}),
    };
  }
  if (target?.point !== undefined) {
    return {
      x: target.point.x,
      y: target.point.y,
      ...(target.windowId !== undefined ? { windowId: target.windowId } : {}),
    };
  }
  return target?.windowId === undefined ? undefined : { windowId: target.windowId };
}

/**
 * The drag endpoint `target` does not cover: the second point-bearing
 * resolution, remapped the same way — or a declared semantic endpoint in the
 * step's `to` object.
 */
function dragToTarget(
  step: ComputerRecordingStep,
  fresh: FreshDesktop,
): { readonly target?: ComputerTarget; readonly unresolved?: string } {
  const declared = step.args.to;
  if (declared !== null && typeof declared === "object" && !Array.isArray(declared)) {
    const record = declared as Record<string, unknown>;
    if (typeof record.label === "string" && record.label.length > 0) {
      return {
        target: {
          label: record.label,
          ...(typeof record.role === "string" && record.role.length > 0
            ? { role: record.role }
            : {}),
        },
      };
    }
  }
  const points = step.resolutions.filter((entry) => entry.point !== undefined);
  const second = points.length > 1 ? points[1] : points[0];
  if (second?.point === undefined) return { unresolved: "no-resolved-point" };
  const window =
    second.windowId === undefined
      ? undefined
      : fresh.windows.find((candidate) => candidate.id === second.windowId);
  if (second.windowId !== undefined && window === undefined) return { unresolved: "window-gone" };
  if (window === undefined && !fresh.displaySame) return { unresolved: "display-drift" };
  const remapped = remapPoint(second.point, second.windowBounds, window?.bounds);
  return {
    target: {
      x: remapped.point.x,
      y: remapped.point.y,
      ...(window !== undefined ? { windowId: window.id } : {}),
    },
  };
}

// ── The classifier ─────────────────────────────────────────────────

function classifyStep(
  step: ComputerRecordingStep,
  fresh: FreshDesktop,
): { readonly plan?: ReplayStepPlan; readonly report: ComputerReplayStepReport } {
  const base = { seq: step.seq, tool: step.tool, actionClass: step.actionClass };
  const plan = REPLAY_PLANS[step.tool];
  if (plan === undefined) {
    const reason =
      step.actionClass === "batch"
        ? "container — the run's inner steps carry their own records"
        : step.actionClass === "replay"
          ? "recording-family call"
          : "read-only step";
    return {
      report: { ...base, mutating: false, verdict: "skipped", reason },
    };
  }
  const secure = step.resolutions.some(
    (resolution) => resolution.secure === true || isProtectedComputerRole(resolution.role),
  );
  if (plan.payloadKey !== undefined) {
    if (secure) {
      return {
        plan,
        report: {
          ...base,
          mutating: plan.mutating,
          verdict: "blocked",
          reason:
            "protected-field — the payload was hashed, never stored, and replay will not retype into a secure control",
        },
      };
    }
    if (argPayload(step.args, plan.payloadKey) === undefined) {
      return {
        plan,
        report: {
          ...base,
          mutating: plan.mutating,
          verdict: "blocked",
          reason: "payload-not-captured — the session's fidelity kept a hash, not the text",
        },
      };
    }
  }
  const target = resolveStepTarget(step, plan, fresh);
  if (target.status === "unresolved") {
    return {
      plan,
      report: {
        ...base,
        mutating: plan.mutating,
        verdict: "blocked",
        reason: target.detail ?? "target unresolved",
        target,
      },
    };
  }
  return {
    plan,
    report: { ...base, mutating: plan.mutating, verdict: "ready", target },
  };
}

/** The delivery verdict a re-dispatch reports, when one rode the result. */
function dispatchEffect(value: unknown): string | undefined {
  const delivery = (value as { delivery?: { effect?: unknown } } | null | undefined)?.delivery;
  return typeof delivery?.effect === "string" ? delivery.effect : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Classify — and under `execute`, re-issue — a recording's steps against the
 * live desktop.
 *
 * Fresh state is read once up front (windows, apps, tree) and every step in
 * the seq range is classified against it. Under `execute`, each `ready` step
 * is dispatched through the manager's own methods in order, so the second
 * resolution, the denylist, the window guards, and the delivery verdicts are
 * the same code a live call runs — and app consent is re-admitted per step
 * through `admitDrivenApp` *before* dispatch, because a consent wait may
 * never run inside the manager's serialized operation slot.
 */
export async function classifyComputerReplay(
  manager: ComputerReplayManager,
  document: ComputerRecordingDocument,
  environment: ComputerRecordingEnvironment,
  options: ComputerReplayOptions & { readonly threadId: string },
): Promise<ComputerReplayReport> {
  const fields = environmentFields(document.header.environment, environment);
  const drift = overallDrift(fields);
  const [windows, apps, root] = await Promise.all([
    manager
      .listWindows()
      .then((result) => result.windows)
      .catch(() => [] as const),
    manager
      .listApps()
      .then((result) => result.apps)
      .catch(() => [] as const),
    manager
      .getState({ includeTree: true })
      .then((result) => result.root)
      .catch(() => undefined),
  ]);
  const fresh: FreshDesktop = {
    windows,
    apps,
    root,
    displaySame: fields.find((field) => field.field === "display")?.verdict === "same",
  };

  const from = options.fromSeq ?? 1;
  const to = options.toSeq ?? Number.MAX_SAFE_INTEGER;
  const steps = document.steps.filter((step) => step.seq >= from && step.seq <= to);
  const execute = options.execute === true;

  const reports: ComputerReplayStepReport[] = [];
  const summary = {
    total: steps.length,
    ready: 0,
    dispatched: 0,
    skipped: 0,
    blocked: 0,
    failed: 0,
  };

  for (const step of steps) {
    const { plan, report } = classifyStep(step, fresh);
    if (report.verdict !== "ready" || plan === undefined) {
      if (report.verdict === "skipped") summary.skipped += 1;
      else summary.blocked += 1;
      reports.push(report);
      continue;
    }
    if (!execute) {
      summary.ready += 1;
      reports.push(report);
      continue;
    }
    summary.ready += 1;
    options.signal?.throwIfAborted();

    // Fresh consent for the app this step is about to drive — before the
    // dispatch, because a consent wait may never run inside the manager's
    // serialized operation slot.
    const app = report.target?.app;
    if (plan.mutating && app !== undefined) {
      try {
        await manager.admitDrivenApp(options.threadId, app, {
          // `new AbortSignal()` is illegal — an AbortController's signal is
          // the never-aborting stand-in when the caller carried none.
          signal: options.signal ?? new AbortController().signal,
          ...(options.turnId !== undefined ? { turnId: options.turnId } : {}),
          toolName: "computer_replay",
        });
      } catch (error) {
        summary.failed += 1;
        reports.push({
          ...report,
          dispatch: {
            ok: false,
            code: errorCode(error) ?? "consent_refused",
            error: errorMessage(error),
          },
        });
        continue;
      }
    }

    let toTarget: ComputerTarget | undefined;
    if (plan.target === "drag") {
      const to = dragToTarget(step, fresh);
      if (to.target === undefined) {
        summary.blocked += 1;
        summary.ready -= 1;
        reports.push({
          ...report,
          verdict: "blocked",
          reason: to.unresolved ?? "drag destination unresolved",
        });
        continue;
      }
      toTarget = to.target;
    }

    const call: ReplayCall = {
      manager,
      threadId: options.threadId,
      step,
      args: step.args,
      signal: options.signal,
      target: reissueTarget(step, report.target),
      windowId: report.target?.windowId,
      pid:
        report.target?.via === "process" &&
        report.target.status === "remapped" &&
        report.target.app !== undefined
          ? fresh.apps.find(
              (candidate) => candidate.running && candidate.name === report.target!.app,
            )?.pid
          : (step.declaredTarget?.pid ?? primaryResolution(step)?.pid),
      toTarget,
    };
    try {
      const value = await plan.run(call);
      summary.dispatched += 1;
      const effect = dispatchEffect(value);
      reports.push({
        ...report,
        dispatch: { ok: true, ...(effect !== undefined ? { effect } : {}) },
      });
    } catch (error) {
      summary.failed += 1;
      const code = errorCode(error);
      reports.push({
        ...report,
        dispatch: {
          ok: false,
          ...(code !== undefined ? { code } : {}),
          error: errorMessage(error),
        },
      });
    }
  }

  return {
    recordingId: document.header.recordingId,
    threadId: options.threadId,
    executed: execute,
    environment: { drift, fields },
    steps: reports,
    summary,
  };
}

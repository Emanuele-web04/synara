import { cursorToolActivity } from "../computer/cursorActivity.ts";
import { waitForControl } from "../computer/waitForControl.ts";
import {
  assertDesktopOperationActive,
  desktopOperationSignal,
  withDesktopOperationSignal,
} from "../computer/DesktopOperationQueue.ts";
import { setTimeout as waitForComputer } from "node:timers/promises";
/** Agent-facing desktop perception and control tools. */
import { Effect } from "effect";

import {
  COMPUTER_DRAG_MAX_DURATION_MS,
  COMPUTER_HOTKEY_MAX_KEYS,
  COMPUTER_KEY_NAME_MAX_LENGTH,
  COMPUTER_MODIFIERS_MAX_ITEMS,
  COMPUTER_SELECT_TEXT_RANGE_MAX,
  COMPUTER_SEMANTIC_ACTION_MAX_LENGTH,
  COMPUTER_TEXT_MAX_LENGTH,
  COMPUTER_WAIT_MAX_MS,
  type ComputerActionResult,
  type ComputerApp,
  type ComputerAvailability,
  type ComputerBuildSignature,
  type ComputerGrantAppIdentity,
  type ComputerInputModifier,
  type ComputerPermission,
  type ComputerRect,
  type ComputerScreenshot,
  type ComputerTarget,
  type ComputerWindow,
} from "@synara/contracts";

import {
  actionableElements,
  diffActionableElements,
  normalizeLabelSpaces,
  resolveComputerSemanticTarget,
  ComputerTargetError,
  type ComputerActionableElementRef,
  type ComputerActionableElements,
} from "../computer/uiTreeTargeting.ts";
import {
  COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
  DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION,
  MAX_COMPUTER_CLIPBOARD_BYTES,
  ComputerBackendError,
  type ComputerAgentDialect,
  type ComputerCaptureRequest,
  type ComputerTextRange,
} from "../computer/ComputerBackend.ts";
import {
  computerSetupSignal,
  computerSetupToolNote,
  type ComputerSetupSignal,
} from "../computer/computerSetupSignal.ts";
import {
  ComputerLeaseError,
  ComputerManager,
  type ComputerActionObservation,
} from "../computer/ComputerManager.ts";
import {
  summarizeComputerAuditArgs,
  type ComputerAuditEffect,
  type ComputerAuditEntry,
} from "../computer/computerAuditLog.ts";
import {
  withComputerRecordingCapture,
  type ComputerRecordingCapture,
} from "../computer/computerCallContext.ts";
import { rectContainsPoint, topmostWindowAtPoint } from "../computer/computerGeometry.ts";
import {
  computerGrantClassesForTool,
  computerGrantIdentityForAppArg,
  computerGrantIdentityForPid,
  computerGrantIdentityForWindow,
  computerGrantIdentityKey,
  type ComputerGrantCallContext,
} from "../computer/computerGrants.ts";
import {
  computerRecordingHistoryLines,
  redactComputerRecordingArgs,
  redactComputerRecordingResult,
  ComputerRecordingError,
  type ComputerRecordingActionClass,
  type ComputerRecordingApproval,
  type ComputerRecordingDeclaredTarget,
  type ComputerRecordingFidelity,
  type ComputerRecordingStepInput,
} from "../computer/computerRecording.ts";
import {
  ScreenshotFrameRegistry,
  screenshotDeltaToDesktop,
  screenshotPointToDesktop,
  screenshotRectToDesktop,
} from "../computer/screenshotFrames.ts";
import { withDesktopDeliveryMode } from "../computer/DesktopOperationQueue.ts";
import { CuaActionError } from "../computer/CuaComputerBackend.ts";
import { cuaCaptureReuseEnabled } from "../computer/computerCallContext.ts";
import { withModelDesktopObservation } from "../computer/modelDesktopObservation.ts";
import { withComputerTask } from "../computer/computerTaskContext.ts";
import { PROVIDERS_WITHOUT_APPROVAL_GATE } from "./approvalGate.ts";
export { computerToolInstructions } from "./computerGuidance.ts";
import { mcpToolResultError, type McpToolCallResult } from "./protocol.ts";
import {
  ToolInputError,
  errorText,
  readBooleanArg,
  readNumberArg,
  readRecordArg,
  readStringArg,
  readStringArrayArg,
  readVerbatimStringArg,
} from "./toolInput.ts";
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  type ToolContext,
  type ToolEntry,
} from "./toolRuntime.ts";
import { ToolGuidanceCadence } from "./toolGuidanceCadence.ts";

/** Compact only Computer result JSON; preserve every value and other tool families. */
function mcpToolResultJson(value: unknown): McpToolCallResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export const COMPUTER_CONTROL_CAPABILITY = "computer:control" as const;

/**
 * First-mutation disclosure prepended to the first mutating computer result
 * in a turn. It names the switch the user owns, so a transcript that drove
 * the desktop always says so up front.
 */
export const COMPUTER_CONTROL_FIRST_MUTATION_DISCLOSURE =
  "Computer control ON for this turn: the agent is driving the desktop and the user can switch it off in Settings.";

const COMPUTER_TOOL_REFRESH_GUIDANCE =
  "Computer routing reminder: observe with computer_get_state and exact window_id before acting; prefer semantic labels and roles over screenshot coordinates. Exact background text is focus-neutral only when Cua proves one writable Accessibility target. Use foreground delivery only when activation is necessary, never replay uncertain delivery, and treat off-Space pixels as non-live.";

/**
 * Re-exported so a caller reaching for the computer family's gate finds it, and
 * so nothing is tempted to declare a second copy. The set itself lives in
 * `approvalGate.ts`, shared with the device family — it used to be declared
 * once per family, and a provider added to one list and not the other was a
 * silent bypass.
 */
export { PROVIDERS_WITHOUT_APPROVAL_GATE };

export const COMPUTER_APPROVAL_REQUIRED_TOOLS = new Set([
  // The one read in this set on purpose: the clipboard is the human's, and it
  // can hold something they copied privately — a password manager entry, a
  // token — that is not otherwise visible to the agent. Reading it must never
  // be auto-approved the way perception tools are.
  "computer_read_clipboard",
  "computer_launch_app",
  "computer_click",
  "computer_double_click",
  "computer_triple_click",
  "computer_right_click",
  // Overlay changes still require computer authority.
  "computer_move_cursor",
  "computer_drag",
  "computer_scroll",
  "computer_type_text",
  "computer_press_key",
  "computer_hotkey",
  "computer_write_clipboard",
  "computer_set_value",
  "computer_perform_action",
  // An exact selection writes the target's state too — same mutating class
  // as set_value, approved the same way.
  "computer_select_text",
  "computer_paste",
  // A run is the same actions it contains, approved once for the list the
  // model declared rather than once per dispatch.
  "computer_run",
  // The only tool whose whole effect is on what the human sees on their own
  // screen, which is exactly why it is gated.
  "computer_activate_window",
  // Window motion and menu invocation mutate the app the user is looking at;
  // kill_app force-terminates it and loses unsaved state. The visibility
  // lifecycle pair mutates what is on screen without activating anything —
  // a hidden app that vanishes mid-gesture is still the user's desktop.
  "computer_set_window_frame",
  "computer_invoke_menu",
  "computer_kill_app",
  "computer_set_window_minimized",
  "computer_set_app_visibility",
  // Starting a session decides what evidence gets kept — `full` fidelity
  // captures text payloads verbatim — so it is consented like the actions it
  // records. Deleting a recording destroys evidence; replaying one re-issues
  // real input. Neither is ever silent.
  "computer_recording_start",
  "computer_recording_delete",
  "computer_replay",
]);

export function computerToolRequiresApproval(name: string): boolean {
  return COMPUTER_APPROVAL_REQUIRED_TOOLS.has(name);
}

/**
 * The calls the local audit log records: every approval-gated computer tool —
 * the mutating set plus `computer_read_clipboard`, the one read that can lift
 * a private payload the agent could not otherwise see. Perception reads stay
 * out: they are the ordinary traffic, and the log exists for abuse review,
 * not telemetry.
 */
const COMPUTER_AUDITED_TOOLS = COMPUTER_APPROVAL_REQUIRED_TOOLS;

/**
 * The audit entry's target: the ids the call declared first, then the window
 * the result resolved when one rode it. `drivenApps` carries the apps the
 * call was admitted to drive, so a window-grain tool still names the app its
 * consent covered.
 */
function computerAuditTarget(
  args: Record<string, unknown>,
  drivenApps: ReadonlySet<string>,
  resultWindowId: string | undefined,
): ComputerAuditEntry["target"] | undefined {
  const windowId = readWindowIdArg(args) ?? resultWindowId;
  const pid =
    typeof args.pid === "number" && Number.isSafeInteger(args.pid) && args.pid > 0
      ? args.pid
      : undefined;
  const app =
    typeof args.app === "string" && args.app.trim().length > 0 ? args.app : [...drivenApps][0];
  if (windowId === undefined && pid === undefined && app === undefined) return undefined;
  return {
    ...(windowId !== undefined ? { windowId } : {}),
    ...(pid !== undefined ? { pid } : {}),
    ...(app !== undefined ? { app } : {}),
  };
}

/** The window id a successful call resolved, when the result reports one. */
function computerAuditResultWindowId(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.windowId === "string") return record.windowId;
  const window = record.window;
  return window !== null &&
    typeof window === "object" &&
    typeof (window as Record<string, unknown>).id === "string"
    ? ((window as Record<string, unknown>).id as string)
    : undefined;
}

/**
 * The effect a completed call earned: the delivered verdict when one rode the
 * result (`verified`, `dispatched-unknown`, `not-dispatched`), and the honest
 * "the backend accepted it" answer otherwise — which is what
 * `dispatched-unknown` exists to say.
 */
function computerAuditSuccessEffect(name: string, value: unknown): ComputerAuditEffect {
  const delivery = (value as { delivery?: { effect?: unknown } } | null | undefined)?.delivery;
  if (
    delivery?.effect === "verified" ||
    delivery?.effect === "dispatched-unknown" ||
    delivery?.effect === "not-dispatched"
  )
    return delivery.effect;
  if (name === "computer_run") {
    const completed = (value as { completed?: unknown } | null | undefined)?.completed;
    return typeof completed === "number" && completed > 0 ? "dispatched-unknown" : "not-dispatched";
  }
  return "dispatched-unknown";
}

/**
 * The action family a step record carries — descriptive for the reader and
 * the replay classifier; dispatch decisions are made on the tool name, not
 * this field.
 */
function computerRecordingActionClass(name: string): ComputerRecordingActionClass {
  switch (name) {
    case "computer_click":
    case "computer_double_click":
    case "computer_triple_click":
    case "computer_right_click":
    case "computer_move_cursor":
    case "computer_drag":
    case "computer_scroll":
      return "pointer";
    case "computer_press_key":
    case "computer_hotkey":
      return "keyboard";
    case "computer_type_text":
      return "text";
    case "computer_set_value":
    case "computer_perform_action":
    case "computer_select_text":
      return "semantic";
    case "computer_read_clipboard":
    case "computer_write_clipboard":
    case "computer_paste":
      return "clipboard";
    case "computer_activate_window":
    case "computer_set_window_frame":
    case "computer_invoke_menu":
    case "computer_set_window_minimized":
      return "window";
    case "computer_launch_app":
    case "computer_kill_app":
    case "computer_set_app_visibility":
      return "lifecycle";
    case "computer_run":
      return "batch";
    case "computer_recording_start":
    case "computer_recording_stop":
    case "computer_recording_list":
    case "computer_recording_read":
    case "computer_recording_export":
    case "computer_recording_delete":
    case "computer_replay":
      return "replay";
    default:
      // Perception calls — the read side of a session's history.
      return "observation";
  }
}

/**
 * The target the call declared, verbatim — the replay key. Only fields the
 * model could actually have written are read; a `computer_run`'s per-step
 * declarations ride on the inner step records, not this one.
 */
function computerRecordingDeclaredTarget(
  args: Record<string, unknown>,
): ComputerRecordingDeclaredTarget | undefined {
  const target: {
    -readonly [K in keyof ComputerRecordingDeclaredTarget]?: ComputerRecordingDeclaredTarget[K];
  } = {};
  if (typeof args.x === "number" && Number.isFinite(args.x)) target.x = args.x;
  if (typeof args.y === "number" && Number.isFinite(args.y)) target.y = args.y;
  if (typeof args.label === "string" && args.label.length > 0) target.label = args.label;
  if (typeof args.role === "string" && args.role.length > 0) target.role = args.role;
  const windowId = readWindowIdArg(args);
  if (windowId !== undefined) target.windowId = windowId;
  if (typeof args.pid === "number" && Number.isSafeInteger(args.pid) && args.pid > 0) {
    target.pid = args.pid;
  }
  if (typeof args.app === "string" && args.app.trim().length > 0) target.app = args.app;
  return Object.keys(target).length === 0 ? undefined : (target as ComputerRecordingDeclaredTarget);
}

/** The effect/code pair a failed call reports — a typed refusal or a fault. */
export function computerAuditErrorOutcome(error: unknown): {
  readonly effect: ComputerAuditEffect;
  readonly code: string;
} {
  // A CuaActionError already carries the delivery taxonomy's verdict.
  if (error instanceof CuaActionError)
    return { effect: error.effect, code: error.code ?? "cua_action_error" };
  if (error instanceof ComputerTargetError) return { effect: "refused", code: error.code };
  if (error instanceof ComputerLeaseError) return { effect: "refused", code: error.code };
  if (error instanceof ComputerRecordingError) {
    return { effect: "refused", code: "computer_recording_error" };
  }
  if (error instanceof ComputerBackendError) {
    return error.inputPause !== undefined
      ? { effect: "refused", code: "computer_input_paused" }
      : { effect: "error", code: "computer_backend_error" };
  }
  if (error instanceof ToolInputError) return { effect: "refused", code: "invalid_arguments" };
  return { effect: "error", code: "error" };
}

/** Computer tools are capability-gated. Provider-side schema loading varies;
 * inactive sessions receive no computer definitions. */
export interface AgentGatewayComputerToolsOptions {
  readonly manager: ComputerManager;
  /**
   * `grantContext` is what a durable always-allow grant would have to cover
   * for this call — the resolved app identities and the action classes it
   * exercises. The gate checks live grants against it to waive the prompt,
   * and offers exactly this scope for the user to pin. Absent means the call
   * was never attributed, so no grant can cover it and none is offered.
   */
  readonly authorizeAction?: (
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
    signal: AbortSignal,
    grantContext?: ComputerGrantCallContext,
  ) => Promise<boolean>;
  /**
   * Called when a tool call failed because the OS is withholding a privacy
   * grant Synara needs. The gateway turns it into one actionable chat card;
   * the tool result is returned unchanged either way, so this must not fail.
   */
  readonly onSetupRequired?: (input: {
    readonly toolName: string;
    /** The grants to name on the card; empty when the backend named none. */
    readonly missing: readonly ComputerPermission[];
    /**
     * How the backend's build is signed, when it knows. The card says nothing
     * about stale grants without it, and must not on a signed build.
     */
    readonly buildSignature?: ComputerBuildSignature;
    /** The app macOS holds responsible for the grants, when the desktop shell reported one. */
    readonly bundleId?: string;
    readonly context: ToolContext;
  }) => Effect.Effect<void>;
}

/**
 * What an observed action hands back: the result alone, for the actions the
 * gateway photographs afterwards, or a result that already carries its own
 * observation. `result` is the discriminator — a `ComputerActionResult` has no
 * such field.
 */
type ObservedActionOutcome =
  | ComputerActionResult
  | {
      readonly result: ComputerActionResult;
      readonly observation?: ComputerActionObservation;
    };

/**
 * One wording for how the model points at things, shared by every tool that
 * returns an image: it points into the picture it was given, in that picture's
 * own pixels, and the server does the geometry (see screenshotFrames.ts). The
 * model is never asked to turn a screenshot pixel into a desktop coordinate —
 * the harnesses behind the Codex app and Anthropic's computer tool do not ask
 * either, and the arithmetic that did (region + pixel / scale across offset,
 * downscaled captures) was where clicks went astray.
 */
const SCREENSHOT_FRAME_NOTE =
  "Every screenshot comes back with a screenshotId and its width and height in pixels; to point at something in it, pass x/y as pixel coordinates in that image, measured from its top-left corner, and the server maps them onto the desktop.";

/**
 * Both clipboard tools must say the same thing about ownership: the desktop has
 * one clipboard and the human is the other party using it.
 */
const SHARED_CLIPBOARD_NOTE =
  "The desktop has a single clipboard shared with the human user, not a private one for the agent.";

/** The short form each pointer tool carries in place of the paragraph above. */
const POINTER_COORDINATE_HINT =
  'x/y are screenshot pixels, never desktop coordinates. See "Pointing at the desktop" in the active Synara host context.';

/**
 * The parity lever for visual grounding: when the model knows a control's
 * label from get_state, label-targeting resolves to that exact control, while
 * a pixel estimate from a downscaled screenshot can land a few points off.
 */
const SEMANTIC_TARGETING_NOTE = "Prefer label and role from computer_get_state over estimated x/y.";

/** The short form the action tools carry. */
const ACTION_SCREENSHOT_HINT =
  'Returns a screenshot by default. See "The screenshot on every action" in the active Synara host context.';

const INCLUDE_ACTION_SCREENSHOT_PROPERTY = {
  include_screenshot: {
    type: "boolean",
    description:
      "Post-action screenshot, default true. For a short sequence, use false then verify with fresh state or a final screenshot.",
  },
} as const;

const WINDOW_FOCUS_NOTE =
  "focused means selected input target; active reports native activation when known.";

/** The short form the keyboard tools carry. */
const KEYBOARD_TARGET_HINT =
  'Pass window_id or use the last aimed window; hover does not aim keys. Exact-window text uses the sole writable control without activation; pass its label and optional role when several exist. See "Aiming the keyboard".';

/** The short form the input tools carry. */
const DELIVERY_HINT =
  'delivery.verified and delivery.effect report evidence, not retry permission. See "Reading a delivery verdict".';

/** Longest step list one computer_run accepts. */
const COMPUTER_RUN_MAX_STEPS = 25;

/**
 * Per-app notes that change how the standard tools behave, attached once to
 * the first state read scoped to that app's window. Verified behavior only —
 * a hint that guesses teaches the model a wrong move it then has to unlearn.
 * Keyed by the lowercase appName computer_list_windows reports.
 */
const APP_GUIDANCE: Record<string, string> = {
  slack:
    "Slack: prefer set_value on the message composer — type_text submits the message on Return, while set_value inserts text and newlines without sending. When the composer holds 3+ characters, a hint button below it names the key combination that adds a new line; the combination not listed sends.",
};

function keyboardTargetProperty(): Record<string, unknown> {
  return {
    window_id: {
      type: "string",
      description:
        "Exact target window from computer_list_windows; does not activate it. Screenshot is scoped to it.",
    },
  };
}

function textTargetProperty(): Record<string, unknown> {
  return {
    ...keyboardTargetProperty(),
    label: {
      type: "string",
      description:
        "Exact writable control label from computer_get_state. With window_id, computer_type_text uses semantic insertion without activating the app.",
    },
    role: {
      type: "string",
      description: "Optional accessible role used to disambiguate the text control label.",
    },
    ref: {
      type: "integer",
      minimum: 0,
      description:
        "Element ref from a computer_get_state elements listing — names the text control without quoting its label.",
    },
    ref_ordinal: {
      type: "integer",
      minimum: 0,
      description:
        "With label: which same-labelled text control to target — 0 for the first, 1 for the second. Only needed to name a duplicate without a ref.",
    },
  };
}

/**
 * Modifiers held down for the whole gesture and released after it.
 *
 * Not expressible with computer_hotkey, which presses and releases: by the time
 * the click arrived nothing was held and the application saw a plain click. So
 * shift-click, cmd-click and ctrl-scroll had no reachable spelling at all.
 */
const MODIFIERS_PROPERTY = {
  modifiers: {
    type: "array",
    items: { type: "string", enum: ["ctrl", "alt", "shift", "meta"] },
    maxItems: COMPUTER_MODIFIERS_MAX_ITEMS,
    description:
      'Keys held during the gesture and released afterward; "meta" is Command on macOS. Unlike computer_hotkey, modifiers stay held through the click or drag.',
  },
} as const;

function withActionScreenshotSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return {
    ...schema,
    properties: {
      ...(schema.properties as Record<string, unknown>),
      ...INCLUDE_ACTION_SCREENSHOT_PROPERTY,
      wait_for_label: {
        type: "string",
        description: "Wait up to 2 seconds for this label in the affected window before capturing.",
      },
    },
  };
}

const SCREENSHOT_ID_PROPERTY = {
  screenshot_id: {
    type: "string",
    description:
      "Frame for x/y; defaults to the latest delivered screenshot. An earlier screenshot must still be valid.",
  },
} as const;

const TARGET_PROPERTIES = {
  x: {
    type: "number",
    description: "Pixel x from the screenshot's left edge.",
  },
  y: {
    type: "number",
    description: "Pixel y from the screenshot's top edge.",
  },
  ...SCREENSHOT_ID_PROPERTY,
  label: {
    type: "string",
    description:
      "Exact accessible label from computer_get_state; matched verbatim, including leading and trailing spaces, against fresh state.",
  },
  role: {
    type: "string",
    description: "Optional accessible role used to disambiguate a label.",
  },
  ref: {
    type: "integer",
    minimum: 0,
    description:
      "Element ref from a computer_get_state elements listing — the compact form, cheaper than re-quoting label and role and able to name a duplicate a bare label cannot. A ref stays bound to the same element across observations while it is present; it never moves to a different element.",
  },
  ref_ordinal: {
    type: "integer",
    minimum: 0,
    description:
      "With label: which same-labelled control to target — 0 for the first, 1 for the second. Only needed to name a duplicate without a ref.",
  },
} as const;

/** Pointer targeting reveals the same window the input will reach. */
function targetProperties(): Record<string, unknown> {
  return {
    ...TARGET_PROPERTIES,
    window_id: {
      type: "string",
      description:
        "Exact window for label or x/y targeting; outside coordinates are refused. Background input may be refused. For computer_scroll, window_id alone targets that window.",
    },
  };
}

/**
 * The refusal payload a session without an approval gate reports — shared
 * with the browser surface so both families name the same code and say the
 * same words. Each side serializes it its own way: the desktop family
 * pretty-prints through `mcpToolResultJson`, the browser family compact.
 */
export function computerApprovalRequiredError(name: string): {
  readonly code: "ComputerApprovalRequired";
  readonly message: string;
} {
  return {
    code: "ComputerApprovalRequired",
    message: `${name} requires explicit user approval, and this provider session has no approval gate. The action was refused before it ran.`,
  };
}

/**
 * The failure payload a typed driver refusal reports — `error` is the
 * refusal code, not a message, because the model branches on it. Shared
 * with the browser surface, which serializes it compact rather than
 * through `mcpToolResultJson`.
 */
export function cuaActionErrorPayload(error: CuaActionError): {
  readonly error: string;
  readonly effect: string;
  readonly message: string;
  readonly retryAllowed: false;
} {
  return {
    error: error.code,
    effect: error.effect,
    message: error.message,
    retryAllowed: false,
  };
}

function approvalUnavailableResult(name: string): McpToolCallResult {
  return {
    ...mcpToolResultJson({ error: computerApprovalRequiredError(name) }),
    isError: true,
  };
}

/**
 * The refusal carries a code and `retryable` rather than only prose so a model
 * can tell "wait and try again" apart from the target and approval failures it
 * must fix before retrying.
 */
function leaseErrorResult(error: ComputerLeaseError): McpToolCallResult {
  return {
    ...mcpToolResultJson({
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      },
    }),
    isError: true,
  };
}

function targetErrorResult(error: ComputerTargetError): McpToolCallResult {
  return {
    ...mcpToolResultJson({
      error: {
        code: error.code,
        message: error.message,
        notFound: error.notFound,
        candidates: error.candidates,
      },
    }),
    isError: true,
  };
}

/**
 * Whether a target was actually given, decided by what survived reading rather
 * than by which keys the model happened to emit. Models routinely spell an
 * omitted optional field as an explicit `null`, and a key-presence test reads
 * `{"x": null}` as "has a target" and then hands the manager an empty target,
 * which is refused as `computer_target_invalid` — a hard failure for a request
 * that plainly meant "no target".
 */
function hasTargetFields(target: ComputerTarget): boolean {
  return Object.keys(target).length > 0;
}

/** Accepts both spellings, because models emit the camelCase one either way. */
function readWindowIdArg(args: Record<string, unknown>): string | undefined {
  return readStringArg(args, "window_id") ?? readStringArg(args, "windowId");
}

function readScreenshotIdArg(args: Record<string, unknown>): string | undefined {
  return readStringArg(args, "screenshot_id") ?? readStringArg(args, "screenshotId");
}

/**
 * A target as the model wrote it: x/y still in screenshot pixels, plus the
 * screenshot they belong to. It becomes a `ComputerTarget` only once the
 * frame registry has turned the pixels into a desktop point.
 */
interface ScreenshotTarget extends ComputerTarget {
  readonly screenshotId?: string;
}

function readScreenshotTarget(args: Record<string, unknown>): ScreenshotTarget {
  const x = readNumberArg(args, "x");
  const y = readNumberArg(args, "y");
  const screenshotId = readScreenshotIdArg(args);
  // Verbatim, never trimmed: the targeters match a label exactly as given (see
  // uiTreeTargeting's `computerTargetSpec`), so trimming here silently
  // retargeted a caller that named "Save " at a different control called "Save".
  const label = readVerbatimStringArg(args, "label");
  const role = readStringArg(args, "role");
  const windowId = readWindowIdArg(args);
  const ref = readNumberArg(args, "ref");
  if (ref !== undefined && (!Number.isSafeInteger(ref) || ref < 0)) {
    throw new ToolInputError('Argument "ref" must be a non-negative integer.');
  }
  const refOrdinal = readNumberArg(args, "ref_ordinal") ?? readNumberArg(args, "refOrdinal");
  if (refOrdinal !== undefined && (!Number.isSafeInteger(refOrdinal) || refOrdinal < 0)) {
    throw new ToolInputError('Argument "ref_ordinal" must be a non-negative integer.');
  }
  return {
    ...(x !== undefined ? { x } : {}),
    ...(y !== undefined ? { y } : {}),
    ...(screenshotId !== undefined ? { screenshotId } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(windowId !== undefined ? { windowId } : {}),
    ...(ref !== undefined ? { ref } : {}),
    ...(refOrdinal !== undefined ? { refOrdinal } : {}),
  };
}

function readNestedScreenshotTarget(args: Record<string, unknown>, name: string): ScreenshotTarget {
  const value = readRecordArg(args, name);
  if (!value) throw new ToolInputError(`Missing required argument "${name}".`);
  return readScreenshotTarget(value);
}

function readDelta(args: Record<string, unknown>, name: string): number {
  const value = readNumberArg(args, name);
  if (value === undefined) throw new ToolInputError(`Missing required argument "${name}".`);
  return value;
}

const DEFAULT_DRAG_DURATION_MS = 250;
/**
 * Clamped rather than refused: the caller's intent is clear, only the scale is
 * wrong.
 *
 * The contract's bound is enforced here as well as declared in the JSON Schema
 * because nothing validates MCP tool arguments against that schema before
 * dispatch: an unclamped `duration_ms` of 1e9 is a drag that holds the button —
 * and the exclusive desktop lease — for eleven days.
 */
function readDragDurationMs(args: Record<string, unknown>): number {
  const value = readNumberArg(args, "duration_ms");
  if (value === undefined) return DEFAULT_DRAG_DURATION_MS;
  return Math.min(COMPUTER_DRAG_MAX_DURATION_MS, Math.max(0, value));
}

function readRawRequiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string") throw new ToolInputError(`Argument "${name}" must be a string.`);
  return value;
}

function readRequiredText(args: Record<string, unknown>): string {
  const value = readRawRequiredString(args, "text");
  if (value.length > COMPUTER_TEXT_MAX_LENGTH)
    throw new ToolInputError('Argument "text" is too long.');
  return value;
}

/**
 * The `computer_set_value` payload. Bounded like `readRequiredText` because
 * MCP arguments are never validated against the tool's JSON Schema: an
 * unbounded value that falls back to typed keystrokes would hold the exclusive
 * desktop lease — and the turn — for hours typing it out.
 */
function readSetValueValue(args: Record<string, unknown>): string {
  const value = readRawRequiredString(args, "value");
  if (value.length > COMPUTER_TEXT_MAX_LENGTH)
    throw new ToolInputError('Argument "value" is too long.');
  return value;
}

/**
 * The `computer_select_text` range: two required non-negative integers,
 * bounded like every other argument because nothing validates MCP calls
 * against the JSON Schema. Never clamped and never defaulted — an offset the
 * element cannot take is the native layer's to refuse, while a malformed or
 * negative range is refused here before any state read is paid for.
 */
function readSelectTextRange(args: Record<string, unknown>): ComputerTextRange {
  const start = readNumberArg(args, "start");
  const length = readNumberArg(args, "length");
  if (start === undefined || length === undefined) {
    throw new ToolInputError('Arguments "start" and "length" are required.');
  }
  if (!Number.isSafeInteger(start) || start < 0 || start > COMPUTER_SELECT_TEXT_RANGE_MAX) {
    throw new ToolInputError(
      `Argument "start" must be an integer between 0 and ${COMPUTER_SELECT_TEXT_RANGE_MAX}.`,
    );
  }
  if (!Number.isSafeInteger(length) || length < 0 || length > COMPUTER_SELECT_TEXT_RANGE_MAX) {
    throw new ToolInputError(
      `Argument "length" must be an integer between 0 and ${COMPUTER_SELECT_TEXT_RANGE_MAX}.`,
    );
  }
  return { start, length };
}

/**
 * The `computer_select_text` target is semantic only: a selection writes a
 * range on one element, and a pixel coordinate cannot name which characters
 * that range covers — so x/y is refused outright rather than silently
 * resolving the window's first writable field.
 */
function readSelectTextTarget(args: Record<string, unknown>): ComputerTarget {
  const target = readScreenshotTarget(args);
  if (target.x !== undefined || target.y !== undefined || target.screenshotId !== undefined) {
    throw new ToolInputError(
      "computer_select_text targets a text element by label, role and window_id, not by x/y.",
    );
  }
  return {
    ...(target.label !== undefined ? { label: target.label } : {}),
    ...(target.role !== undefined ? { role: target.role } : {}),
    ...(target.windowId !== undefined ? { windowId: target.windowId } : {}),
    ...(target.ref !== undefined ? { ref: target.ref } : {}),
    ...(target.refOrdinal !== undefined ? { refOrdinal: target.refOrdinal } : {}),
  };
}

/**
 * The hotkey chord. Every key becomes a press/release pair holding the seat,
 * so thousands of keys would hold it indefinitely; the bound is enforced here
 * rather than trusted to the JSON Schema for the same reason as above.
 */
function readHotkeyKeys(args: Record<string, unknown>): readonly string[] {
  const keys =
    readStringArrayArg(args, "keys") ??
    (() => {
      throw new ToolInputError('Missing required argument "keys".');
    })();
  if (keys.length > COMPUTER_HOTKEY_MAX_KEYS) {
    throw new ToolInputError(`Argument "keys" accepts at most ${COMPUTER_HOTKEY_MAX_KEYS} keys.`);
  }
  const oversized = keys.find((key) => key.length > COMPUTER_KEY_NAME_MAX_LENGTH);
  if (oversized !== undefined) {
    throw new ToolInputError(
      `Each key in "keys" is at most ${COMPUTER_KEY_NAME_MAX_LENGTH} characters; got one of ${oversized.length}.`,
    );
  }
  return keys;
}

function readActionName(args: Record<string, unknown>): string {
  const value = readStringArg(args, "action", { required: true })!;
  if (value.length > COMPUTER_SEMANTIC_ACTION_MAX_LENGTH) {
    throw new ToolInputError(
      `Argument "action" is longer than ${COMPUTER_SEMANTIC_ACTION_MAX_LENGTH} characters.`,
    );
  }
  return value;
}

/** Bounded in bytes rather than characters: the backend pipes it to a process. */
function readClipboardText(args: Record<string, unknown>): string {
  const value = readRawRequiredString(args, "text");
  if (Buffer.byteLength(value, "utf8") > MAX_COMPUTER_CLIPBOARD_BYTES) {
    throw new ToolInputError(
      `Argument "text" is longer than the ${MAX_COMPUTER_CLIPBOARD_BYTES} byte clipboard limit.`,
    );
  }
  return value;
}

const CAPTURE_REGION_KEYS = ["x", "y", "width", "height"] as const;

/**
 * No target at all is the third, deliberate form: capture whatever window has
 * focus. It is resolved by the manager rather than here because focus is a
 * live property of the desktop, not of the request.
 */
type ScreenshotRequest =
  | ComputerCaptureRequest
  | { readonly kind: "focused"; readonly maxDimension?: number };

/**
 * The window and rect request forms are mutually exclusive on purpose: a
 * window id and a loose rect disagree about what "the region" is, and silently
 * preferring one would hand the model a screenshot of the wrong thing.
 *
 * A rect arrives in the pixels of the screenshot the model is zooming into;
 * `mapRegion` turns it into the desktop rect the backend captures.
 */
function readCaptureRequest(
  args: Record<string, unknown>,
  mapRegion: (region: ComputerRect) => ComputerRect,
): ScreenshotRequest {
  const windowId = readWindowIdArg(args);
  const present = CAPTURE_REGION_KEYS.filter(
    (key) => args[key] !== undefined && args[key] !== null,
  );
  const maxDimension = readCaptureMaxDimension(args);
  const limit = maxDimension === undefined ? {} : { maxDimension };

  if (windowId !== undefined) {
    if (present.length > 0) {
      throw new ToolInputError(
        'Pass either "window_id" or the region arguments "x", "y", "width" and "height", never both.',
      );
    }
    return { kind: "window", windowId, ...limit };
  }
  if (present.length === 0) {
    return { kind: "focused", ...limit };
  }
  if (present.length < CAPTURE_REGION_KEYS.length) {
    const missing = CAPTURE_REGION_KEYS.filter((key) => !present.includes(key));
    throw new ToolInputError(
      `A screenshot region needs "x", "y", "width" and "height". Missing: ${missing.join(", ")}.`,
    );
  }
  const region = {
    x: readNumberArg(args, "x")!,
    y: readNumberArg(args, "y")!,
    width: readNumberArg(args, "width")!,
    height: readNumberArg(args, "height")!,
  };
  if (region.width <= 0 || region.height <= 0) {
    throw new ToolInputError('Arguments "width" and "height" must be greater than zero.');
  }
  return { kind: "region", region: mapRegion(region), ...limit };
}

/**
 * Clamped to the agent image budget rather than to the backend's native ceiling.
 *
 * A larger request is not merely wasteful, it is wrong: a vision API downscales
 * anything past roughly 1568 px on its long edge before the model sees it, so
 * the model would read coordinates off a picture the server never produced and
 * every click would land short. The schema advertises the same maximum, and
 * this enforces it, because nothing validates MCP arguments against a schema.
 */
function readCaptureMaxDimension(args: Record<string, unknown>): number | undefined {
  const value = readNumberArg(args, "max_dimension");
  if (value === undefined) return undefined;
  if (value < 1) throw new ToolInputError('Argument "max_dimension" must be at least 1.');
  return Math.min(DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION, Math.floor(value));
}

const COMPUTER_MODIFIERS: readonly ComputerInputModifier[] = ["ctrl", "alt", "shift", "meta"];

/**
 * The modifiers to hold across a gesture, refusing a name this desktop cannot
 * press rather than silently dropping it — a shift-click delivered as a plain
 * click is a selection replaced instead of extended, and nothing in the result
 * would say so.
 */
function readModifiers(args: Record<string, unknown>): readonly ComputerInputModifier[] {
  const raw = readStringArrayArg(args, "modifiers");
  if (raw === undefined || raw.length === 0) return [];
  const modifiers = raw.map((entry) => entry.trim().toLowerCase());
  const unknown = modifiers.find(
    (entry) => !COMPUTER_MODIFIERS.includes(entry as ComputerInputModifier),
  );
  if (unknown !== undefined) {
    throw new ToolInputError(
      `Argument "modifiers" accepts only ${COMPUTER_MODIFIERS.join(", ")}; got ${JSON.stringify(unknown)}.`,
    );
  }
  return [...new Set(modifiers as ComputerInputModifier[])];
}

/**
 * Clamped rather than refused, like the drag duration: the caller's intent is
 * clear and only the scale is wrong. The ceiling is what keeps a model that
 * reads "wait for the installer" as minutes from stalling the whole turn behind
 * a sleep nothing can interrupt.
 */
function readWaitDurationMs(args: Record<string, unknown>): number {
  const value = readNumberArg(args, "duration_ms");
  if (value === undefined) throw new ToolInputError('Missing required argument "duration_ms".');
  return Math.min(COMPUTER_WAIT_MAX_MS, Math.max(0, Math.floor(value)));
}

function isToolResult(value: unknown): value is McpToolCallResult {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

/**
 * The availability a manager result carries, for the results that carry one.
 *
 * Looks inside an already-built tool result too, because the perception reads
 * that matter most build one themselves: `computer_get_state` returns image
 * content beside its JSON, so its availability rode in a text part rather than
 * on a plain object and the permission-required branch could never fire for the
 * one tool an agent reaches for first. Every text part this module produces is
 * `JSON.stringify` of its own payload, so parsing it back is reading our own
 * writing, not guessing at someone else's format.
 */
function resultAvailability(value: unknown): ComputerAvailability | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (isToolResult(value)) return resultAvailability(toolResultPayload(value));
  const availability = (value as { readonly availability?: unknown }).availability;
  if (typeof availability !== "object" || availability === null) return undefined;
  return availability as ComputerAvailability;
}

/** The decoded JSON payload of a tool result's text part, when it has one. */
function toolResultPayload(result: McpToolCallResult): Record<string, unknown> | undefined {
  const part = result.content.find((entry) => entry.type === "text");
  if (part?.type !== "text") return undefined;
  try {
    const parsed: unknown = JSON.parse(part.text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Replaces a permission-blocked result's user-facing prose with one line aimed
 * at the model.
 *
 * The availability message is written for the person reading the setup card —
 * where to click in System Settings, why the switch may already look on — and
 * handing it to an agent produced essays about macOS privacy instead of the one
 * sentence the situation needs. The card is already on screen; the model's part
 * is to stop. The rest of the payload is untouched, because a result can be
 * genuinely useful (a window list, a screen size) and still report a grant that
 * is missing.
 */
function withSetupNote(value: unknown, signal: ComputerSetupSignal | undefined): unknown {
  if (signal === undefined || typeof value !== "object" || value === null) return value;
  const availability = resultAvailability(value);
  return {
    ...(value as Record<string, unknown>),
    ...(availability?.kind === "permission-required"
      ? {
          availability: {
            kind: availability.kind,
            missing: availability.missing,
          },
        }
      : {}),
    setupRequired: computerSetupToolNote(signal),
  };
}

/**
 * The setup note on whatever shape the call produced, which is the whole point:
 * it used to reach only plain-object results, and every result that carries a
 * screenshot — a screenshot, a state read with an image, every observed action
 * — is already a built tool result, as is every error. So the model was handed
 * the card's existence with none of the instruction that goes with it on
 * exactly the paths where a grant is most likely to be the reason it is stuck.
 *
 * A JSON text part gains a `setupRequired` field; anything else gains a
 * trailing paragraph, which is the honest fallback for prose.
 */
function withSetupNoteOnResult(
  result: McpToolCallResult,
  signal: ComputerSetupSignal | undefined,
): McpToolCallResult {
  if (signal === undefined) return result;
  const note = computerSetupToolNote(signal);
  const index = result.content.findIndex((entry) => entry.type === "text");
  if (index === -1) {
    return {
      ...result,
      content: [...result.content, { type: "text", text: note }],
    };
  }
  const part = result.content[index];
  if (part?.type !== "text") return result;
  const content = [...result.content];
  content[index] = { type: "text", text: withSetupNoteInText(part.text, note) };
  return { ...result, content };
}

/**
 * First-mutation disclosure on whatever shape the call produced. A JSON text
 * part gains a `disclosure` field; anything else gains a leading line, so the
 * first mutating payload in a turn always names the switch.
 */
function withDisclosureOnResult(result: McpToolCallResult, disclosure: string): McpToolCallResult {
  const index = result.content.findIndex((entry) => entry.type === "text");
  if (index === -1) {
    return {
      ...result,
      content: [...result.content, { type: "text", text: disclosure }],
    };
  }
  const part = result.content[index];
  if (part?.type !== "text") return result;
  const content = [...result.content];
  try {
    const parsed: unknown = JSON.parse(part.text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      content[index] = {
        type: "text",
        text: JSON.stringify({
          ...(parsed as Record<string, unknown>),
          disclosure,
        }),
      };
      return { ...result, content };
    }
  } catch {
    // Fall through to the prose prepend below.
  }
  content[index] = { type: "text", text: `${disclosure}\n\n${part.text}` };
  return { ...result, content };
}

function withSetupNoteInText(text: string, note: string): string {
  const parsed: unknown = (() => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  })();
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return `${text}\n\n${note}`;
  }
  return JSON.stringify({
    ...(parsed as Record<string, unknown>),
    setupRequired: note,
  });
}

function withGuidanceOnResult(
  result: McpToolCallResult,
  guidance: string | undefined,
): McpToolCallResult {
  if (guidance === undefined) return result;
  const content = [...result.content];
  const index = content.findIndex((part) => part.type === "text");
  if (index < 0) return { ...result, content: [{ type: "text", text: guidance }, ...content] };
  const part = content[index]!;
  if (part.type !== "text") return result;
  try {
    const value: unknown = JSON.parse(part.text);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      content[index] = {
        type: "text",
        text: JSON.stringify({ ...(value as Record<string, unknown>), toolGuidance: guidance }),
      };
      return { ...result, content };
    }
  } catch {
    // Non-JSON result text keeps its original shape and receives the reminder inline.
  }
  content[index] = { type: "text", text: `${guidance}\n${part.text}` };
  return { ...result, content };
}

export function makeAgentGatewayComputerTools(
  options: AgentGatewayComputerToolsOptions,
): ReadonlyArray<ToolEntry> {
  const { manager, onSetupRequired } = options;
  /**
   * The screenshots each thread has been shown, so its x/y can be read as
   * pixels in one of them. Lives with the tools rather than the manager
   * because it is the tool surface's contract with the model: the manager
   * and the pane keep speaking desktop coordinates.
   */
  const frames = new ScreenshotFrameRegistry();

  /**
   * Consecutive unchanged scrolls per thread, with the window they were on.
   * Three in a row on the same window means the content is not moving, so the
   * fourth is refused before it touches the backend. A changed picture, a
   * different window, or any non-scroll call clears the streak.
   */
  const unchangedScrolls = new Map<string, { windowId: string | undefined; count: number }>();

  /**
   * Turns that already disclosed first-mutation control. One disclosure per
   * (thread, turn): the first mutating result carries it, the rest stay quiet.
   */
  const disclosedFirstMutations = new Set<string>();

  /**
   * The last element digest each thread saw, per observation scope
   * (window_id + label_contains). `diff` on computer_get_state compares the
   * fresh read against it; a batch's closing state re-baselines the scope it
   * observed so a following diff does not re-report what the run already
   * returned.
   */
  const elementDigests = new Map<string, ComputerActionableElements>();

  /**
   * Element refs are stable handles, not listing positions. A thread's table
   * binds a number to an actionable identity — window, role, full label and
   * which same-labelled control it is — the first time a listing shows it;
   * later listings remap their elements onto the same numbers. Ref 7 keeps
   * meaning "that Save button" across observations and window-scoped reads,
   * so a diff does not silently move the handles a model is holding.
   *
   * Nothing prunes a live binding: resolution goes back to the real tree, so
   * a control that vanished fails there as not-found with candidates rather
   * than being second-guessed here. The cap resets the whole table rather
   * than recycling numbers a model could still be holding — old refs then
   * fail loudly instead of retargeting.
   */
  interface ElementRefTable {
    next: number;
    readonly byKey: Map<string, number>;
    readonly entries: Map<number, ComputerActionableElementRef>;
  }
  const elementRefTables = new Map<string, ElementRefTable>();
  const MAX_ELEMENT_REFS = 512;

  /**
   * Stamp a digest's items with the thread's stable refs, minting new numbers
   * for first-seen identities. Returns a new digest; the input is untouched.
   */
  const syncElementRefs = (
    threadId: string,
    elements: ComputerActionableElements,
  ): ComputerActionableElements => {
    let table = elementRefTables.get(threadId);
    if (table === undefined) {
      table = { next: 0, byKey: new Map(), entries: new Map() };
      elementRefTables.set(threadId, table);
    }
    const items = elements.items.map((item, index) => {
      const id = elements.refIndex[index]!;
      const key = JSON.stringify([id.windowId, id.role, id.label, id.ordinal]);
      let ref = table.byKey.get(key);
      if (ref === undefined) {
        if (table.next >= MAX_ELEMENT_REFS) {
          table.next = 0;
          table.byKey.clear();
          table.entries.clear();
        }
        ref = table.next++;
        table.byKey.set(key, ref);
      }
      table.entries.set(ref, id);
      return { ...item, ref };
    });
    return { ...elements, items };
  };

  /**
   * Digests key on thread × window × filter, and nothing purges them when a
   * thread ends — over a long session they would grow without bound. The cap
   * is far above the scopes one session realistically diffs; eviction loses
   * only diff granularity, never a read the model is holding.
   *
   * Storing is also stamping: the digest that lands here carries the thread's
   * stable refs, and the same copy is what the caller serializes, so the
   * numbers a model reads always resolve through the table written here.
   */
  const rememberDigest = (
    threadId: string,
    key: string,
    elements: ComputerActionableElements,
  ): ComputerActionableElements => {
    const stable = syncElementRefs(threadId, elements);
    elementDigests.delete(key);
    elementDigests.set(key, stable);
    while (elementDigests.size > 64) elementDigests.delete(elementDigests.keys().next().value!);
    return stable;
  };

  /** Apps whose guidance note a thread has already been shown. */
  const appHintsSeen = new Set<string>();
  const guidanceCadence = new ToolGuidanceCadence(10, 256);

  const digestScopeKey = (
    threadId: string,
    windowId: string | undefined,
    labelContains: string | undefined,
  ): string => JSON.stringify([threadId, windowId ?? null, labelContains ?? null]);

  /**
   * PNG bytes travel as MCP image content and the metadata as the text part.
   * Delivering is also remembering: the screenshot becomes the frame the
   * thread's next x/y are measured in, and the metadata carries the id that
   * lets the model name it later.
   */
  const deliverScreenshot = (
    threadId: string,
    payload: Record<string, unknown>,
    screenshot: ComputerScreenshot,
    windowId?: string,
  ): McpToolCallResult => {
    assertDesktopOperationActive();
    if (windowId && screenshot.windowId && windowId !== screenshot.windowId) {
      throw new ToolInputError("Screenshot identity differs from the requested window.");
    }
    windowId ??= screenshot.windowId;
    // SYNARA_CUA_CAPTURE_REUSE: when the fresh capture is byte-for-byte the
    // latest delivered frame with the same coordinate frame, name that frame
    // instead of shipping identical pixels again. The capture itself always
    // ran — byte identity is the only proof nothing moved — so this never
    // serves a stale picture; it saves the image part of the result. Same
    // rule the post-action observer applies, extended to explicit reads.
    if (cuaCaptureReuseEnabled()) {
      const reused = frames.matchLatest(threadId, screenshot, windowId);
      if (reused) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ...payload,
                screenshotUnchanged: true,
                screenshotId: reused.id,
                screenshot: {
                  screenshotId: reused.id,
                  windowId: reused.windowId,
                  region: reused.region,
                  width: reused.width,
                  height: reused.height,
                  scale: reused.scale,
                },
                note: "The screen is byte-for-byte what your previous screenshot showed, with the same coordinates. Continue using this screenshotId. This does not prove nothing changed; wait and look again before repeating an action.",
              }),
            },
          ],
        };
      }
    }
    const { bytesBase64, ...metadata } = screenshot;
    const frame = frames.record(threadId, screenshot, windowId);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ...payload,
            screenshot: {
              ...(frame ? { screenshotId: frame.id } : {}),
              ...(windowId !== undefined ? { windowId } : {}),
              ...metadata,
            },
          }),
        },
        { type: "image", data: bytesBase64, mimeType: "image/png" },
      ],
    };
  };

  const capturedScreenshotResult = (
    threadId: string,
    request: ComputerCaptureRequest,
    screenshot: ComputerScreenshot,
  ): McpToolCallResult =>
    deliverScreenshot(
      threadId,
      { computerId: manager.computerId },
      screenshot,
      request.kind === "window" ? request.windowId : undefined,
    );

  /**
   * The model's target as the manager understands it: screenshot pixels
   * become a desktop point through the frame they were measured in. A target
   * with no coordinates (a label, or nothing) passes through untouched, and a
   * half coordinate is left for the manager to refuse with its usual message.
   */
  const resolveTarget = (target: ScreenshotTarget, threadId: string): ComputerTarget => {
    const { screenshotId, ...rest } = target;
    // A ref names the element the thread's listings first showed under that
    // number: it resolves to the recorded identity — full label, role,
    // window — plus the ordinal that tells same-labelled controls apart.
    // Label, role or window_id sent beside a ref are read as a claim about
    // which element the ref meant; a mismatch means caller and server are
    // looking at different listings, and guessing is worse than refusing.
    if (typeof target.ref === "number") {
      if (target.x !== undefined || target.y !== undefined) {
        throw new ToolInputError(
          "A ref target takes no x/y; it names an element from the elements listing.",
        );
      }
      const table = elementRefTables.get(threadId);
      const entry = table?.entries.get(target.ref);
      if (entry === undefined) {
        throw new ToolInputError(
          table === undefined
            ? "No elements listing exists yet in this thread; ref targets need a computer_get_state first."
            : `ref ${target.ref} does not match any element this thread has observed. Observe again with computer_get_state.`,
        );
      }
      // Long labels reach the model truncated at the ellipsis, so a claim
      // only has to match what the listing actually showed.
      const claim = normalizeLabelSpaces(target.label ?? "").replace(/…$/, "");
      if (target.label !== undefined && !normalizeLabelSpaces(entry.label).startsWith(claim)) {
        throw new ToolInputError(
          `ref ${target.ref} is the ${entry.role} ${JSON.stringify(entry.label)}, not ${JSON.stringify(target.label)}. Observe again with computer_get_state.`,
        );
      }
      if (target.role !== undefined && target.role !== entry.role) {
        throw new ToolInputError(
          `ref ${target.ref} is a ${entry.role}, not ${JSON.stringify(target.role)}. Observe again with computer_get_state.`,
        );
      }
      if (
        target.windowId !== undefined &&
        entry.windowId !== null &&
        target.windowId !== entry.windowId
      ) {
        throw new ToolInputError(
          `ref ${target.ref} is in window ${JSON.stringify(entry.windowId)}, not ${JSON.stringify(target.windowId)}. Observe again with computer_get_state.`,
        );
      }
      if (target.refOrdinal !== undefined && target.refOrdinal !== entry.ordinal) {
        throw new ToolInputError(
          `ref ${target.ref} is duplicate ${entry.ordinal + 1} of its label, not ${target.refOrdinal + 1}. Observe again with computer_get_state.`,
        );
      }
      return {
        label: entry.label,
        role: entry.role,
        ...(entry.windowId !== null ? { windowId: entry.windowId } : {}),
        refOrdinal: entry.ordinal,
      };
    }
    if (typeof target.x !== "number" || typeof target.y !== "number") return rest;
    const frame = frames.resolve(threadId, screenshotId);
    if (frame.windowId && rest.windowId && frame.windowId !== rest.windowId)
      throw new ToolInputError("Screenshot and action name different windows.");
    const resolved = {
      ...rest,
      ...screenshotPointToDesktop(frame, target.x, target.y),
      ...(frame.windowId ? { windowId: frame.windowId, observedWindowBounds: frame.region } : {}),
    };
    return resolved;
  };

  const readTarget = (args: Record<string, unknown>, context: ToolContext): ComputerTarget =>
    resolveTarget(readScreenshotTarget(args), context.callerThreadId);

  const readNestedTarget = (
    args: Record<string, unknown>,
    name: string,
    context: ToolContext,
  ): ComputerTarget =>
    resolveTarget(readNestedScreenshotTarget(args, name), context.callerThreadId);

  /**
   * Window-id → driven-app resolution for pre-queue consent. Mirrors the
   * in-queue assert's keying: a window with no app name consents under its id
   * rather than silently skipping the boundary. Best-effort — a read failure
   * resolves nothing and the in-queue assert stays the backstop.
   */
  const drivenAppsForWindows = async (windowIds: ReadonlySet<string>): Promise<Set<string>> => {
    const apps = new Set<string>();
    if (windowIds.size === 0) return apps;
    const windows = await manager
      .listWindows()
      .then((listed) => listed.windows)
      .catch(() => undefined);
    if (windows === undefined) return apps;
    for (const window of windows) {
      if (windowIds.has(window.id)) apps.add(window.appName ?? window.id);
    }
    return apps;
  };

  /**
   * Pid → driven-app resolution for the app-level visibility tool: the pid is
   * the target, but consent is keyed on apps, so it resolves through the same
   * process list the in-queue assert consults. A pid that resolves to nothing
   * admits under the pid key the manager falls back to — the boundary is
   * never skipped for want of a name.
   */
  const drivenAppsForPids = async (pids: ReadonlySet<number>): Promise<Set<string>> => {
    const apps = new Set<string>();
    if (pids.size === 0) return apps;
    const listed = await manager
      .listApps()
      .then((result) => result.apps)
      .catch(() => undefined);
    for (const pid of pids) {
      const named = listed?.find((app) => app.pid === pid && app.running)?.name;
      apps.add(named ?? `pid ${pid}`);
    }
    return apps;
  };

  /**
   * The apps a call is about to drive, resolved before the desktop queue so a
   * consent prompt never holds the serialized operation slot. Steps inside a
   * computer_run are scanned raw — full validation still happens in the
   * dispatcher — and an unresolvable activate target skips admission for the
   * in-queue assert to answer.
   */
  const drivenAppsForCall = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<ReadonlySet<string>> => {
    if (name === "computer_launch_app") {
      return typeof args.app === "string" && args.app.trim().length > 0
        ? new Set([args.app])
        : new Set();
    }
    if (
      name === "computer_activate_window" ||
      name === "computer_set_window_frame" ||
      name === "computer_invoke_menu" ||
      name === "computer_kill_app" ||
      name === "computer_set_window_minimized"
    ) {
      return typeof args.window_id === "string" && args.window_id.length > 0
        ? drivenAppsForWindows(new Set([args.window_id]))
        : new Set();
    }
    if (name === "computer_set_app_visibility") {
      const pid = args.pid;
      return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0
        ? drivenAppsForPids(new Set([pid]))
        : new Set();
    }
    if (name === "computer_run") {
      const apps = new Set<string>();
      const windowIds = new Set<string>();
      const pids = new Set<number>();
      for (const step of Array.isArray(args.steps) ? args.steps : []) {
        if (step === null || typeof step !== "object" || Array.isArray(step)) continue;
        const type = Reflect.get(step, "type");
        if (type === "launch_app") {
          const app = Reflect.get(step, "app");
          if (typeof app === "string" && app.trim().length > 0) apps.add(app);
        } else if (
          type === "activate_window" ||
          type === "set_window_frame" ||
          type === "invoke_menu" ||
          type === "kill_app" ||
          type === "set_window_minimized"
        ) {
          const windowId = Reflect.get(step, "window_id");
          if (typeof windowId === "string" && windowId.length > 0) windowIds.add(windowId);
        } else if (type === "set_app_visibility") {
          const pid = Reflect.get(step, "pid");
          if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
        }
      }
      for (const app of await drivenAppsForWindows(windowIds)) apps.add(app);
      for (const app of await drivenAppsForPids(pids)) apps.add(app);
      return apps;
    }
    return new Set();
  };

  /**
   * What a durable "always allow" grant would have to cover for this call:
   * the stable app identities it provably drives and the action classes it
   * exercises. Resolved before the approval prompt so a live grant can waive
   * it — and so the prompt can offer exactly this scope.
   *
   * Best-effort like {@link drivenAppsForCall}, but stricter about honesty:
   * the consent keys it computes are display names, while a grant is keyed
   * on bundle id + signing team where the backend reports them. A target
   * that cannot be resolved to a stable identity — a bare label search that
   * may land in any window, the shared clipboard, an ambiguous stack of
   * windows under a point — is left unattributed, and only an explicit
   * any-app grant can cover it. Inventory reads fail open to `undefined`,
   * which marks the affected target unattributed rather than guessing.
   */
  const grantCallContextFor = async (
    name: string,
    args: Record<string, unknown>,
    threadId: string,
  ): Promise<ComputerGrantCallContext> => {
    const classes = computerGrantClassesForTool(name, args);
    const identities = new Map<string, ComputerGrantAppIdentity>();
    let unattributed = false;

    let windowsRead: readonly ComputerWindow[] | undefined;
    let windowsLoaded = false;
    const windows = async (): Promise<readonly ComputerWindow[] | undefined> => {
      if (!windowsLoaded) {
        windowsLoaded = true;
        windowsRead = await manager
          .listWindows()
          .then((listed) => listed.windows)
          .catch(() => undefined);
      }
      return windowsRead;
    };
    let appsRead: readonly ComputerApp[] | undefined;
    let appsLoaded = false;
    const apps = async (): Promise<readonly ComputerApp[] | undefined> => {
      if (!appsLoaded) {
        appsLoaded = true;
        appsRead = await manager
          .listApps()
          .then((listed) => listed.apps)
          .catch(() => undefined);
      }
      return appsRead;
    };

    const addIdentity = (identity: ComputerGrantAppIdentity | undefined): boolean => {
      if (identity === undefined) return false;
      identities.set(computerGrantIdentityKey(identity), identity);
      return true;
    };
    const addWindow = async (windowId: string | undefined): Promise<boolean> => {
      if (windowId === undefined) return false;
      const window = (await windows())?.find((candidate) => candidate.id === windowId);
      if (window === undefined) return false;
      return addIdentity(computerGrantIdentityForWindow(window, await apps()));
    };
    const addPid = async (pid: number | undefined): Promise<boolean> => {
      if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return false;
      return addIdentity(computerGrantIdentityForPid(pid, await apps()));
    };
    /** Untargeted keyboard/pointer input lands on the agent's focused window. */
    const addAimedWindow = async (): Promise<boolean> => {
      const aimed = (await windows())?.find((candidate) => candidate.focused);
      if (aimed === undefined) return false;
      return addIdentity(computerGrantIdentityForWindow(aimed, await apps()));
    };

    /**
     * One input-class target — the args of a standalone tool or one run
     * step's fields. An explicit window id wins; screenshot-scoped
     * coordinates ride their frame's window, or the windows covering the
     * resolved desktop point when the frame named none; a bare label/role
     * search resolves across the whole desktop at dispatch time and is left
     * unattributed; and a call with no target at all reaches the window the
     * agent seat has focused.
     */
    const addInputTarget = async (targetArgs: Record<string, unknown>): Promise<void> => {
      const raw = readScreenshotTarget(targetArgs);
      if (raw.ref !== undefined) {
        // A ref names a listed element — its window is the attribution, the
        // same one dispatch resolves. A ref that does not resolve leaves the
        // call unattributed rather than crediting the focused window.
        let resolved: ComputerTarget;
        try {
          resolved = resolveTarget(raw, threadId);
        } catch {
          unattributed = true;
          return;
        }
        if (resolved.windowId !== undefined && (await addWindow(resolved.windowId))) return;
        unattributed = true;
        return;
      }
      if (raw.windowId !== undefined) {
        if (!(await addWindow(raw.windowId))) unattributed = true;
        return;
      }
      if (raw.label !== undefined || raw.role !== undefined) {
        unattributed = true;
        return;
      }
      if (raw.x !== undefined || raw.y !== undefined || raw.screenshotId !== undefined) {
        let resolved: ComputerTarget;
        try {
          resolved = resolveTarget(raw, threadId);
        } catch {
          unattributed = true;
          return;
        }
        if (resolved.windowId !== undefined) {
          if (!(await addWindow(resolved.windowId))) unattributed = true;
          return;
        }
        if (resolved.x === undefined || resolved.y === undefined) {
          unattributed = true;
          return;
        }
        const listed = await windows();
        if (listed === undefined) {
          unattributed = true;
          return;
        }
        // The compositor routes an unscoped point to the topmost window at
        // it; when stacking cannot name one, every covering window is a
        // candidate — the same closure the denylist applies to the same
        // ambiguity.
        const point = { x: resolved.x, y: resolved.y };
        const topmost = topmostWindowAtPoint(listed, point);
        const covering =
          topmost !== undefined
            ? [topmost]
            : listed.filter(
                (window) =>
                  window.visible && !window.minimized && rectContainsPoint(window.bounds, point),
              );
        if (covering.length === 0) {
          unattributed = true;
          return;
        }
        for (const window of covering) {
          if (!addIdentity(computerGrantIdentityForWindow(window, await apps()))) {
            unattributed = true;
          }
        }
        return;
      }
      if (!(await addAimedWindow())) unattributed = true;
    };

    const addLifecycleStep = async (step: Record<string, unknown>): Promise<void> => {
      const windowId = readStringArg(step, "window_id") ?? readStringArg(step, "windowId");
      if (!(await addWindow(windowId))) unattributed = true;
    };

    if (name === "computer_launch_app") {
      const app = typeof args.app === "string" ? args.app : undefined;
      if (!addIdentity(computerGrantIdentityForAppArg(app ?? "", await apps()))) {
        unattributed = true;
      }
    } else if (name === "computer_set_app_visibility") {
      const pid = readNumberArg(args, "pid");
      if (!(await addPid(pid))) unattributed = true;
    } else if (
      name === "computer_activate_window" ||
      name === "computer_set_window_frame" ||
      name === "computer_invoke_menu" ||
      name === "computer_kill_app" ||
      name === "computer_set_window_minimized"
    ) {
      await addLifecycleStep(args);
    } else if (name === "computer_read_clipboard" || name === "computer_write_clipboard") {
      // The clipboard is the human's shared store — no app owns it, so only
      // an any-app grant can ever cover it.
      unattributed = true;
    } else if (name === "computer_paste") {
      // A paste writes the clipboard and sends the paste keystroke into one
      // window: the named window, or the agent's focused one.
      const windowId = readWindowIdArg(args);
      if (windowId !== undefined) {
        if (!(await addWindow(windowId))) unattributed = true;
      } else if (!(await addAimedWindow())) {
        unattributed = true;
      }
    } else if (name === "computer_run") {
      for (const step of Array.isArray(args.steps) ? args.steps : []) {
        if (step === null || typeof step !== "object" || Array.isArray(step)) continue;
        const type = Reflect.get(step, "type");
        switch (type) {
          case "click":
          case "double_click":
          case "triple_click":
          case "right_click":
          case "move_cursor":
          case "scroll":
          case "type_text":
          case "press_key":
          case "hotkey":
          case "set_value":
          case "perform_action":
          case "select_text":
            await addInputTarget(step as Record<string, unknown>);
            break;
          case "drag": {
            const from = readRecordArg(step as Record<string, unknown>, "from");
            const to = readRecordArg(step as Record<string, unknown>, "to");
            if (from === undefined || to === undefined) {
              unattributed = true;
              break;
            }
            await addInputTarget(from);
            await addInputTarget(to);
            break;
          }
          case "paste": {
            const windowId =
              readStringArg(step as Record<string, unknown>, "window_id") ??
              readStringArg(step as Record<string, unknown>, "windowId");
            if (windowId !== undefined) {
              if (!(await addWindow(windowId))) unattributed = true;
            } else if (!(await addAimedWindow())) {
              unattributed = true;
            }
            break;
          }
          case "write_clipboard":
            unattributed = true;
            break;
          case "activate_window":
          case "set_window_frame":
          case "invoke_menu":
          case "kill_app":
          case "set_window_minimized":
            await addLifecycleStep(step as Record<string, unknown>);
            break;
          case "launch_app": {
            const app = Reflect.get(step, "app");
            if (
              !addIdentity(
                computerGrantIdentityForAppArg(typeof app === "string" ? app : "", await apps()),
              )
            ) {
              unattributed = true;
            }
            break;
          }
          case "set_app_visibility": {
            const pid = Reflect.get(step, "pid");
            if (!(await addPid(typeof pid === "number" ? pid : undefined))) {
              unattributed = true;
            }
            break;
          }
          // `wait` and unknown step types carry no mutation a grant names;
          // unknown types are refused at dispatch on their own.
          default:
            break;
        }
      }
    } else {
      // click/scroll/type/key/select/set_value/perform_action/move_cursor —
      // the remaining gated input tools share the one target resolver.
      await addInputTarget(args);
    }

    return {
      apps: [...identities.values()],
      includesUnattributedTarget: unattributed,
      classes,
    };
  };

  /**
   * Raise the chat's setup card for this call, if it earned one, and hand the
   * result back either way. A card is user-facing feedback about the tool call,
   * never a substitute for answering it.
   */
  const withSetupCard = (
    name: string,
    context: ToolContext,
    signal: ComputerSetupSignal | undefined,
    result: McpToolCallResult,
  ): Effect.Effect<McpToolCallResult> => {
    if (onSetupRequired === undefined || signal === undefined) return Effect.succeed(result);
    return onSetupRequired({
      toolName: name,
      missing: signal.missing,
      ...(signal.buildSignature === undefined ? {} : { buildSignature: signal.buildSignature }),
      ...(signal.bundleId === undefined ? {} : { bundleId: signal.bundleId }),
      context,
    }).pipe(Effect.as(result));
  };

  /**
   * Write one session-recording step line — the seam the outer call record
   * and every `computer_run` inner step share. The fidelity gate, the
   * secure-window protection flag, arg redaction, declared-target
   * derivation and the approval/resolutions/dispatches/effect/latency
   * fields are identical in both; only what the step ran under, what it
   * captured and the caller's final effect differ. `outcome.resultValue`
   * carries the one read-back payload a session summarizes (the clipboard
   * text stays out either way — `result` is chars + hash), for the calls
   * that return one.
   */
  const writeSessionStep = (input: {
    readonly threadId: string;
    readonly turnId: string | null;
    readonly tool: string;
    readonly args: Record<string, unknown>;
    readonly approval: ComputerRecordingApproval;
    readonly capture: ComputerRecordingCapture | undefined;
    readonly outcome: {
      readonly effect: ComputerRecordingStepInput["effect"];
      readonly code?: string;
      /** A read-back payload the call returned (clipboard contents), summarized. */
      readonly resultValue?: string;
    };
    readonly startedAt: number;
  }): void => {
    const fidelity = manager.recordingFidelityFor(input.threadId);
    if (fidelity === undefined) return;
    const secure = (input.capture?.resolutions ?? []).some(
      (resolution) => resolution.secure === true,
    );
    const redacted = redactComputerRecordingArgs(input.args, { fidelity, protected: secure });
    const declaredTarget = computerRecordingDeclaredTarget(input.args);
    manager.recordComputerStep(input.threadId, {
      tool: input.tool,
      actionClass: computerRecordingActionClass(input.tool),
      threadId: input.threadId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      approval: input.approval,
      ...(declaredTarget !== undefined ? { declaredTarget } : {}),
      resolutions: input.capture?.resolutions ?? [],
      args: redacted.args,
      ...(redacted.payload !== undefined ? { payload: redacted.payload } : {}),
      ...(input.outcome.resultValue !== undefined
        ? { result: redactComputerRecordingResult(input.outcome.resultValue) }
        : {}),
      dispatches: input.capture?.dispatches ?? [],
      effect: input.outcome.effect,
      ...(input.outcome.code !== undefined ? { code: input.outcome.code } : {}),
      latencyMs: Math.max(0, Date.now() - input.startedAt),
    });
  };

  const handle =
    (
      name: string,
      run: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>,
    ) =>
    (args: Record<string, unknown>, context: ToolContext) => {
      const guidance = guidanceCadence.shouldRefresh(context.callerThreadId)
        ? COMPUTER_TOOL_REFRESH_GUIDANCE
        : undefined;
      // The audit record's resolved fields, filled as the call learns them:
      // the admitted apps before dispatch, the delivered window id after.
      let drivenApps: ReadonlySet<string> = new Set();
      let resultWindowId: string | undefined;
      const audit = (outcome: {
        readonly effect: ComputerAuditEffect;
        readonly code?: string;
      }): void => {
        if (!COMPUTER_AUDITED_TOOLS.has(name)) return;
        const target = computerAuditTarget(args, drivenApps, resultWindowId);
        manager.recordComputerAudit({
          tool: name,
          threadId: context.callerThreadId,
          ...(context.callerTurnId ? { turnId: context.callerTurnId } : {}),
          args: summarizeComputerAuditArgs(args),
          ...(target !== undefined ? { target } : {}),
          effect: outcome.effect,
          ...(outcome.code !== undefined ? { code: outcome.code } : {}),
        });
      };
      // The recording seam rides the same outcome points the audit does, plus
      // the call's own capture: when this thread has an open session the
      // manager's resolution and dispatch notes land on `capture` as the call
      // runs, and the step record is written when the outcome is known. No
      // session means no capture and `record` is a no-op — the hot path is
      // unchanged.
      const capture = manager.recordingCaptureFor(context.callerThreadId);
      const callStartedAt = Date.now();
      let recordingApproval: ComputerRecordingApproval = {
        required: computerToolRequiresApproval(name),
        decision: computerToolRequiresApproval(name) ? "unavailable" : "not-required",
      };
      const record = (outcome: {
        readonly effect: ComputerRecordingStepInput["effect"];
        readonly code?: string;
        /** A read-back payload the call returned (clipboard contents), summarized. */
        readonly resultValue?: string;
      }): void =>
        writeSessionStep({
          threadId: context.callerThreadId,
          turnId: context.callerTurnId,
          tool: name,
          args,
          approval: recordingApproval,
          capture,
          outcome: {
            ...outcome,
            // `dispatched-unknown` means "the backend accepted it" — a call
            // whose capture holds no dispatch (a perception read, a
            // recording-family call, a file read) must not claim one. The
            // run container is exempt: its dispatches live on the inner steps.
            effect:
              outcome.effect === "dispatched-unknown" &&
              name !== "computer_run" &&
              (capture?.dispatches.length ?? 0) === 0
                ? "not-dispatched"
                : outcome.effect,
          },
          startedAt: callStartedAt,
        });
      return Effect.tryPromise({
        try: async (abortSignal) => {
          if (
            computerToolRequiresApproval(name) &&
            (options.authorizeAction !== undefined ||
              PROVIDERS_WITHOUT_APPROVAL_GATE.has(context.callerProvider) ||
              args.delivery_mode === "foreground" ||
              name === "computer_activate_window")
          ) {
            if (!options.authorizeAction) {
              recordingApproval = { required: true, decision: "unavailable" };
              audit({ effect: "refused", code: "approval_unavailable" });
              record({ effect: "refused", code: "approval_unavailable" });
              return {
                result: approvalUnavailableResult(name),
                signal: undefined,
              };
            }
            // Resolved only now that a prompt can actually fire: the read may
            // list windows and apps to attribute the call, and it feeds both
            // the grant check that can waive this prompt and the always-allow
            // scope the prompt offers. A resolution failure denies the
            // attribution, never the call — the prompt then decides alone.
            const grantContext = await grantCallContextFor(
              name,
              args,
              context.callerThreadId,
            ).catch(() => undefined);
            if (
              !(await options.authorizeAction(
                name,
                name === "computer_activate_window"
                  ? { ...args, delivery_mode: "foreground" }
                  : args,
                context,
                abortSignal,
                grantContext,
              ))
            ) {
              recordingApproval = { required: true, decision: "denied" };
              audit({ effect: "refused", code: "approval_denied" });
              record({ effect: "refused", code: "approval_denied" });
              return {
                result: mcpToolResultError(
                  "Computer action was denied or cancelled; no input was sent.",
                ),
                signal: undefined,
              };
            }
            recordingApproval = { required: true, decision: "granted" };
          } else if (computerToolRequiresApproval(name)) {
            // Required by the taxonomy but the gate never engaged — the
            // trusted-baseline case the record must name honestly.
            recordingApproval = { required: true, decision: "skipped" };
          }
          // Second-app consent runs here, on the caller's signal, before the
          // desktop queue is taken: a prompt nobody can reach must never park
          // the serialized operation slot.
          drivenApps = await drivenAppsForCall(name, args);
          // The classes ride along so a live grant covering this app for
          // exactly what the call does can satisfy the second-app boundary
          // too — the prompt stays the fallback for anything ungranted.
          const grantClasses = computerGrantClassesForTool(name, args);
          for (const app of drivenApps) {
            await manager.admitDrivenApp(context.callerThreadId, app, {
              signal: abortSignal,
              turnId: context.callerTurnId ?? undefined,
              toolName: name,
              grantClasses,
            });
          }
          // Any non-scroll call breaks an unchanged-scroll streak: the model
          // looked or did something else instead of scrolling blindly on.
          if (name !== "computer_scroll") unchangedScrolls.delete(context.callerThreadId);
          // Recorded before the call, because the call is what claims the
          // desktop, and the badge has to name this thread from the first
          // action rather than from the second.
          manager.setThreadLabel(context.callerThreadId, context.callerThreadLabel);
          // Action targeting and automatic previews do not replace a model's
          // explicit observation after a desktop interruption.
          const invoke = () =>
            withComputerRecordingCapture(capture, () =>
              withComputerTask(
                {
                  threadId: context.callerThreadId,
                  ...(context.callerTurnId ? { turnId: context.callerTurnId } : {}),
                  ...(context.callerThreadLabel ? { label: context.callerThreadLabel } : {}),
                },
                () =>
                  name === "computer_get_state" ||
                  name === "computer_screenshot" ||
                  name === "computer_wait" ||
                  // A run's internal reads — the wait-step polls and the closing
                  // state — are the model's observations, with the same authority
                  // to satisfy a pending observation requirement.
                  name === "computer_run"
                    ? withModelDesktopObservation(() => run(args, context))
                    : run(args, context),
              ),
            );
          const value =
            name === "computer_wait"
              ? await (async () => {
                  await Effect.runPromise(context.assertCallerTurnActive(), {
                    signal: abortSignal,
                  });
                  const value = await withDesktopOperationSignal(abortSignal, () =>
                    manager.cursorActivity.during(
                      context.callerThreadId,
                      cursorToolActivity(name),
                      invoke,
                    ),
                  );
                  await Effect.runPromise(context.assertCallerTurnActive(), {
                    signal: abortSignal,
                  });
                  return value;
                })()
              : await manager.withAgentActivity(
                  context.callerThreadId,
                  async () => {
                    await Effect.runPromise(context.assertCallerTurnActive(), {
                      signal: abortSignal,
                    });
                    abortSignal.throwIfAborted();
                    const foreground =
                      args.delivery_mode === "foreground" || name === "computer_activate_window";
                    return withDesktopDeliveryMode(foreground ? "foreground" : "background", () =>
                      // computer_activate_window already restores via
                      // foregroundWithRestore; every other foreground call gets
                      // the same excursion treatment, so a foreground type or
                      // click cannot strand the user's window behind the target.
                      foreground && name !== "computer_activate_window"
                        ? manager.withForegroundRestore(context.callerThreadId, () =>
                            manager.cursorActivity.during(
                              context.callerThreadId,
                              cursorToolActivity(name),
                              invoke,
                            ),
                          )
                        : manager.cursorActivity.during(
                            context.callerThreadId,
                            cursorToolActivity(name),
                            invoke,
                          ),
                    );
                  },
                  abortSignal,
                  context.callerTurnId ?? undefined,
                  name === "computer_type_text" &&
                    args.delivery_mode !== "foreground" &&
                    manager.supportsFocusNeutralSemanticText &&
                    readWindowIdArg(args) !== undefined
                    ? readWindowIdArg(args)
                    : undefined,
                );
          // The effect is final here: the delivered verdict rode the result
          // for dispatch-capable backends, and anything else is the honest
          // "the backend accepted it" answer `dispatched-unknown` exists to
          // carry. Written before the setup read so a hung permission probe
          // cannot lose a record of input already sent.
          resultWindowId = computerAuditResultWindowId(value);
          audit({ effect: computerAuditSuccessEffect(name, value) });
          record({
            effect: computerAuditSuccessEffect(name, value),
            // The one read-back payload a session summarizes: the clipboard
            // text stays out either way — `result` is chars + hash.
            ...(name === "computer_read_clipboard" &&
            typeof (value as { value?: unknown } | null | undefined)?.value === "string"
              ? { resultValue: (value as { value: string }).value }
              : {}),
          });
          // A call can succeed and still report that the desktop is out of
          // reach: a perception read answers with a `permission-required`
          // availability, and a missing Screen Recording grant blocks nothing at
          // all yet leaves the agent blind. Both are the user's to fix, so both
          // take the same route to the same card as a thrown refusal.
          //
          // Awaited rather than remembered: the read costs a round trip only
          // when the last one saw a gap, and that is exactly the moment it must
          // not be answered from memory — the call after the user grants the
          // permission is the one that has to see it land.
          const signal = computerSetupSignal({
            availability: resultAvailability(value),
            missing: await manager.missingPermissions(),
            buildSignature: manager.buildSignature(),
          });
          let result: McpToolCallResult = isToolResult(value)
            ? withSetupNoteOnResult(value, signal)
            : mcpToolResultJson(withSetupNote(value, signal));
          // First mutation of a turn prepends the control disclosure: the
          // transcript must say Computer control is ON from the first input.
          if (computerToolRequiresApproval(name)) {
            const disclosureKey = `${context.callerThreadId}:${context.callerTurnId ?? "no-turn"}`;
            if (!disclosedFirstMutations.has(disclosureKey)) {
              disclosedFirstMutations.add(disclosureKey);
              result = withDisclosureOnResult(result, COMPUTER_CONTROL_FIRST_MUTATION_DISCLOSURE);
            }
          }
          return {
            // The note reaches both shapes. A plain object takes it as a field
            // on the payload; a result the handler already built — anything
            // carrying a screenshot — takes it in its text part.
            result,
            signal,
          };
        },
        catch: (error) => error,
      }).pipe(
        Effect.flatMap(({ result, signal }) => withSetupCard(name, context, signal, result)),
        Effect.catch((error) => {
          // The kill switch writes nothing: a disabled thread refusing input
          // is a state, not an event, and the log must stay empty for it. The
          // recording keeps the same rule — `recordComputerStep` also refuses
          // disabled threads at the manager seam.
          if (!(error instanceof ComputerBackendError && error.controlRevoked)) {
            audit(computerAuditErrorOutcome(error));
            record(computerAuditErrorOutcome(error));
          }
          const failure =
            error instanceof ComputerBackendError && error.inputPause
              ? {
                  ...mcpToolResultJson({
                    error: {
                      code: "computer_input_paused",
                      ...error.inputPause,
                      retryable: false,
                    },
                    ...(error instanceof CuaActionError
                      ? { effect: error.effect, retryAllowed: false }
                      : {}),
                  }),
                  isError: true,
                }
              : error instanceof CuaActionError
                ? {
                    ...mcpToolResultJson(cuaActionErrorPayload(error)),
                    isError: true,
                  }
                : error instanceof ComputerTargetError
                  ? targetErrorResult(error)
                  : error instanceof ComputerLeaseError
                    ? leaseErrorResult(error)
                    : mcpToolResultError(errorText(error));
          // A missing OS grant is the only failure a user has to act on, so it
          // is the only one that raises a card. Everything else — a target that
          // moved, an undelivered keystroke, arguments the desktop refused — is
          // the agent's to recover from and stays a plain tool error.
          return Effect.promise(() => manager.missingPermissions()).pipe(
            Effect.flatMap((missing) => {
              const signal = computerSetupSignal({
                error,
                missing,
                buildSignature: manager.buildSignature(),
              });
              // The failure path is where the note matters most and where it
              // used to be absent entirely: the model was handed the backend's
              // raw refusal with nothing telling it the user had been asked for
              // a grant, so it explained macOS privacy in prose or retried.
              return withSetupCard(name, context, signal, withSetupNoteOnResult(failure, signal));
            }),
          );
        }),
        Effect.map((result) => withGuidanceOnResult(result, guidance)),
      );
    };

  const actionEntry = (
    name: string,
    title: string,
    description: string,
    inputSchema: Record<string, unknown>,
    run: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>,
    /**
     * Overrides the write annotations for an action that is not one. Only the
     * hover uses it: it posts mouse movement, presses nothing, and never aims the
     * keyboard, so `destructiveHint: true` was telling every provider to treat
     * a look as a change.
     */
    annotations: Record<string, unknown> = WRITE_TOOL_ANNOTATIONS,
  ): ToolEntry => ({
    requiredCapability: COMPUTER_CONTROL_CAPABILITY,
    requiresActiveTurn: true,
    definition: {
      name,
      description,
      inputSchema: {
        ...inputSchema,
        properties: {
          ...(inputSchema.properties as Record<string, unknown>),
          delivery_mode: {
            type: "string",
            enum: ["background", "foreground"],
            description:
              "Defaults to background. Foreground may bring the exact target window forward within the active Computer task's consent, and the previously frontmost window is put back afterwards. Never use it to replay an uncertain action.",
          },
        },
      },
      annotations: { title, ...annotations },
    },
    handler: handle(name, run),
  });

  /**
   * One wording and one shape for a post-action observation, whoever captured
   * it: the generic path here, and the scroll path, which takes its own
   * before/after captures and hands the after one back already taken.
   * Observation is best-effort — the action already happened, so a perception
   * failure must not convert its success into an error result — and no
   * observation degrades to the plain JSON result.
   */
  const withObservation = (
    context: ToolContext,
    result: Record<string, unknown>,
    capture: ComputerActionObservation | undefined,
  ): unknown => {
    if (!capture) return result;
    if ("targetWindowClosed" in capture) {
      return {
        ...result,
        targetWindowClosed: true,
        note: "The window this action targeted no longer exists — the action likely closed it, so no post-action screenshot was taken. Use computer_list_windows or computer_get_state to see the desktop now.",
      };
    }
    const reused = frames.matchLatest(context.callerThreadId, capture.screenshot, capture.windowId);
    if (reused) {
      return {
        ...result,
        screenshotUnchanged: true,
        screenshotId: reused.id,
        screenshot: {
          screenshotId: reused.id,
          windowId: reused.windowId,
          region: reused.region,
          width: reused.width,
          height: reused.height,
          scale: reused.scale,
        },
        note: "The screen is byte-for-byte what your previous screenshot showed, with the same coordinates. Continue using this screenshotId. This does not prove the action missed; wait and look again before repeating an action.",
      };
    }
    return deliverScreenshot(context.callerThreadId, result, capture.screenshot, capture.windowId);
  };

  /**
   * The generic path: the action ran, now go and look at it. Reads
   * `include_screenshot` itself, because an action that took no observation
   * must not pay for one here either.
   */
  const observeAfterAction = async (
    args: Record<string, unknown>,
    result: ComputerActionResult,
    context: ToolContext,
  ): Promise<unknown> => {
    if (readBooleanArg(args, "include_screenshot") === false) return result;
    const label = readVerbatimStringArg(args, "wait_for_label");
    const windowId = result.windowId;
    const readiness =
      label === undefined
        ? undefined
        : windowId === undefined
          ? { status: "unavailable", waitedMs: 0 }
          : await waitForControl(
              () => manager.getState({ includeTree: true, windowId }),
              { label, windowId },
              2_000,
              desktopOperationSignal(),
            ).catch((error: unknown) => {
              // Input already happened. A failed observation must not imply it is
              // safe to send that input again; cancellation still stops the turn.
              assertDesktopOperationActive();
              return { status: "unavailable", note: errorText(error) };
            });
    // The clamped point when the display server moved the pointer, because the
    // window under where the action actually landed is the one it affected.
    return withObservation(
      context,
      readiness === undefined ? result : { ...result, readiness },
      await manager.captureActionScreenshot(
        result.windowId,
        result.clampedTo ?? result.point,
        context.callerThreadId,
        readiness === undefined,
      ),
    );
  };

  /**
   * An action whose visible outcome matters: every pointer, keyboard, and
   * semantic action goes through here so its result carries the screenshot.
   * Launching an app does not — its window appears seconds later, so a capture
   * taken now would only show the desktop from before the launch — and neither
   * does writing the clipboard, which changes nothing on screen.
   *
   * An action that already observed itself returns its own capture alongside
   * the result and is not photographed a second time: scrolling has to capture
   * before and after to measure its travel, and the after capture is the same
   * picture this would otherwise take.
   */
  const observedActionEntry = (
    name: string,
    title: string,
    description: string,
    inputSchema: Record<string, unknown>,
    run: (args: Record<string, unknown>, context: ToolContext) => Promise<ObservedActionOutcome>,
    annotations: Record<string, unknown> = WRITE_TOOL_ANNOTATIONS,
  ): ToolEntry =>
    actionEntry(
      name,
      title,
      `${description} ${ACTION_SCREENSHOT_HINT}`,
      withActionScreenshotSchema(inputSchema),
      async (args, context) => {
        if (args.wait_for_label !== undefined) {
          if (!readStringArg(args, "wait_for_label")?.trim())
            throw new Error("wait_for_label must be a nonempty label.");
          if (readBooleanArg(args, "include_screenshot") === false)
            throw new Error("wait_for_label requires the action screenshot.");
        }
        const outcome = await run(args, context);
        return "result" in outcome && args.wait_for_label === undefined
          ? withObservation(context, outcome.result, outcome.observation)
          : observeAfterAction(args, "result" in outcome ? outcome.result : outcome, context);
      },
      annotations,
    );

  const dialect = manager.agentDialect;
  const overviewScope =
    dialect === "macos"
      ? "the primary display, or the exact window when window_id is supplied"
      : "the desktop workspace across all monitors";
  const captureTargetNote =
    dialect === "macos"
      ? 'Capture an exact window by "window_id" from computer_list_windows. Rectangular region capture is unavailable on this backend. With no arguments it captures the selected or focused window.'
      : 'With no arguments it captures the window that currently has focus. Otherwise capture a single window by "window_id" from computer_list_windows, or a rectangle given as "x", "y", "width" and "height" in pixels of the screenshot you are zooming into (the most recent one, or the one named by screenshot_id); never pass both forms. Region capture is clipped to the desktop workspace.';
  const pointerTargetProperties = targetProperties();
  const keyboardTargetProperties = keyboardTargetProperty();
  const textTargetProperties = textTargetProperty();

  const targetSchema = {
    type: "object",
    properties: pointerTargetProperties,
    additionalProperties: false,
  } as const;

  /** A pointer target that may also hold modifiers across the gesture. */
  const modifiedTargetSchema = {
    type: "object",
    properties: { ...pointerTargetProperties, ...MODIFIERS_PROPERTY },
    additionalProperties: false,
  } as const;

  /** One click family, four click counts, one description shape. */
  const clickEntry = (
    name: string,
    title: string,
    lead: string,
    run: (
      threadId: string,
      target: ComputerTarget,
      modifiers: readonly ComputerInputModifier[],
    ) => Promise<ComputerActionResult>,
  ): ToolEntry =>
    observedActionEntry(
      name,
      title,
      `${lead} ${SEMANTIC_TARGETING_NOTE} ${POINTER_COORDINATE_HINT}`,
      modifiedTargetSchema,
      async (args, context) =>
        run(context.callerThreadId, readTarget(args, context), readModifiers(args)),
    );

  /**
   * The fields one `computer_run` step type accepts. Listed exhaustively so a
   * mistyped field is refused at parse time instead of silently ignored — a
   * step that drops the field the model meant is a step that does the wrong
   * thing. Camel-case aliases are admitted because the argument readers accept
   * them everywhere else.
   */
  const RUN_TARGET_FIELDS = [
    "x",
    "y",
    "screenshot_id",
    "screenshotId",
    "label",
    "role",
    "ref",
    "ref_ordinal",
    "refOrdinal",
    "window_id",
    "windowId",
  ] as const;
  const RUN_STEP_FIELDS: Record<string, readonly string[]> = {
    click: [...RUN_TARGET_FIELDS, "modifiers"],
    double_click: [...RUN_TARGET_FIELDS, "modifiers"],
    triple_click: [...RUN_TARGET_FIELDS, "modifiers"],
    right_click: [...RUN_TARGET_FIELDS, "modifiers"],
    move_cursor: RUN_TARGET_FIELDS,
    drag: ["from", "to", "duration_ms"],
    scroll: [...RUN_TARGET_FIELDS, "delta_x", "delta_y", "modifiers"],
    type_text: [
      "text",
      "label",
      "role",
      "ref",
      "ref_ordinal",
      "refOrdinal",
      "window_id",
      "windowId",
    ],
    press_key: ["key", "window_id", "windowId"],
    hotkey: ["keys", "window_id", "windowId"],
    set_value: [...RUN_TARGET_FIELDS, "value"],
    perform_action: [...RUN_TARGET_FIELDS, "action"],
    // Semantic-only like its standalone tool: a range cannot be aimed at a
    // pixel, so x/y/screenshot_id are not accepted fields.
    select_text: [
      "label",
      "role",
      "ref",
      "ref_ordinal",
      "refOrdinal",
      "window_id",
      "windowId",
      "start",
      "length",
    ],
    wait: [
      "duration_ms",
      "label",
      "role",
      "ref",
      "ref_ordinal",
      "refOrdinal",
      "window_id",
      "windowId",
      "absent",
    ],
    activate_window: ["window_id", "windowId"],
    launch_app: ["app", "arguments", "wait_for_window", "hidden"],
    write_clipboard: ["text"],
    paste: ["text", "window_id", "windowId"],
    set_window_frame: ["window_id", "windowId", "x", "y", "width", "height"],
    invoke_menu: ["window_id", "windowId", "path"],
    kill_app: ["window_id", "windowId"],
    set_window_minimized: ["window_id", "windowId", "minimized"],
    set_app_visibility: ["pid", "hidden"],
    get_state: ["window_id", "windowId", "label_contains", "labelContains"],
    verify_state: ["window_id", "windowId", "expect"],
  };

  /**
   * Fields every step type accepts on top of its own: element conditions
   * evaluated against live state at the moment the step would run, and the
   * per-step failure policy.
   */
  const RUN_CONDITION_FIELDS = ["if_element", "unless_element", "continue_on_error"] as const;

  interface PreparedRunStep {
    readonly type: string;
    /** The step object as declared — the inner record's redaction input. */
    readonly step: Record<string, unknown>;
    readonly ifElement: ComputerTarget | undefined;
    readonly unlessElement: ComputerTarget | undefined;
    readonly continueOnError: boolean;
    readonly run: () => Promise<unknown>;
  }

  /**
   * Parse one step into a ready-to-call closure. Every argument reader runs
   * now — including coordinate resolution against the frame registry — so a
   * malformed batch is refused whole, before step zero dispatches anything.
   * What stays deferred is what must stay fresh: semantic targets resolve
   * against live state inside each manager call, at the moment that step runs.
   */
  const prepareRunStep = (
    type: string,
    step: Record<string, unknown>,
    context: ToolContext,
  ): (() => Promise<unknown>) => {
    const threadId = context.callerThreadId;
    switch (type) {
      case "click":
      case "double_click":
      case "triple_click":
      case "right_click": {
        const target = readTarget(step, context);
        const modifiers = readModifiers(step);
        const method = {
          click: manager.click,
          double_click: manager.doubleClick,
          triple_click: manager.tripleClick,
          right_click: manager.rightClick,
        }[type];
        return () => method.call(manager, threadId, target, modifiers);
      }
      case "move_cursor": {
        const target = readTarget(step, context);
        return () => manager.moveCursor(threadId, target);
      }
      case "drag": {
        const from = readNestedTarget(step, "from", context);
        const to = readNestedTarget(step, "to", context);
        const durationMs = readDragDurationMs(step);
        return () => manager.drag(threadId, from, to, durationMs);
      }
      case "scroll": {
        // The same frame mapping and half-window limit the standalone tool
        // applies, minus its unchanged-scroll streak: a batch step observes
        // nothing, so there is no travel to measure the streak from.
        const raw = readScreenshotTarget(step);
        const frame = frames.resolve(threadId, raw.screenshotId);
        const resolved = resolveTarget(raw, threadId);
        const target =
          !hasTargetFields(resolved) && frame.windowId !== undefined
            ? { ...resolved, windowId: frame.windowId }
            : resolved;
        const delta = screenshotDeltaToDesktop(
          frame,
          readDelta(step, "delta_x"),
          readDelta(step, "delta_y"),
        );
        const limited = {
          deltaX:
            Math.sign(delta.deltaX) * Math.min(Math.abs(delta.deltaX), frame.region.width / 2),
          deltaY:
            Math.sign(delta.deltaY) * Math.min(Math.abs(delta.deltaY), frame.region.height / 2),
        };
        const modifiers = readModifiers(step);
        return async () => {
          const outcome = await manager.scrollCalibrated(
            threadId,
            hasTargetFields(target) ? target : null,
            limited.deltaX,
            limited.deltaY,
            { observe: false, ...(modifiers.length > 0 ? { modifiers } : {}) },
          );
          if (
            outcome.result.scroll &&
            (limited.deltaX !== delta.deltaX || limited.deltaY !== delta.deltaY)
          ) {
            return {
              ...outcome.result,
              scroll: {
                ...outcome.result.scroll,
                requested: delta,
                limitedTo: limited,
              },
            };
          }
          return outcome.result;
        };
      }
      case "type_text": {
        const text = readRequiredText(step);
        const target = readTarget(step, context);
        return () =>
          target.label !== undefined || target.role !== undefined
            ? manager.typeTextAt(threadId, text, target)
            : manager.typeText(threadId, text, target.windowId);
      }
      case "press_key": {
        const key = readStringArg(step, "key", { required: true })!;
        const windowId = readWindowIdArg(step);
        return () => manager.pressKey(threadId, key, windowId);
      }
      case "hotkey": {
        const keys = readHotkeyKeys(step);
        const windowId = readWindowIdArg(step);
        return () => manager.hotkey(threadId, keys, windowId);
      }
      case "set_value": {
        const target = readTarget(step, context);
        const value = readSetValueValue(step);
        return () => manager.setValue(threadId, target, value);
      }
      case "perform_action": {
        const target = readTarget(step, context);
        const action = readActionName(step);
        return () => manager.performAction(threadId, target, action);
      }
      case "select_text": {
        const target = resolveTarget(readSelectTextTarget(step), threadId);
        const range = readSelectTextRange(step);
        return () => manager.selectText(threadId, target, range);
      }
      case "wait": {
        const durationMs = readWaitDurationMs(step);
        const absent = readBooleanArg(step, "absent") === true;
        const raw = readScreenshotTarget(step);
        const target =
          raw.ref !== undefined ||
          raw.label !== undefined ||
          raw.role !== undefined ||
          raw.refOrdinal !== undefined
            ? resolveTarget(raw, threadId)
            : undefined;
        if (target !== undefined) {
          if (target.label === undefined || !target.label.trim()) {
            throw new ToolInputError(
              'A "wait" step with an element target requires a nonempty label or a ref.',
            );
          }
          return () =>
            waitForControl(
              () =>
                manager.getState({
                  includeTree: true,
                  ...(target.windowId !== undefined ? { windowId: target.windowId } : {}),
                }),
              target,
              durationMs,
              desktopOperationSignal(),
              { absent },
            );
        }
        if (absent) {
          throw new ToolInputError('A "wait" step with "absent" requires an element target.');
        }
        return async () => {
          if (durationMs > 0)
            await waitForComputer(durationMs, undefined, {
              signal: desktopOperationSignal(),
            });
          return { waitedMs: durationMs };
        };
      }
      case "activate_window": {
        const windowId = readWindowIdArg(step);
        if (windowId === undefined) {
          throw new ToolInputError('Step "activate_window" requires "window_id".');
        }
        // Foreground promotion is scoped to this one step: the rest of the
        // run keeps the batch's delivery mode.
        return () =>
          withDesktopDeliveryMode("foreground", () =>
            manager.foregroundWithRestore(threadId, windowId),
          );
      }
      case "launch_app": {
        const app = readStringArg(step, "app", { required: true })!;
        const appArgs = readStringArrayArg(step, "arguments") ?? [];
        const waitMs = readBooleanArg(step, "wait_for_window") === false ? 0 : 2_000;
        // Three states: absent lets the manager's invisible-by-default apply,
        // explicit false is the only way to ask for a visible launch.
        const hidden = readBooleanArg(step, "hidden");
        return () =>
          manager.launchApp(
            threadId,
            app,
            appArgs,
            waitMs,
            hidden !== undefined ? { hidden } : undefined,
          );
      }
      case "write_clipboard": {
        const text = readClipboardText(step);
        return () => manager.writeClipboard(threadId, text);
      }
      case "paste": {
        const text = readClipboardText(step);
        const windowId = readWindowIdArg(step);
        return () => manager.paste(threadId, text, windowId);
      }
      case "set_window_frame": {
        const windowId = readWindowIdArg(step);
        if (!windowId) throw new ToolInputError('Step "set_window_frame" requires "window_id".');
        const frame = {
          x: readDelta(step, "x"),
          y: readDelta(step, "y"),
          width: readDelta(step, "width"),
          height: readDelta(step, "height"),
        };
        if (!Object.values(frame).every(Number.isFinite) || frame.width <= 0 || frame.height <= 0)
          throw new ToolInputError(
            'Step "set_window_frame" needs finite geometry and positive width/height.',
          );
        return () => manager.setWindowFrame(threadId, windowId, frame);
      }
      case "invoke_menu": {
        const windowId = readWindowIdArg(step);
        if (!windowId) throw new ToolInputError('Step "invoke_menu" requires "window_id".');
        const path = readStringArrayArg(step, "path");
        if (!path?.length || path.length > 6 || path.some((title) => title.trim().length === 0))
          throw new ToolInputError('Step "invoke_menu" needs a path of one to six titles.');
        return () => manager.invokeMenu(threadId, windowId, path);
      }
      case "kill_app": {
        const windowId = readWindowIdArg(step);
        if (!windowId) throw new ToolInputError('Step "kill_app" requires "window_id".');
        return () => manager.killApp(threadId, windowId);
      }
      case "set_window_minimized": {
        const windowId = readWindowIdArg(step);
        if (!windowId) {
          throw new ToolInputError('Step "set_window_minimized" requires "window_id".');
        }
        const minimized = readBooleanArg(step, "minimized");
        if (minimized === undefined) {
          throw new ToolInputError('Step "set_window_minimized" requires a boolean "minimized".');
        }
        return () => manager.setWindowMinimized(threadId, windowId, minimized);
      }
      case "set_app_visibility": {
        const pid = readNumberArg(step, "pid");
        if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
          throw new ToolInputError('Step "set_app_visibility" requires a positive integer "pid".');
        }
        const hidden = readBooleanArg(step, "hidden");
        if (hidden === undefined) {
          throw new ToolInputError('Step "set_app_visibility" requires a boolean "hidden".');
        }
        return () => manager.setAppVisibility(threadId, pid, hidden);
      }
      case "get_state": {
        const windowId = readWindowIdArg(step);
        const labelContains =
          readVerbatimStringArg(step, "label_contains") ??
          readVerbatimStringArg(step, "labelContains");
        // A mid-run observation: it re-baselines the scope's diff, mints the
        // elements' refs for later steps and the model's next calls, and
        // reports the listing back in the step's own result.
        return async () => {
          const state = await manager.getState({
            includeTree: true,
            ...(windowId ? { windowId } : {}),
          });
          const elements = state.root
            ? actionableElements(state.root, {
                ...(windowId === undefined ? {} : { windowId }),
                ...(labelContains === undefined ? {} : { labelContains }),
              })
            : undefined;
          const stable =
            elements === undefined
              ? undefined
              : rememberDigest(
                  threadId,
                  digestScopeKey(threadId, windowId, labelContains),
                  elements,
                );
          return {
            ...(windowId !== undefined ? { windowId } : {}),
            elements: stable?.items ?? [],
            // An empty listing with an unreadable tree must not look like
            // "nothing on screen" — carry the read's own status with it.
            ...(state.accessibility !== undefined
              ? { accessibility: state.accessibility }
              : {}),
            ...(stable?.sourceIncomplete ? { elementsSourceIncomplete: true } : {}),
            ...(stable !== undefined && !stable.complete
              ? { elementsTruncated: true, elementsOmitted: stable.omitted }
              : {}),
          };
        };
      }
      case "verify_state": {
        const windowId = readWindowIdArg(step);
        if (!windowId) throw new ToolInputError('Step "verify_state" requires "window_id".');
        const raw = step.expect;
        if (
          !Array.isArray(raw) ||
          raw.length === 0 ||
          raw.length > 8 ||
          !raw.every((entry) => typeof entry === "object" && entry !== null)
        ) {
          throw new ToolInputError(
            'Step "verify_state" needs "expect" as an array of one to eight predicates.',
          );
        }
        const expect = raw as Record<string, unknown>[];
        return () => manager.verifyState(windowId, expect);
      }
      default:
        throw new ToolInputError(`Unknown run step type ${JSON.stringify(type)}.`);
    }
  };

  /**
   * An `if_element`/`unless_element` clause: a target object carrying the
   * same fields an action step does — label, role, ref, window_id. A ref is
   * bound to its listed identity at parse time, so the check asks about the
   * element the model meant, not whatever its ref happens to point at later.
   * Only a label-carrying target is a usable condition: a bare window or
   * role matches everything, which is no condition at all.
   */
  const readStepElementCondition = (
    step: Record<string, unknown>,
    name: string,
    threadId: string,
  ): ComputerTarget | undefined => {
    const value = readRecordArg(step, name);
    if (value === undefined) return undefined;
    const target = resolveTarget(readScreenshotTarget(value), threadId);
    if (target.label === undefined) {
      throw new ToolInputError(`"${name}" needs a label, or a ref whose element has one.`);
    }
    return target;
  };

  /**
   * Live presence of a condition element at the moment the step would run:
   * one fresh tree read, resolved the same way an action would resolve it.
   * "Present" means an action could reach it now: a resolvable on-screen
   * match, or ambiguous candidates — several hits still prove the element
   * is there, whichever one it is. An off-screen-only match counts as
   * absent (a step gated on it could not act anyway), as does a missing or
   * unreadable tree — no guesses.
   */
  const elementConditionPresent = async (target: ComputerTarget): Promise<boolean> => {
    const state = await manager.getState({
      includeTree: true,
      ...(target.windowId !== undefined ? { windowId: target.windowId } : {}),
    });
    if (
      !state.root ||
      state.accessibility?.status === "unavailable" ||
      (target.windowId !== undefined &&
        state.accessibility?.unavailableWindowIds?.includes(target.windowId))
    ) {
      return false;
    }
    try {
      resolveComputerSemanticTarget(state.root, target);
      return true;
    } catch (error) {
      if (!(error instanceof ComputerTargetError)) throw error;
      return error.code === "computer_target_ambiguous";
    }
  };

  /**
   * The error one failed step reports. Same taxonomy the outer handler maps
   * to whole-call results, kept compact: the batch result is data, and the
   * step's failure is one entry in it.
   */
  const runStepError = (error: unknown): Record<string, unknown> =>
    error instanceof ComputerBackendError && error.inputPause
      ? {
          code: "computer_input_paused",
          ...error.inputPause,
          ...(error instanceof CuaActionError ? { effect: error.effect } : {}),
        }
      : error instanceof CuaActionError
        ? {
            code: error.code,
            effect: error.effect,
            message: error.message,
            retryAllowed: false,
          }
        : error instanceof ComputerTargetError
          ? {
              code: error.code,
              message: error.message,
              notFound: error.notFound,
              candidates: error.candidates,
            }
          : error instanceof ComputerLeaseError
            ? {
                code: error.code,
                message: error.message,
                retryable: error.retryable,
              }
            : error instanceof ToolInputError
              ? { code: "invalid_step", message: error.message }
              : {
                  code: "step_failed",
                  message: errorText(error),
                  ...(error instanceof ComputerBackendError && error.retryable
                    ? { retryable: true }
                    : {}),
                };

  const runComputerBatch = async (
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<unknown> => {
    const threadId = context.callerThreadId;
    const rawSteps = args.steps;
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
      throw new ToolInputError('"steps" must be a nonempty array of step objects.');
    }
    if (rawSteps.length > COMPUTER_RUN_MAX_STEPS) {
      throw new ToolInputError(
        `"steps" accepts at most ${COMPUTER_RUN_MAX_STEPS} steps; got ${rawSteps.length}. Split the sequence into multiple computer_run calls.`,
      );
    }
    // Validate everything before anything dispatches: a batch that cannot
    // parse is refused whole rather than running its good half.
    const prepared: PreparedRunStep[] = rawSteps.map((entry, index) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new ToolInputError(`Step ${index} must be an object with a "type" field.`);
      }
      const step = entry as Record<string, unknown>;
      const type = readStringArg(step, "type");
      const fields = type === undefined ? undefined : RUN_STEP_FIELDS[type];
      if (type === undefined || fields === undefined) {
        throw new ToolInputError(
          `Step ${index}: "type" must be one of ${Object.keys(RUN_STEP_FIELDS).join(", ")}.`,
        );
      }
      const unknown = Object.keys(step).filter(
        (key) =>
          key !== "type" &&
          !fields.includes(key) &&
          !(RUN_CONDITION_FIELDS as readonly string[]).includes(key),
      );
      if (unknown.length > 0) {
        throw new ToolInputError(
          `Step ${index} (${type}): unknown field ${unknown
            .map((key) => JSON.stringify(key))
            .join(", ")}.`,
        );
      }
      return {
        type,
        step,
        ifElement: readStepElementCondition(step, "if_element", threadId),
        unlessElement: readStepElementCondition(step, "unless_element", threadId),
        continueOnError: readBooleanArg(step, "continue_on_error") === true,
        run: prepareRunStep(type, step, context),
      };
    });

    const steps: Record<string, unknown>[] = [];
    let stopped = false;
    // The window the last step touched scopes the closing state read.
    let lastWindowId: string | undefined;
    // A run inside an open session records one step line per inner step, each
    // with its own capture — the outer call's record stays the container. The
    // approval the batch ran under is inherited verbatim: reaching this point
    // means the run was granted, or ran on the trusted baseline.
    const runApproval: ComputerRecordingApproval = {
      required: true,
      decision: options.authorizeAction === undefined ? "skipped" : "granted",
    };
    const recordRunStep = (
      preparedStep: PreparedRunStep,
      stepCapture: ComputerRecordingCapture | undefined,
      outcome: { readonly effect: ComputerRecordingStepInput["effect"]; readonly code?: string },
      startedAt: number,
    ): void =>
      writeSessionStep({
        threadId,
        turnId: context.callerTurnId,
        tool: `computer_${preparedStep.type}`,
        args: preparedStep.step,
        approval: runApproval,
        capture: stepCapture,
        outcome,
        startedAt,
      });
    for (const [index, preparedStep] of prepared.entries()) {
      // Between steps, not just around the batch: a revocation or a dead turn
      // stops the run before the next dispatch, not after it.
      assertDesktopOperationActive();
      await Effect.runPromise(context.assertCallerTurnActive(), {
        signal: desktopOperationSignal(),
      });
      const stepCapture = manager.recordingCaptureFor(threadId);
      const stepStartedAt = Date.now();
      // Element conditions evaluate against live state at the moment the step
      // would run — the answer a get_state gave ten steps ago is not it.
      const skippedReason = await (async (): Promise<string | undefined> => {
        if (
          preparedStep.ifElement !== undefined &&
          !(await elementConditionPresent(preparedStep.ifElement))
        ) {
          return "if_element_absent";
        }
        if (
          preparedStep.unlessElement !== undefined &&
          (await elementConditionPresent(preparedStep.unlessElement))
        ) {
          return "unless_element_present";
        }
        return undefined;
      })();
      if (skippedReason !== undefined) {
        recordRunStep(preparedStep, stepCapture, { effect: "not-dispatched" }, stepStartedAt);
        steps.push({
          step: index,
          type: preparedStep.type,
          ok: true,
          skipped: true,
          skippedReason,
        });
        continue;
      }
      try {
        const value = await manager.cursorActivity.during(
          threadId,
          cursorToolActivity(`computer_${preparedStep.type}`),
          () => withComputerRecordingCapture(stepCapture, preparedStep.run),
        );
        if (
          typeof value === "object" &&
          value !== null &&
          typeof (value as { windowId?: unknown }).windowId === "string"
        ) {
          lastWindowId = (value as { windowId: string }).windowId;
        }
        // A wait dispatched nothing; a step whose capture holds no dispatch
        // did not reach the backend either — the same honesty rule the outer
        // record keeps.
        const stepEffect = computerAuditSuccessEffect(`computer_${preparedStep.type}`, value);
        recordRunStep(
          preparedStep,
          stepCapture,
          {
            effect:
              preparedStep.type === "wait" ||
              (stepEffect === "dispatched-unknown" && (stepCapture?.dispatches.length ?? 0) === 0)
                ? "not-dispatched"
                : stepEffect,
          },
          stepStartedAt,
        );
        steps.push({
          step: index,
          type: preparedStep.type,
          ok: true,
          result:
            typeof value === "object" && value !== null
              ? (({ computerId: _omitted, ...rest }) => rest)(value as Record<string, unknown>)
              : value,
        });
      } catch (error) {
        // A cancelled desktop operation or dead turn is the call ending, not a
        // step failing: propagate it rather than file it as batch data.
        desktopOperationSignal()?.throwIfAborted();
        await Effect.runPromise(context.assertCallerTurnActive(), {
          signal: desktopOperationSignal(),
        });
        recordRunStep(preparedStep, stepCapture, computerAuditErrorOutcome(error), stepStartedAt);
        steps.push({
          step: index,
          type: preparedStep.type,
          ok: false,
          error: runStepError(error),
        });
        if (!preparedStep.continueOnError) {
          stopped = true;
          break;
        }
      }
    }

    // The closing read is the batch's own observation: it satisfies a pending
    // observation requirement (this call runs under withModelDesktopObservation),
    // re-baselines the thread's diff scope, and reports the state the run left
    // behind. It is best-effort — the steps already ran, so a read failure is
    // reported beside them rather than converting a finished run into an error.
    const stateFields = await (async (): Promise<Record<string, unknown>> => {
      try {
        const state = await manager.getState({
          includeTree: true,
          ...(lastWindowId ? { windowId: lastWindowId } : {}),
        });
        const { text: _text, root, screenshot: _screenshot, ...rest } = state;
        const elements = root
          ? actionableElements(root, lastWindowId === undefined ? {} : { windowId: lastWindowId })
          : undefined;
        const stable =
          elements === undefined
            ? undefined
            : rememberDigest(threadId, digestScopeKey(threadId, lastWindowId, undefined), elements);
        return {
          state: {
            ...rest,
            ...(stable
              ? {
                  elements: stable.items,
                  ...(stable.sourceIncomplete ? { elementsSourceIncomplete: true } : {}),
                  ...(stable.complete
                    ? {}
                    : {
                        elementsTruncated: true,
                        elementsOmitted: stable.omitted,
                      }),
                }
              : {}),
          },
        };
      } catch (error) {
        desktopOperationSignal()?.throwIfAborted();
        return { stateError: errorText(error) };
      }
    })();

    const skippedCount = steps.filter((entry) => entry.skipped === true).length;
    const payload: Record<string, unknown> = {
      computerId: manager.computerId,
      steps,
      // A skipped step satisfied its condition check, not its action — count
      // it apart so "completed" keeps meaning "actually ran".
      completed: steps.filter((entry) => entry.ok === true && entry.skipped !== true).length,
      ...(skippedCount > 0 ? { skipped: skippedCount } : {}),
      stopped,
      ...stateFields,
    };
    if (readBooleanArg(args, "include_screenshot") !== true) return payload;
    try {
      const screenshot =
        lastWindowId === undefined
          ? (await manager.captureFocusedWindow(COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION))
              .screenshot
          : await manager.captureScreenshot({
              kind: "window",
              windowId: lastWindowId,
              maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
            });
      return deliverScreenshot(threadId, payload, screenshot, lastWindowId);
    } catch (error) {
      desktopOperationSignal()?.throwIfAborted();
      return { ...payload, screenshotError: errorText(error) };
    }
  };

  return [
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_list_windows",
        description: `List windows topmost-first with bounds, stackingIndex and occludedBy. Use app to avoid returning unrelated windows. Pass window_id to scope input; selection does not activate it. ${WINDOW_FOCUS_NOTE} Use computer_activate_window within task consent when needed; never replay uncertain input.${windowListCompletenessNote(dialect)}`,
        inputSchema: {
          type: "object",
          properties: {
            app: {
              type: "string",
              description: "Filter by exact appName, ignoring case.",
            },
          },
          additionalProperties: false,
        },
        annotations: {
          title: "List computer windows",
          ...READ_ONLY_TOOL_ANNOTATIONS,
        },
      },
      handler: handle("computer_list_windows", async (args) => {
        const app = readStringArg(args, "app")?.toLocaleLowerCase();
        const result = await manager.listWindows();
        return app
          ? {
              ...result,
              windows: result.windows.filter(
                (window) => window.appName?.toLocaleLowerCase() === app,
              ),
            }
          : result;
      }),
    },
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_get_state",
        description: `Read labeled controls and values before acting; prefer label targeting. ${WINDOW_FOCUS_NOTE} By default returns elements without an image or duplicate text. Each element carries a stable ref you can pass as the ref argument on later actions — cheaper than re-quoting label and role, names duplicates a label cannot, and stays bound to the same element while it is present. window_id scopes inspection; include_screenshot adds ${overviewScope} (or the selected window). ${SCREENSHOT_FRAME_NOTE} include_text adds full AX text only when elements are insufficient. Use window_id or label_contains to narrow a truncated result; elementsTruncated/elementsOmitted report the remainder.`,
        inputSchema: {
          type: "object",
          properties: {
            include_screenshot: {
              type: "boolean",
              description: `Attach a downscaled screenshot of ${overviewScope}. Defaults to false. Pass true when you need a frame to point x/y into, or when the labels are not enough to tell you what is on screen.`,
            },
            include_text: {
              type: "boolean",
              description:
                "Attach the whole accessibility tree rendered as text, on top of the elements list. Defaults to false; it is large, so ask only when the elements list is not enough.",
            },
            window_id: {
              type: "string",
              description:
                dialect === "macos"
                  ? "Select this exact window for accessibility inspection and any requested screenshot. Without window_id, Cua returns window metadata but no application accessibility tree."
                  : "Restrict the elements list to controls in this window (from computer_list_windows). The windows, screen size and screenshot are unaffected.",
            },
            label_contains: {
              type: "string",
              description:
                "Restrict the elements list to controls whose label contains this text, case-insensitively. Use it when the list came back truncated, or to check whether one particular control is on screen.",
            },
            diff: {
              type: "boolean",
              description:
                "Return only what changed since your last state read in this scope (same window_id and label_contains): elementChanges with added, removed and changed entries instead of the full elements list. The first read in a scope reports every element as added. Position-only changes are not reported — use a screenshot when layout is the question.",
            },
          },
          additionalProperties: false,
        },
        annotations: {
          title: "Get computer state",
          ...READ_ONLY_TOOL_ANNOTATIONS,
        },
      },
      handler: handle("computer_get_state", async (args, context) => {
        // One perception read feeds both renderings: the elements digest always
        // rides (that is what makes labels discoverable), while the full
        // accessibility text rendering stays opt-in for its payload size — and
        // is now only *rendered* when asked for, rather than rendered on every
        // read and discarded here.
        const wantText = readBooleanArg(args, "include_text") ?? false;
        const windowId = readWindowIdArg(args);
        const labelContains =
          readVerbatimStringArg(args, "label_contains") ??
          readVerbatimStringArg(args, "labelContains");
        const wantDiff = readBooleanArg(args, "diff") ?? false;
        const state = await manager.getState({
          includeScreenshot: readBooleanArg(args, "include_screenshot") ?? false,
          includeText: wantText,
          includeTree: true,
          ...(windowId ? { windowId } : {}),
        });
        const { text, root, screenshot, ...rest } = state;
        const elements = root
          ? actionableElements(root, {
              ...(windowId === undefined ? {} : { windowId }),
              ...(labelContains === undefined ? {} : { labelContains }),
            })
          : undefined;
        // The baseline moves on every successful digest, diff or not: the
        // comparison is always against what this thread last saw in the scope.
        const digestKey = digestScopeKey(context.callerThreadId, windowId, labelContains);
        const before = elementDigests.get(digestKey);
        const stable =
          elements === undefined
            ? undefined
            : rememberDigest(context.callerThreadId, digestKey, elements);
        const appHint = (() => {
          if (windowId === undefined) return undefined;
          const appName = rest.windows
            .find((window) => window.id === windowId)
            ?.appName?.toLowerCase();
          const note = appName === undefined ? undefined : APP_GUIDANCE[appName];
          const seenKey = JSON.stringify([context.callerThreadId, appName]);
          if (note === undefined || appHintsSeen.has(seenKey)) return undefined;
          // Thread-keyed, never purged on thread end — bounded like the
          // digests; eviction only re-shows a hint a stale entry suppressed.
          while (appHintsSeen.size >= 256) appHintsSeen.delete(appHintsSeen.keys().next().value!);
          appHintsSeen.add(seenKey);
          return note;
        })();
        const payload = {
          ...rest,
          ...(wantText && text !== undefined ? { text } : {}),
          ...(stable
            ? wantDiff
              ? {
                  elementChanges: (() => {
                    const changes = diffActionableElements(before?.items ?? [], stable.items);
                    return {
                      ...changes,
                      // A removed entry's ref is a dead handle — the element
                      // is gone — so showing it would make it look citable.
                      removed: changes.removed.map(({ ref: _ref, ...entry }) => entry),
                    };
                  })(),
                  // Either side reporting less than the full tree makes the
                  // diff itself partial — removals beyond a cap are invisible.
                  ...((before !== undefined && !before.complete) || !stable.complete
                    ? { elementChangesIncomplete: true }
                    : {}),
                }
              : {
                  elements: stable.items,
                  ...(stable.sourceIncomplete ? { elementsSourceIncomplete: true } : {}),
                  // Both halves together: "there is more" is only actionable
                  // alongside how much more, which is what decides between
                  // looking again and narrowing the query.
                  ...(stable.complete
                    ? {}
                    : {
                        elementsTruncated: true,
                        elementsOmitted: stable.omitted,
                      }),
                }
            : {}),
          ...(appHint !== undefined ? { appHint } : {}),
        };
        if (!screenshot) return mcpToolResultJson(payload);
        return deliverScreenshot(context.callerThreadId, payload, screenshot);
      }),
    },
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_screenshot",
        description: `Zoom into one part of the desktop when detail is too small to read in a screenshot you have. ${captureTargetNote} ${SCREENSHOT_FRAME_NOTE} A window the desktop cannot photograph honestly — one that is not on screen, or whose position cannot be measured — is refused rather than answered with pixels it cannot place; capture what is visible, or bring the window forward first with computer_activate_window if the user wants it on screen.`,
        inputSchema: {
          type: "object",
          properties: {
            window_id: {
              type: "string",
              description:
                dialect === "macos"
                  ? "Exact window id from computer_list_windows. Omit to capture the selected or focused window."
                  : "Window id from computer_list_windows. Mutually exclusive with x/y/width/height. Omit both forms to capture the focused window.",
            },
            ...(dialect === "macos"
              ? {}
              : {
                  x: {
                    type: "number",
                    description:
                      "Region left edge, in pixels of the screenshot being zoomed into (the most recent one, or the one named by screenshot_id).",
                  },
                  y: {
                    type: "number",
                    description: "Region top edge, in pixels of the same screenshot.",
                  },
                  width: {
                    type: "number",
                    description: "Region width in pixels of the same screenshot.",
                  },
                  height: {
                    type: "number",
                    description: "Region height in pixels of the same screenshot.",
                  },
                  ...SCREENSHOT_ID_PROPERTY,
                }),
            max_dimension: {
              type: "integer",
              minimum: 1,
              maximum: DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION,
              description: `Longest screenshot side in pixels before downscaling. Defaults to and is capped at ${DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION}, which is the largest image that reaches you unaltered — ask for more and the picture you see would no longer be the picture your coordinates are mapped against. ${dialect === "macos" ? "Use computer_get_state with window_id and include_text for accessible text that is too small to read." : "To read finer detail, capture a smaller region rather than a bigger image."}`,
            },
          },
          additionalProperties: false,
        },
        annotations: {
          title: "Capture computer screenshot",
          ...READ_ONLY_TOOL_ANNOTATIONS,
        },
      },
      handler: handle("computer_screenshot", async (args, context) => {
        const threadId = context.callerThreadId;
        const request = readCaptureRequest(args, (region) =>
          screenshotRectToDesktop(frames.resolve(threadId, readScreenshotIdArg(args)), region),
        );
        if (request.kind === "focused") {
          const capture = await manager.captureFocusedWindow(request.maxDimension);
          return deliverScreenshot(
            threadId,
            { computerId: manager.computerId },
            capture.screenshot,
            capture.windowId,
          );
        }
        return capturedScreenshotResult(
          threadId,
          request,
          await manager.captureScreenshot(request),
        );
      }),
    },
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_get_screen_size",
        description:
          "Read the logical screen dimensions of the desktop workspace. Informational only: pointer tools take pixel coordinates in a screenshot, not screen coordinates.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        annotations: {
          title: "Get screen size",
          ...READ_ONLY_TOOL_ANNOTATIONS,
        },
      },
      handler: handle("computer_get_screen_size", async () => manager.getScreenSize()),
    },
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_wait",
        description: `Wait for delayed content without sending input or changing focus. Prefer label plus window_id when you know the next control: duration_ms is then a maximum, and the tool returns as soon as that unique control appears, with a screenshot by default. Target it by label afterward so a layout change cannot leave stale coordinates. An unavailable accessibility tree returns immediately; use the screenshot and do not repeat semantic waits until the environment changes. Alternatively pass settle:true plus window_id: duration_ms is again the maximum, and the tool returns as soon as the window's accessibility surface stops changing — or when it cannot be watched, after a fixed pause reported as mode:"fixed". Without label or settle this is a fixed pause with no screenshot. Never repeat the preceding action merely because a page is still loading. Waiting is capped at ${COMPUTER_WAIT_MAX_MS} ms; one accessibility read may finish after the deadline.`,
        inputSchema: {
          type: "object",
          properties: {
            duration_ms: {
              type: "integer",
              minimum: 0,
              maximum: COMPUTER_WAIT_MAX_MS,
              description: `How long to wait, in milliseconds. Clamped to ${COMPUTER_WAIT_MAX_MS}.`,
            },
            label: {
              type: "string",
              description: "The next control's label to wait for. Requires window_id.",
            },
            role: {
              type: "string",
              description: "Optional role to distinguish controls with the same label.",
            },
            window_id: {
              type: "string",
              description: "Window to observe without raising or activating it.",
            },
            settle: {
              type: "boolean",
              description:
                "Wait for the window's accessibility surface to go quiet instead of for a named control. Requires window_id; cannot combine with label.",
            },
            ...INCLUDE_ACTION_SCREENSHOT_PROPERTY,
          },
          required: ["duration_ms"],
          additionalProperties: false,
        },
        annotations: { title: "Wait", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      handler: handle("computer_wait", async (args, context) => {
        const durationMs = readWaitDurationMs(args);
        if (args.label !== undefined && readBooleanArg(args, "settle") === true)
          throw new Error("A settle wait cannot combine with label; pick one observation mode.");
        if (args.label !== undefined) {
          const target = readTarget(args, context);
          if (!target.windowId || !target.label?.trim()) {
            throw new Error("A conditional wait requires a nonempty label and window_id.");
          }
          const windowId = target.windowId;
          const readiness = await waitForControl(
            () =>
              manager.withAgentActivity(
                context.callerThreadId,
                async () => {
                  await Effect.runPromise(context.assertCallerTurnActive(), {
                    signal: desktopOperationSignal(),
                  });
                  return manager.getState({ includeTree: true, windowId });
                },
                desktopOperationSignal(),
                context.callerTurnId ?? undefined,
              ),
            target,
            durationMs,
            desktopOperationSignal(),
          );
          const result = { computerId: manager.computerId, ...readiness };
          if (
            readBooleanArg(args, "include_screenshot") === false ||
            readiness.status === "closed"
          ) {
            return result;
          }
          const screenshot = await manager.withAgentActivity(
            context.callerThreadId,
            async () => {
              await Effect.runPromise(context.assertCallerTurnActive(), {
                signal: desktopOperationSignal(),
              });
              return manager.captureScreenshot({
                kind: "window",
                windowId,
                maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
              });
            },
            desktopOperationSignal(),
            context.callerTurnId ?? undefined,
          );
          return deliverScreenshot(context.callerThreadId, result, screenshot, windowId);
        }
        if (readBooleanArg(args, "settle") === true) {
          const windowId = readTarget(args, context).windowId;
          if (!windowId) {
            throw new Error("A settle wait requires window_id.");
          }
          const verdict = await manager.withAgentActivity(
            context.callerThreadId,
            async () => {
              await Effect.runPromise(context.assertCallerTurnActive(), {
                signal: desktopOperationSignal(),
              });
              return manager.waitForSettle(windowId, durationMs);
            },
            desktopOperationSignal(),
            context.callerTurnId ?? undefined,
          );
          return { computerId: manager.computerId, ...verdict };
        }
        if (durationMs > 0)
          await waitForComputer(durationMs, undefined, {
            signal: desktopOperationSignal(),
          });
        return { computerId: manager.computerId, waitedMs: durationMs };
      }),
    },
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_read_clipboard",
        description: `Read the desktop clipboard as text, returned as "value". ${SHARED_CLIPBOARD_NOTE} It returns whatever was copied last by anyone, so it may hold something the user copied for their own purposes. An empty clipboard returns an empty string; a clipboard holding an image, other non-text content, or more than ${COMPUTER_TEXT_MAX_LENGTH} characters of text is an error.`,
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        // Not READ_ONLY_TOOL_ANNOTATIONS: providers auto-approve on
        // readOnlyHint, and this read must go through approval — the clipboard
        // can hold something the human copied privately. It mutates nothing,
        // hence destructiveHint stays false.
        annotations: {
          title: "Read computer clipboard",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      handler: handle("computer_read_clipboard", async (_args, context) =>
        manager.readClipboard(context.callerThreadId),
      ),
    },
    actionEntry(
      "computer_launch_app",
      "Launch computer app",
      `Launch an application. ${launchAppNote(dialect)} Waits briefly for one unambiguous matching window and returns its id without a screenshot. A null window is not a launch failure; observe instead of launching again.`,
      {
        type: "object",
        properties: {
          app: { type: "string", description: launchAppArgumentNote(dialect) },
          wait_for_window: {
            type: "boolean",
            description: "Wait up to 2 seconds for one matching window. Defaults to true.",
          },
          arguments: {
            type: "array",
            items: { type: "string" },
            description:
              "Arguments passed to the application, such as a file path to open. Omit for a plain launch.",
          },
          hidden: {
            type: "boolean",
            description:
              "Launch the application hidden: its windows are created off-screen, it never activates, takes focus, or switches Spaces, and it still answers the semantic tools (set_value, clicks by label, get_window_state). Defaults to true — agent launches stay invisible; pass hidden:false only when the operator should see the app appear.",
          },
        },
        required: ["app"],
        additionalProperties: false,
      },
      async (args, context) => {
        const hidden = readBooleanArg(args, "hidden");
        return manager.launchApp(
          context.callerThreadId,
          readStringArg(args, "app", { required: true })!,
          readStringArrayArg(args, "arguments") ?? [],
          readBooleanArg(args, "wait_for_window") === false ? 0 : 2_000,
          hidden !== undefined ? { hidden } : undefined,
        );
      },
    ),
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_list_apps",
        description:
          "List running applications with pid, name, bundle id and active state. Use it to find the app that owns a window, or to confirm an app is running before launching it again.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { title: "List computer apps", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      handler: handle("computer_list_apps", async () => manager.listApps()),
    },
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_verify_state",
        description:
          "Assert what the exact window looks like right now without changing anything: element exists / enabled / selected / value_equals matched by role or label_contains, or window bounds within a pixel tolerance. Pass one to eight predicates, combined with AND. Returns a tri-state status — satisfied, unsatisfied, or unknown — plus the per-predicate evidence; unknown means the check could not be proven either way, not that it failed. Use it to prove an action's effect before continuing, or to check a control's state without touching it.",
        inputSchema: {
          type: "object",
          properties: {
            window_id: { type: "string", description: "The exact window to inspect." },
            expect: {
              type: "array",
              minItems: 1,
              maxItems: 8,
              items: { type: "object" },
              description:
                'Predicates such as {"element":{"selector":{"role":"AXButton","label_contains":"Save"},"enabled":true,"exists":true,"value_equals":null,"selected":null}} or {"window":{"bounds":{"x":0,"y":0,"width":800,"height":600,"tolerance_px":4}}}.',
            },
          },
          required: ["window_id", "expect"],
          additionalProperties: false,
        },
        annotations: { title: "Verify computer state", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      handler: handle("computer_verify_state", async (args) => {
        const windowId = readWindowIdArg(args);
        if (!windowId) throw new ToolInputError("window_id is required.");
        const raw = args.expect;
        if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8)
          throw new ToolInputError("expect must be an array of one to eight predicates.");
        for (const predicate of raw)
          if (!predicate || typeof predicate !== "object" || Array.isArray(predicate))
            throw new ToolInputError("Each expect predicate must be an object.");
        return manager.verifyState(windowId, raw as Record<string, unknown>[]);
      }),
    },
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_zoom",
        description:
          "Capture a magnified JPEG of a rect inside the exact window — for reading small text or dense UI that the window screenshot downscales away. x/y/width/height are window-local points: (0,0) is the window's top-left and the window's width/height come from computer_list_windows or get_state.",
        inputSchema: {
          type: "object",
          properties: {
            window_id: { type: "string", description: "The exact window to magnify." },
            x: { type: "number" },
            y: { type: "number" },
            width: { type: "number" },
            height: { type: "number" },
          },
          required: ["window_id", "x", "y", "width", "height"],
          additionalProperties: false,
        },
        annotations: { title: "Zoom into a window region", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      handler: handle("computer_zoom", async (args) => {
        const windowId = readWindowIdArg(args);
        if (!windowId) throw new ToolInputError("window_id is required.");
        const region = {
          x: readDelta(args, "x"),
          y: readDelta(args, "y"),
          width: readDelta(args, "width"),
          height: readDelta(args, "height"),
        };
        if (
          !Object.values(region).every(Number.isFinite) ||
          region.width <= 0 ||
          region.height <= 0
        )
          throw new ToolInputError("x/y/width/height must be finite, with positive size.");
        const zoom = await manager.zoomWindow(windowId, region);
        // The magnified frame is NOT registered as a coordinate frame: its
        // pixels are enlarged and window-local, so letting clicks resolve
        // against it would aim them off-target. It is display-only.
        const { bytesBase64, ...metadata } = zoom;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ computerId: manager.computerId, zoom: metadata }),
            },
            { type: "image", data: bytesBase64, mimeType: zoom.mimeType },
          ],
        };
      }),
    },
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_get_accessibility_tree",
        description:
          "Return the driver's lightweight desktop inventory — running apps and their on-screen windows with pid, title and window id — the fast discovery read that works before any OS grant is given. Pass window_id to scope the answer to the app that owns that exact window. It carries no control elements: computer_get_state stays the heavier per-window elements digest.",
        inputSchema: {
          type: "object",
          properties: {
            window_id: {
              type: "string",
              description:
                "Exact window from computer_list_windows; scopes the snapshot to the app that owns it.",
            },
          },
          additionalProperties: false,
        },
        annotations: {
          title: "List desktop apps and windows",
          ...READ_ONLY_TOOL_ANNOTATIONS,
        },
      },
      handler: handle("computer_get_accessibility_tree", async (args) =>
        manager.getAccessibilityTree(readWindowIdArg(args)),
      ),
    },
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_get_cursor_position",
        description:
          "Read the human cursor's current position in desktop points — top-left origin, the same coordinate space computer_list_windows reports bounds in. Pure read: it never moves the pointer. Pass window_id to also learn whether the point lies inside that window's bounds.",
        inputSchema: {
          type: "object",
          properties: {
            window_id: {
              type: "string",
              description:
                "Exact window from computer_list_windows; adds whether the cursor is inside its bounds.",
            },
          },
          additionalProperties: false,
        },
        annotations: {
          title: "Read cursor position",
          ...READ_ONLY_TOOL_ANNOTATIONS,
        },
      },
      handler: handle("computer_get_cursor_position", async (args) =>
        manager.getCursorPosition(readWindowIdArg(args)),
      ),
    },
    actionEntry(
      "computer_set_window_frame",
      "Set window frame",
      `Move and resize the exact window to x/y/width/height in desktop coordinates — the same space computer_list_windows reports bounds in. The new frame is read back and reported verified only when it matches; an unconfirmed result means the window may not have moved, so observe before relying on it. ${DELIVERY_HINT}`,
      {
        type: "object",
        properties: {
          window_id: { type: "string", description: "The exact window to move or resize." },
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
        },
        required: ["window_id", "x", "y", "width", "height"],
        additionalProperties: false,
      },
      async (args, context) => {
        const windowId = readWindowIdArg(args);
        if (!windowId) throw new ToolInputError("window_id is required.");
        const frame = {
          x: readDelta(args, "x"),
          y: readDelta(args, "y"),
          width: readDelta(args, "width"),
          height: readDelta(args, "height"),
        };
        if (!Object.values(frame).every(Number.isFinite) || frame.width <= 0 || frame.height <= 0)
          throw new ToolInputError("x/y/width/height must be finite, with positive size.");
        return manager.setWindowFrame(context.callerThreadId, windowId, frame);
      },
    ),
    actionEntry(
      "computer_invoke_menu",
      "Invoke menu item",
      `Invoke a menu-bar item on the exact window's app by path — ["File", "Save"] or ["Edit", "Copy"]. One to six levels; disabled or absent items are refused rather than clicked blindly. Menu commands can mutate the app or open dialogs, so read the result's verification and observe afterwards. ${DELIVERY_HINT}`,
      {
        type: "object",
        properties: {
          window_id: {
            type: "string",
            description: "A window owned by the app whose menu to invoke.",
          },
          path: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 6,
            description: 'Menu titles from the menu bar down, e.g. ["File", "Export As…"].',
          },
        },
        required: ["window_id", "path"],
        additionalProperties: false,
      },
      async (args, context) => {
        const windowId = readWindowIdArg(args);
        if (!windowId) throw new ToolInputError("window_id is required.");
        const path = readStringArrayArg(args, "path");
        if (!path?.length || path.length > 6 || path.some((title) => title.trim().length === 0))
          throw new ToolInputError("path must name one to six non-empty menu titles.");
        return manager.invokeMenu(context.callerThreadId, windowId, path);
      },
    ),
    actionEntry(
      "computer_kill_app",
      "Force-quit app",
      `Force-terminate the app that owns the exact window — the escalation after a cooperative close (computer_invoke_menu ["File","Quit"], or cmd+q via computer_hotkey) has already failed. Unsaved state is lost and every window of that app closes; the kill is refused when the window no longer exists. ${DELIVERY_HINT}`,
      {
        type: "object",
        properties: {
          window_id: {
            type: "string",
            description: "A window owned by the app to force-terminate.",
          },
        },
        required: ["window_id"],
        additionalProperties: false,
      },
      async (args, context) => {
        const windowId = readWindowIdArg(args);
        if (!windowId) throw new ToolInputError("window_id is required.");
        return manager.killApp(context.callerThreadId, windowId);
      },
    ),
    {
      // Not actionEntry on purpose: the visibility lifecycle never activates,
      // so advertising delivery_mode would promise a foreground excursion the
      // operation's whole contract is built to refuse.
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_set_window_minimized",
        description: `Minimize or restore the exact window in place — no activation, no focus change, no Space switch. A minimized window stays open and keeps answering the semantic tools (set_value, clicks by label, get_window_state) but takes no coordinate input and is not on screen. The driver reads the minimized state back; confirmed means the readback matched, anything less means observe before relying on it. ${DELIVERY_HINT}`,
        inputSchema: {
          type: "object",
          properties: {
            window_id: {
              type: "string",
              description: "The exact window to minimize or restore.",
            },
            minimized: {
              type: "boolean",
              description: "true minimizes the window into the dock; false restores it.",
            },
          },
          required: ["window_id", "minimized"],
          additionalProperties: false,
        },
        annotations: { title: "Minimize or restore window", ...WRITE_TOOL_ANNOTATIONS },
      },
      handler: handle("computer_set_window_minimized", async (args, context) => {
        if (readStringArg(args, "delivery_mode") === "foreground")
          throw new ToolInputError(
            "computer_set_window_minimized never activates; it takes no delivery_mode.",
          );
        const windowId = readWindowIdArg(args);
        if (!windowId) throw new ToolInputError("window_id is required.");
        const minimized = readBooleanArg(args, "minimized");
        if (minimized === undefined)
          throw new ToolInputError("minimized is required and must be a boolean.");
        return manager.setWindowMinimized(context.callerThreadId, windowId, minimized);
      }),
    },
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_set_app_visibility",
        description: `Hide or unhide a running application by pid — every window stays open but leaves the screen, without activating, focusing, or switching Spaces. Hidden apps keep answering the semantic tools, so this is the workspace that stays out of the user's way. The driver reads the hidden state back; confirmed means the readback matched, anything less means observe before relying on it. ${DELIVERY_HINT}`,
        inputSchema: {
          type: "object",
          properties: {
            pid: {
              type: "number",
              description: "The running application's process id, from computer_list_apps.",
            },
            hidden: {
              type: "boolean",
              description: "true hides the app's windows; false brings them back on screen.",
            },
          },
          required: ["pid", "hidden"],
          additionalProperties: false,
        },
        annotations: { title: "Hide or unhide app", ...WRITE_TOOL_ANNOTATIONS },
      },
      handler: handle("computer_set_app_visibility", async (args, context) => {
        if (readStringArg(args, "delivery_mode") === "foreground")
          throw new ToolInputError(
            "computer_set_app_visibility never activates; it takes no delivery_mode.",
          );
        const pid = readNumberArg(args, "pid");
        if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0)
          throw new ToolInputError("pid is required and must be a positive integer.");
        const hidden = readBooleanArg(args, "hidden");
        if (hidden === undefined)
          throw new ToolInputError("hidden is required and must be a boolean.");
        return manager.setAppVisibility(context.callerThreadId, pid, hidden);
      }),
    },
    clickEntry(
      "computer_click",
      "Click",
      "Click a coordinate or a uniquely labelled visible control. Ambiguous and off-screen targets are refused.",
      (threadId, target, modifiers) => manager.click(threadId, target, modifiers),
    ),
    clickEntry(
      "computer_double_click",
      "Double click",
      "Double-click a coordinate or a uniquely labelled visible control — opens an item, or selects a word in text.",
      (threadId, target, modifiers) => manager.doubleClick(threadId, target, modifiers),
    ),
    clickEntry(
      "computer_triple_click",
      "Triple click",
      "Triple-click a coordinate or a uniquely labelled visible control, which selects the whole line or paragraph under it — the reliable way to replace a field's contents before typing, where computer_set_value is not available and the range you want is a whole line or paragraph. For an exact character range on a text element use computer_select_text, which writes the selection through the accessibility layer. Three separate clicks are not the same gesture and will not select anything; a desktop that cannot send one refuses rather than approximating it.",
      (threadId, target, modifiers) => manager.tripleClick(threadId, target, modifiers),
    ),
    clickEntry(
      "computer_right_click",
      "Right click",
      "Right-click a coordinate or a uniquely labelled visible control to open its context menu.",
      (threadId, target, modifiers) => manager.rightClick(threadId, target, modifiers),
    ),
    observedActionEntry(
      "computer_move_cursor",
      "Move cursor",
      `Move the dedicated computer-use cursor to a coordinate or uniquely labelled visible control. It posts no click and presses nothing: it moves the agent's own visible cursor so the user can see where you are working. On macOS with Cua this only draws an overlay: it does not deliver hover events or open hover menus, and no synthetic move can — macOS discards posted pointer moves unless the user's own cursor is already inside the target window, so a real background hover is not available on this backend. It does not aim the keyboard, so a move followed by computer_type_text without a window_id is refused rather than typed into whatever the cursor happens to be over. The real system pointer never moves. ${POINTER_COORDINATE_HINT}`,
      targetSchema,
      async (args, context) =>
        manager.moveCursor(context.callerThreadId, readTarget(args, context)),
      // Not destructive: it changes only where the
      // agent's own overlay is drawn. `readOnlyHint` stays false because
      // something on screen does move, so a provider that surfaces write tools
      // still shows it.
      {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    ),
    observedActionEntry(
      "computer_drag",
      "Drag",
      `Drag between two coordinates or uniquely labelled visible controls, holding the primary button down the whole way — a selection swept across text, a file moved, a slider pulled, a window handle resized. ${dragLimitNote(dialect)} ${POINTER_COORDINATE_HINT}`,
      {
        type: "object",
        properties: {
          from: targetSchema,
          to: targetSchema,
          duration_ms: {
            type: "integer",
            minimum: 0,
            maximum: COMPUTER_DRAG_MAX_DURATION_MS,
            description: `How long the pointer takes to travel, in milliseconds. Defaults to ${DEFAULT_DRAG_DURATION_MS}; clamped to ${COMPUTER_DRAG_MAX_DURATION_MS}. A longer glide helps an application that needs to see the drag in progress, such as a drag-and-drop target that must highlight before the drop.`,
          },
        },
        required: ["from", "to"],
        additionalProperties: false,
      },
      async (args, context) =>
        manager.drag(
          context.callerThreadId,
          readNestedTarget(args, "from", context),
          readNestedTarget(args, "to", context),
          readDragDurationMs(args),
        ),
    ),
    observedActionEntry(
      "computer_scroll",
      "Scroll",
      `Scroll at an optional target. The target is resolved before the gesture and is never guessed. Scroll distance is measured in pixels of the same screenshot the coordinates are in, so a scroll needs a screenshot even when it names no coordinates at all — roughly 80 pixels per notch of a physical wheel in a full-resolution window capture. Both axes may scroll in one request and modifiers may be held during the gesture. Each request is limited to half the captured width or height so observations overlap; scroll.limitedTo reports any reduced request in desktop pixels. Read the returned image before scrolling again, because screenshot scales may differ. Applications may travel a different distance from the injected wheel units; Synara measures what actually moved, reports scroll.traveledY, and pre-divides later requests by what it learned (scroll.gearing). On macOS the wheel is quantized to 120-pixel notches up to 50 notches per axis per dispatch. A traveledY of 0 means the content did not move at all, which usually means the page is already at its edge — a wheel cannot scroll past the top or bottom. If you are scrolling to hunt for a control, stop and call computer_get_state instead: its elements list names the labeled controls on screen, and one of those may already be targetable by label. ${POINTER_COORDINATE_HINT}`,
      {
        type: "object",
        properties: {
          ...pointerTargetProperties,
          ...MODIFIERS_PROPERTY,
          delta_x: {
            type: "number",
            description:
              "Horizontal scroll distance in screenshot pixels; positive scrolls toward the right of the content.",
          },
          delta_y: {
            type: "number",
            description:
              "Vertical scroll distance in screenshot pixels; positive scrolls toward the end of the content, the way a wheel notch pulled downward does.",
          },
        },
        required: ["delta_x", "delta_y"],
        additionalProperties: false,
      },
      async (args, context) => {
        const threadId = context.callerThreadId;
        const raw = readScreenshotTarget(args);
        const frame = frames.resolve(threadId, raw.screenshotId);
        const resolved = resolveTarget(raw, threadId);
        const target =
          !hasTargetFields(resolved) && frame.windowId !== undefined
            ? { ...resolved, windowId: frame.windowId }
            : resolved;
        // The distance is in the same picture's pixels as the point, so a
        // scroll needs a frame even when it names no point at all.
        const delta = screenshotDeltaToDesktop(
          frame,
          readDelta(args, "delta_x"),
          readDelta(args, "delta_y"),
        );
        // Keep adjacent observations overlapping even when the model repeats
        // a pixel count after the screenshot changes scale.
        const limited = {
          deltaX:
            Math.sign(delta.deltaX) * Math.min(Math.abs(delta.deltaX), frame.region.width / 2),
          deltaY:
            Math.sign(delta.deltaY) * Math.min(Math.abs(delta.deltaY), frame.region.height / 2),
        };
        const modifiers = readModifiers(args);
        const incomingWindow = target.windowId ?? frame.windowId;
        let streak = unchangedScrolls.get(threadId);
        if (
          streak &&
          incomingWindow !== undefined &&
          streak.windowId !== undefined &&
          incomingWindow !== streak.windowId
        ) {
          unchangedScrolls.delete(threadId);
          streak = undefined;
        }
        if (
          streak &&
          streak.count >= 3 &&
          (incomingWindow === undefined || incomingWindow === streak.windowId)
        ) {
          throw new ToolInputError(
            "Refusing a fourth consecutive scroll with no visible movement on this window. " +
              "The content did not move — the page is at its edge. Stop scrolling and call " +
              "computer_get_state with label_contains to find a labeled control instead.",
          );
        }
        const outcome = await manager.scrollCalibrated(
          threadId,
          hasTargetFields(target) ? target : null,
          limited.deltaX,
          limited.deltaY,
          {
            observe: readBooleanArg(args, "include_screenshot") !== false,
            ...(modifiers.length > 0 ? { modifiers } : {}),
          },
        );
        const traveledY = outcome.result.scroll?.traveledY;
        const scrollObservation = outcome.observation;
        const capturedWindow =
          scrollObservation && "screenshot" in scrollObservation ? scrollObservation : undefined;
        // With wait_for_label the wrapper re-captures, so only travel counts;
        // otherwise an after-capture identical to the latest frame is the same
        // unchanged signal withObservation will report.
        const willBeUnchanged =
          args.wait_for_label === undefined &&
          capturedWindow !== undefined &&
          frames.matchLatest(threadId, capturedWindow.screenshot, capturedWindow.windowId) !==
            undefined;
        const resultWindow = outcome.result.windowId ?? capturedWindow?.windowId ?? incomingWindow;
        if (traveledY === 0 || willBeUnchanged) {
          const current = unchangedScrolls.get(threadId);
          // One entry per thread, never purged on thread end — bounded like
          // the digests; losing a streak only resets the repeated-scroll nudge.
          while (unchangedScrolls.size >= 256 && !unchangedScrolls.has(threadId))
            unchangedScrolls.delete(unchangedScrolls.keys().next().value!);
          if (current && current.windowId === resultWindow) {
            unchangedScrolls.set(threadId, {
              windowId: resultWindow,
              count: current.count + 1,
            });
          } else {
            unchangedScrolls.set(threadId, {
              windowId: resultWindow,
              count: 1,
            });
          }
        } else {
          unchangedScrolls.delete(threadId);
        }
        if (
          outcome.result.scroll &&
          (limited.deltaX !== delta.deltaX || limited.deltaY !== delta.deltaY)
        ) {
          return {
            ...outcome,
            result: {
              ...outcome.result,
              scroll: {
                ...outcome.result.scroll,
                requested: delta,
                limitedTo: limited,
              },
            },
          };
        }
        return outcome;
      },
    ),
    observedActionEntry(
      "computer_type_text",
      "Type text",
      `Type text into the focused desktop control, as if typed on the keyboard. It inserts at the caret or replaces the current selection. To overwrite part of a field's contents, select it first — computer_select_text for an exact character range, computer_triple_click for its whole line or paragraph, or the application's own select-all shortcut through computer_hotkey — or use computer_set_value to request a whole-field value change. For browser navigation use the address-bar shortcut, type the URL without a newline, then press Enter with wait_for_label for a known destination control; do not guess address-bar coordinates or repeat Enter on an unchanged page. Type the whole string in one call — a name, an email address, a URL — and do not split it into pieces; splitting only multiplies the chance of a partial result. ${KEYBOARD_TARGET_HINT} ${DELIVERY_HINT}`,
      {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The exact text to insert at the caret.",
          },
          ...textTargetProperties,
        },
        required: ["text"],
        additionalProperties: false,
      },
      async (args, context) => {
        const target = readTarget(args, context);
        return target.label !== undefined || target.role !== undefined
          ? manager.typeTextAt(context.callerThreadId, readRequiredText(args), target)
          : manager.typeText(context.callerThreadId, readRequiredText(args), target.windowId);
      },
    ),
    observedActionEntry(
      "computer_press_key",
      "Press key",
      `Press one keyboard key on the computer-use seat — enter, escape, tab, an arrow, a function key, backspace. For a key with modifiers, use computer_hotkey. ${KEYBOARD_TARGET_HINT} ${DELIVERY_HINT}`,
      {
        type: "object",
        properties: {
          key: {
            type: "string",
            description:
              'One key name: "enter", "escape", "tab", "backspace", "delete" (forward delete), "home", "end", "pageup", "pagedown", an arrow ("arrowdown" or "down"), "f1"-"f12", a modifier ("command", "shift", "option", "ctrl", "fn", "capslock"), or a single printable character. xdotool spellings such as "page_up" and "caps_lock" are accepted. "insert" is refused — macOS has no Insert key; "kp_*" keypad keys, "f13"-"f20", "menu" and "help" need the extended native keymap.',
          },
          ...keyboardTargetProperties,
        },
        required: ["key"],
        additionalProperties: false,
      },
      async (args, context) =>
        manager.pressKey(
          context.callerThreadId,
          readStringArg(args, "key", { required: true })!,
          readWindowIdArg(args),
        ),
    ),
    observedActionEntry(
      "computer_hotkey",
      "Press hotkey",
      `Press one keyboard shortcut. ${hotkeyFormNote(dialect)} ${KEYBOARD_TARGET_HINT} ${DELIVERY_HINT}`,
      {
        type: "object",
        properties: {
          keys: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: COMPUTER_HOTKEY_MAX_KEYS,
            description: hotkeyKeysNote(dialect),
          },
          ...keyboardTargetProperties,
        },
        required: ["keys"],
        additionalProperties: false,
      },
      async (args, context) =>
        manager.hotkey(context.callerThreadId, readHotkeyKeys(args), readWindowIdArg(args)),
    ),
    actionEntry(
      "computer_write_clipboard",
      "Write computer clipboard",
      `Replace the desktop clipboard with text, then paste it with the target application's own paste command. ${SHARED_CLIPBOARD_NOTE} Writing discards whatever the user had copied, so prefer computer_type_text for short input and use this for text too long or too awkward to type.`,
      {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      async (args, context) =>
        manager.writeClipboard(context.callerThreadId, readClipboardText(args)),
    ),
    observedActionEntry(
      "computer_paste",
      "Paste text",
      `Paste text into the target control through the clipboard — the fast path for long or awkward text computer_type_text would spend many keystrokes on. It saves the current clipboard, writes the text, sends the paste shortcut, then puts the user's contents back and reports clipboardRestored. A clipboard holding an image or other non-text content cannot be saved and is replaced. ${SHARED_CLIPBOARD_NOTE} ${KEYBOARD_TARGET_HINT} ${DELIVERY_HINT}`,
      {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The exact text to paste at the caret.",
          },
          ...keyboardTargetProperties,
        },
        required: ["text"],
        additionalProperties: false,
      },
      async (args, context) =>
        manager.paste(context.callerThreadId, readClipboardText(args), readWindowIdArg(args)),
    ),
    actionEntry(
      "computer_activate_window",
      "Activate window",
      "Bring a window into view and aim the agent keyboard at it, within the active Computer task's consent and approval mode. Ordinary background targeting does not activate a window. A desktop that cannot raise the window refuses. It returns no screenshot; observe with computer_screenshot or computer_get_state when needed.",
      {
        type: "object",
        properties: {
          window_id: {
            type: "string",
            description: "Window id from computer_list_windows.",
          },
        },
        required: ["window_id"],
        additionalProperties: false,
      },
      async (args, context) => {
        const windowId = readWindowIdArg(args);
        if (windowId === undefined) {
          throw new ToolInputError('Missing required argument "window_id".');
        }
        return manager.foregroundWithRestore(context.callerThreadId, windowId);
      },
    ),
    observedActionEntry(
      "computer_set_value",
      "Set computer value",
      "Set the value of a uniquely labelled accessible control after a fresh snapshot, through its freshly resolved element token. The label comes from computer_get_state's elements list; this writes atomically instead of typing keystrokes, so prefer it over click-then-type for any field that appears there. It replaces the control's whole value rather than inserting at the caret.",
      {
        type: "object",
        properties: {
          ...pointerTargetProperties,
          value: {
            type: "string",
            description: "The control's complete new value.",
          },
        },
        required: ["value"],
        additionalProperties: false,
      },
      async (args, context) =>
        manager.setValue(
          context.callerThreadId,
          readTarget(args, context),
          readSetValueValue(args),
        ),
    ),
    observedActionEntry(
      "computer_perform_action",
      "Perform computer action",
      `Perform a named semantic action on a uniquely labelled accessible control, through the accessibility layer rather than by clicking. ${performActionNote(dialect)}`,
      {
        type: "object",
        properties: {
          ...pointerTargetProperties,
          action: {
            type: "string",
            enum: [...semanticActionNames(dialect)],
            description: performActionArgumentNote(dialect),
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
      async (args, context) =>
        manager.performAction(
          context.callerThreadId,
          readTarget(args, context),
          readActionName(args),
        ),
    ),
    observedActionEntry(
      "computer_select_text",
      "Select text",
      `Select an exact character range inside a text element, through the accessibility layer rather than by key chord or pointer drag. ${selectTextNote(dialect)}`,
      {
        type: "object",
        properties: {
          ...textTargetProperties,
          start: {
            type: "integer",
            minimum: 0,
            maximum: COMPUTER_SELECT_TEXT_RANGE_MAX,
            description:
              "Zero-based character offset into the element's value where the selection begins. Counts the same characters a string index does; a start past the end is refused rather than clamped.",
          },
          length: {
            type: "integer",
            minimum: 0,
            maximum: COMPUTER_SELECT_TEXT_RANGE_MAX,
            description:
              "Number of characters to select; 0 collapses the selection to a caret at start. A range running past the element's end is refused rather than clamped.",
          },
        },
        required: ["start", "length"],
        additionalProperties: false,
      },
      async (args, context) =>
        manager.selectText(
          context.callerThreadId,
          resolveTarget(readSelectTextTarget(args), context.callerThreadId),
          readSelectTextRange(args),
        ),
    ),
    actionEntry(
      "computer_run",
      "Run computer actions",
      `Run an ordered list of actions in one call — the fast path for a sequence you already know. Each step is {"type": name} plus the fields of the computer_ tool with that name: click, double_click, triple_click, right_click, move_cursor, drag (from/to targets), scroll (delta_x/delta_y), type_text (text), press_key (key), hotkey (keys), set_value (value), perform_action (action), select_text (start, length), wait (duration_ms, optional element target; "absent":true waits for the element to disappear), activate_window (window_id), set_window_frame (x, y, width, height), invoke_menu (path), kill_app, set_window_minimized (minimized), set_app_visibility (pid, hidden), launch_app (app, optional hidden — launches are hidden by default; hidden:false shows the app), write_clipboard (text), paste (text). Observation steps: get_state (optional window_id + label_contains — returns a fresh elements listing and mints refs usable by later steps), verify_state (window_id + expect predicates). Any step can carry "if_element"/"unless_element" — a target object checked live at step time, skipping the step when its condition fails — and "continue_on_error":true to keep going past its own failure. Every step runs the same targeting, consent and refusal checks as the tool it names; label targets resolve fresh at execution, and ref targets name elements from the thread's earlier listings. The run stops at the first failure and returns per-step results plus the elements of the affected window — pass only steps that do not depend on screen changes you have not seen, or make the dependency a condition or a get_state step. Steps take no screenshots; set include_screenshot for a final capture. ${POINTER_COORDINATE_HINT}`,
      {
        type: "object",
        properties: {
          steps: {
            type: "array",
            minItems: 1,
            maxItems: COMPUTER_RUN_MAX_STEPS,
            items: {
              type: "object",
              required: ["type"],
              additionalProperties: false,
              properties: {
                type: { type: "string", enum: Object.keys(RUN_STEP_FIELDS) },
                x: { type: "number" },
                y: { type: "number" },
                screenshot_id: { type: "string" },
                label: { type: "string" },
                role: { type: "string" },
                ref: { type: "integer", minimum: 0 },
                ref_ordinal: { type: "integer", minimum: 0 },
                refOrdinal: { type: "integer", minimum: 0 },
                window_id: { type: "string" },
                windowId: { type: "string" },
                label_contains: { type: "string" },
                labelContains: { type: "string" },
                if_element: {
                  type: "object",
                  description:
                    "Run this step only if the element resolves live; the same target fields as a step (label/role/ref/window_id).",
                },
                unless_element: {
                  type: "object",
                  description:
                    "Skip this step if the element resolves live; the same target fields as a step.",
                },
                continue_on_error: { type: "boolean" },
                absent: { type: "boolean" },
                expect: { type: "array", items: { type: "object" }, minItems: 1, maxItems: 8 },
                modifiers: MODIFIERS_PROPERTY.modifiers,
                from: {
                  type: "object",
                  description: "Drag start; the same target fields as a step.",
                },
                to: {
                  type: "object",
                  description: "Drag end; the same target fields as a step.",
                },
                duration_ms: { type: "integer", minimum: 0 },
                delta_x: { type: "number" },
                delta_y: { type: "number" },
                text: { type: "string" },
                key: { type: "string" },
                keys: {
                  type: "array",
                  items: { type: "string" },
                  maxItems: COMPUTER_HOTKEY_MAX_KEYS,
                },
                value: { type: "string" },
                action: {
                  type: "string",
                  enum: [...semanticActionNames(dialect)],
                },
                start: { type: "integer", minimum: 0, maximum: COMPUTER_SELECT_TEXT_RANGE_MAX },
                length: { type: "integer", minimum: 0, maximum: COMPUTER_SELECT_TEXT_RANGE_MAX },
                app: { type: "string" },
                arguments: { type: "array", items: { type: "string" } },
                wait_for_window: { type: "boolean" },
                hidden: { type: "boolean" },
                minimized: { type: "boolean" },
                pid: { type: "integer", minimum: 1 },
              },
            },
            description:
              "Ordered steps; the whole list is validated before anything runs, so a malformed step refuses the batch untouched.",
          },
          include_screenshot: {
            type: "boolean",
            description: "Attach a final screenshot of the affected window. Defaults to false.",
          },
        },
        required: ["steps"],
        additionalProperties: false,
      },
      runComputerBatch,
    ),
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_recording_start",
        description:
          'Start a structured recording of this thread\'s computer calls — one bounded local file per session under the server state dir. Records carry the target identity, action class, approval path, dispatch verdict, and verification evidence of every call — never screenshots, never clipboard contents. fidelity "redacted" (default) stores text payloads as length+sha256; "full" keeps them verbatim so they can be replayed, except onto protected fields, which stay hashed at every fidelity. One session per thread; stop it with computer_recording_stop.',
        inputSchema: {
          type: "object",
          properties: {
            fidelity: {
              type: "string",
              enum: ["redacted", "full"],
              description:
                '"redacted" is the default and the contract; "full" keeps text payloads verbatim so a replay can re-issue them. Secure-field payloads stay hashed either way.',
            },
          },
          additionalProperties: false,
        },
        annotations: {
          title: "Start computer recording",
          ...WRITE_TOOL_ANNOTATIONS,
        },
      },
      handler: handle("computer_recording_start", async (args, context) => {
        const fidelity = readStringArg(args, "fidelity");
        if (fidelity !== undefined && fidelity !== "redacted" && fidelity !== "full") {
          throw new ToolInputError('fidelity must be "redacted" or "full".');
        }
        return manager.startComputerRecording({
          threadId: context.callerThreadId,
          ...(context.callerTurnId ? { turnId: context.callerTurnId } : {}),
          ...(fidelity !== undefined ? { fidelity: fidelity as ComputerRecordingFidelity } : {}),
        });
      }),
    },
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_recording_stop",
        description:
          "Stop a computer recording session and write its end line. With no recording_id, stops the session open on this thread.",
        inputSchema: {
          type: "object",
          properties: {
            recording_id: {
              type: "string",
              description: "A recording id from computer_recording_list or _start.",
            },
          },
          additionalProperties: false,
        },
        annotations: {
          title: "Stop computer recording",
          ...READ_ONLY_TOOL_ANNOTATIONS,
        },
      },
      handler: handle("computer_recording_stop", async (args, context) => {
        const recordingId = readStringArg(args, "recording_id");
        const summary =
          recordingId === undefined
            ? await manager.stopComputerRecordingForThread(context.callerThreadId)
            : await manager.stopComputerRecording(recordingId);
        return summary === undefined
          ? { stopped: false, note: "No open recording session matches." }
          : { stopped: true, ...summary };
      }),
    },
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_recording_list",
        description:
          "List computer recording sessions — open ones first, then newest-first — with step counts, fidelity, and close reasons.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: {
          title: "List computer recordings",
          ...READ_ONLY_TOOL_ANNOTATIONS,
        },
      },
      handler: handle("computer_recording_list", async () => ({
        recordings: await manager.listComputerRecordings(),
      })),
    },
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_recording_read",
        description:
          "Read one recording: the header, the recorded steps, and a plain-English history line per step. Steps carry redacted arguments — hashes stand in for text payloads at redacted fidelity.",
        inputSchema: {
          type: "object",
          properties: {
            recording_id: {
              type: "string",
              description: "A recording id from computer_recording_list.",
            },
          },
          required: ["recording_id"],
          additionalProperties: false,
        },
        annotations: {
          title: "Read computer recording",
          ...READ_ONLY_TOOL_ANNOTATIONS,
        },
      },
      handler: handle("computer_recording_read", async (args) => {
        const recordingId = readStringArg(args, "recording_id", { required: true })!;
        const document = await manager.readComputerRecording(recordingId);
        return { ...document, history: computerRecordingHistoryLines(document) };
      }),
    },
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_recording_export",
        description:
          "Export one recording's raw NDJSON — already redacted at write time. Contents over 200,000 characters are truncated; the file on disk is the full record.",
        inputSchema: {
          type: "object",
          properties: {
            recording_id: {
              type: "string",
              description: "A recording id from computer_recording_list.",
            },
          },
          required: ["recording_id"],
          additionalProperties: false,
        },
        annotations: {
          title: "Export computer recording",
          ...READ_ONLY_TOOL_ANNOTATIONS,
        },
      },
      handler: handle("computer_recording_export", async (args) => {
        const recordingId = readStringArg(args, "recording_id", { required: true })!;
        const contents = await manager.exportComputerRecording(recordingId);
        const truncated = contents.length > 200_000;
        return {
          recordingId,
          format: "ndjson",
          bytes: Buffer.byteLength(contents, "utf8"),
          contents: truncated ? `${contents.slice(0, 200_000)}…` : contents,
          ...(truncated ? { truncated: true } : {}),
        };
      }),
    },
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_recording_delete",
        description:
          "Delete one recording's file. An open session is closed first. The file is gone — this is evidence deletion, which is why it asks.",
        inputSchema: {
          type: "object",
          properties: {
            recording_id: {
              type: "string",
              description: "A recording id from computer_recording_list.",
            },
          },
          required: ["recording_id"],
          additionalProperties: false,
        },
        annotations: {
          title: "Delete computer recording",
          ...WRITE_TOOL_ANNOTATIONS,
        },
      },
      handler: handle("computer_recording_delete", async (args) => {
        const recordingId = readStringArg(args, "recording_id", { required: true })!;
        return { deleted: await manager.deleteComputerRecording(recordingId), recordingId };
      }),
    },
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_replay",
        description:
          "Classify a recording's steps against the live desktop — and with execute:true, re-issue the ready ones through the same resolution, consent, and dispatch paths a live call takes. execute absent or false is the dry run: nothing is dispatched and the report says what would happen. A step is re-issued only after its target re-resolves fresh (window still present, or exactly one same-app window to remap to, or a re-anchored point) — recorded pixels and window ids are hints, never proof. Text payloads re-issue only when the session captured them at full fidelity; protected-field steps are never retyped. Blocked and skipped steps name their reason in the report.",
        inputSchema: {
          type: "object",
          properties: {
            recording_id: {
              type: "string",
              description: "A recording id from computer_recording_list.",
            },
            execute: {
              type: "boolean",
              description:
                "Re-dispatch the steps classified ready. Default false — classify only, send nothing.",
            },
            from_seq: {
              type: "integer",
              minimum: 1,
              description: "First recorded step number to consider, inclusive.",
            },
            to_seq: {
              type: "integer",
              minimum: 1,
              description: "Last recorded step number to consider, inclusive.",
            },
          },
          required: ["recording_id"],
          additionalProperties: false,
        },
        annotations: {
          title: "Replay computer recording",
          ...WRITE_TOOL_ANNOTATIONS,
        },
      },
      handler: handle("computer_replay", async (args, context) => {
        const recordingId = readStringArg(args, "recording_id", { required: true })!;
        const execute = readBooleanArg(args, "execute");
        const fromSeq = readNumberArg(args, "from_seq");
        const toSeq = readNumberArg(args, "to_seq");
        const signal = desktopOperationSignal();
        return manager.replayComputerRecording(context.callerThreadId, recordingId, {
          ...(execute !== undefined ? { execute } : {}),
          ...(fromSeq !== undefined ? { fromSeq } : {}),
          ...(toSeq !== undefined ? { toSeq } : {}),
          ...(signal !== undefined ? { signal } : {}),
          ...(context.callerTurnId ? { turnId: context.callerTurnId } : {}),
        });
      }),
    },
  ];
}

/**
 * The semantic action names this desktop's accessibility layer actually
 * accepts.
 *
 * The parameter was a bare string with no enum, so models invented plausible
 * names — `AXPress` on a Linux desktop, `toggle` on macOS — and every one of
 * them came back as a refusal the caller could do nothing with. Both lists are
 * what the backends really implement: `KWinComputerBackend.performAction` maps
 * exactly two names onto a synthetic click and refuses everything else, while
 * the macOS backend forwards each listed name to the driver recipe that
 * performs the matching `AXUIElementPerformAction` on the resolved element.
 */
function semanticActionNames(dialect: ComputerAgentDialect): readonly string[] {
  return dialect === "macos"
    ? ["AXPress", "press", "open", "show_menu", "menu", "pick", "confirm", "cancel"]
    : ["activate", "click"];
}

function performActionNote(dialect: ComputerAgentDialect): string {
  return dialect === "macos"
    ? "Cua performs named AX actions through a freshly resolved element token: press (or the legacy AXPress spelling) activates the control, open performs AXOpen, show_menu/menu perform AXShowMenu, and pick, confirm and cancel perform their namesakes. Every name past press dispatches only when the element advertises that AX action in a fresh snapshot; otherwise the call refuses and nothing is submitted."
    : 'This desktop supports "activate" and "click".';
}

function performActionArgumentNote(dialect: ComputerAgentDialect): string {
  return dialect === "macos"
    ? 'One of "press" (AXPress), "open" (AXOpen), "show_menu"/"menu" (AXShowMenu), "pick", "confirm" or "cancel"; use the exact window and its fresh accessibility snapshot, and expect a refusal when the element does not advertise the action.'
    : 'Use "activate" or "click".';
}

/**
 * What range selection means on each backend family. macOS writes
 * `AXSelectedTextRange` natively on a fresh element token and confirms by
 * reading the attribute back; a target with no settable selection attribute
 * — web content addressed only through marker ranges included — refuses
 * before dispatch, and no layer approximates the selection with
 * triple-click, select-all, or a pointer drag.
 */
function selectTextNote(dialect: ComputerAgentDialect): string {
  return dialect === "macos"
    ? "Cua writes AXSelectedTextRange on a freshly resolved element token and verifies the selection by native read-back. A target without a settable selection attribute refuses before dispatch — nothing falls back to triple-click or select-all, and an uncertain result is never replayed. Label and role come from computer_get_state; pass window_id alone when the window holds exactly one writable text control."
    : "This desktop exposes no native range-selection write, so the call refuses rather than approximating the selection with triple-click, select-all, or a pointer drag.";
}

/**
 * What a shortcut may contain, which is not the same question on the two
 * families.
 *
 * The description said "ordered key sequence" and the schema allowed sixteen
 * keys, and neither backend does that: macOS throws unless exactly one key is
 * not a modifier, and Linux presses every key at once and releases them in
 * reverse. So the same wording taught macOS callers to send sequences that are
 * always refused, and Linux callers to expect a sequence they never get.
 */
function hotkeyFormNote(dialect: ComputerAgentDialect): string {
  return dialect === "macos"
    ? 'One chord: one or more modifiers plus exactly one other key, pressed together and released together — ["meta", "s"] to save, ["meta", "shift", "z"] to redo. More than one non-modifier key is refused; to press two shortcuts, call this twice.'
    : 'One chord: every key is pressed in the order given, held, then released in reverse — ["ctrl", "s"] to save, ["ctrl", "shift", "z"] to redo. It is not a sequence of separate keystrokes: to press two shortcuts, call this twice.';
}

function hotkeyKeysNote(dialect: ComputerAgentDialect): string {
  return dialect === "macos"
    ? 'The chord, modifiers first: any of "meta" (Command), "ctrl", "alt" (Option), "shift" and "fn", then exactly one other key such as "s", "tab", "arrowleft" or "f5".'
    : 'The chord, modifiers first: any of "ctrl", "alt", "shift" and "meta" (Super), then the key they apply to, such as "s", "tab" or "arrowleft".';
}

function launchAppNote(dialect: ComputerAgentDialect): string {
  return dialect === "macos"
    ? "Names an application the way macOS does. The app launches in the background: it does not come to the foreground, does not take focus and does not switch Spaces — call computer_activate_window on its window to bring it forward."
    : "Names an executable on PATH or a desktop application id.";
}

function launchAppArgumentNote(dialect: ComputerAgentDialect): string {
  return dialect === "macos"
    ? 'The application: its name as shown in the Applications folder ("Safari", "Visual Studio Code"), its bundle identifier ("com.apple.Safari"). The result reports what the name resolved to.'
    : 'The application: an executable name on PATH ("firefox"), a desktop application id ("org.mozilla.firefox"), or an absolute path to an executable. The result reports what the name resolved to.';
}

/**
 * Whether this list can be silently short, and why.
 *
 * Only macOS can: without the screen-capture grant `CGWindowListCopyWindowInfo`
 * omits window names, and an untitled off-screen window is unaddressable and so
 * is dropped — which takes every minimized and off-Space window off the list
 * with it. Saying so on Linux, where the compositor plugin enumerates windows
 * with no such grant, would only invite doubt about a list that is complete.
 */
function windowListCompletenessNote(dialect: ComputerAgentDialect): string {
  return dialect === "macos"
    ? " If the result carries a setupRequired note about a screen-capture grant, this list is also incomplete: without that grant macOS withholds window titles, and an untitled off-screen window cannot be addressed and is left out — so minimized and other-Space windows disappear from it. What it does report is accurate."
    : "";
}

function dragLimitNote(dialect: ComputerAgentDialect): string {
  return dialect === "macos"
    ? "On macOS an exact-target drag rides the driver's window-local background delivery — it sweeps text selections and other press-drag-release gestures without taking focus on AppKit targets. Surfaces that drop background events report an unverifiable result; retry with delivery_mode:\"foreground\" (covered by the active Computer task's consent) when a drop does not land. The duration is limited to 10 seconds and both endpoints must stay inside the exact target window. Verify the drop from the returned screenshot."
    : "This desktop injects the drag at screen coordinates, so it works for anything the pointer can sweep — selecting text, moving a slider — but cross-application drag-and-drop and dragging a window by its titlebar are handled by the compositor and may not follow. Check the result with computer_screenshot rather than assuming the drop landed.";
}

import { parseCuaActionDiagnostics } from "@synara/shared/cuaActionDiagnostics";
import { ComputerProgressGuard, type ComputerProgressAction } from "./computerProgressGuard.ts";
import { beginComputerTurnCall } from "../computer/computerTurnTiming.ts";
import {
  bindComputerTargetRef,
  computerElementRefIdentity,
} from "../computer/computerElementIdentity.ts";
import { makeComputerSpaceTools } from "./computerSpaceTools.ts";
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
  type ComputerInputModifier,
  type ComputerLaunchAppResult,
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
  type ComputerMenuTarget,
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
  computerAuditGatewayRequestId,
  summarizeComputerAuditArgs,
  type ComputerAuditEffect,
  type ComputerAuditEntry,
} from "../computer/computerAuditLog.ts";
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
import {
  COMPUTER_FOREGROUND_NOT_AUTHORIZED,
  COMPUTER_FOREGROUND_NOT_REQUESTED_CODE,
  type ComputerForegroundAuthorization,
} from "../computer/computerVisibleUse.ts";
import { PROVIDERS_WITHOUT_APPROVAL_GATE } from "./approvalGate.ts";
export { computerToolInstructions } from "./computerGuidance.ts";
import {
  COMPUTER_HELP_INDEX,
  COMPUTER_HELP_SECTIONS,
  COMPUTER_HELP_TOPICS,
  type ComputerHelpTopic,
} from "./computerGuidance.ts";
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
  "Computer routing reminder: observe with computer_get_state and exact window_id before acting; prefer element refs; computer_invoke_menu activates the app, so only with visible-use consent. Use coordinates only for controls absent from elements. computer_type_text with window_id alone inserts the whole string into the focused field; never spell text through computer_press_key. Background text is focus-neutral only when Cua proves one writable Accessibility target. Foreground delivery requires the user's visible-use authorization; never replay uncertain delivery; off-Space pixels are not live.";

/**
 * Attached to every null-window launch result, always rather than on
 * cadence: a launch that yields no window is the exact moment the next step
 * matters, and the description alone does not stop a relaunch loop.
 */
const INPUT_PAUSE_REQUERY_HINT =
  "To resume, call computer_get_state with the paused window_id, or with include_screenshot: true when no window is named; never replay an uncertain action.";

const LAUNCH_NULL_WINDOW_GUIDANCE =
  "No usable window was established. The launch may already have started the app; never launch again automatically. Inspect computer_list_windows once using the returned app identity. If no usable target exists, report the limitation instead of looping. An isolated browser via computer_browser_prepare is an alternative only when compatible with the requested task; do not silently replace a requested personal browser or incognito window.";

function withLaunchGuidance(result: ComputerLaunchAppResult) {
  if (result.focusChangedDuringLaunch === true) {
    return {
      ...result,
      toolGuidance:
        "The app changed desktop focus during launch despite the background request. Do not relaunch or continue input from the previous observation. Read fresh state and respect the user's visible-use permission." +
        (result.window === null ? ` ${LAUNCH_NULL_WINDOW_GUIDANCE}` : ""),
    };
  }
  return result.window === null ? { ...result, toolGuidance: LAUNCH_NULL_WINDOW_GUIDANCE } : result;
}

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
  // Overlay changes still require computer authority.
  "computer_move_cursor",
  "computer_drag",
  "computer_scroll",
  "computer_type_text",
  "computer_press_key",
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
 * call targeted, so a window-grain tool still names its app.
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
  if (isToolResult(value)) return computerAuditResultWindowId(toolResultPayload(value));
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
  if (isToolResult(value)) return computerAuditSuccessEffect(name, toolResultPayload(value));
  const delivery = (value as { delivery?: { effect?: unknown } } | null | undefined)?.delivery;
  if (
    delivery?.effect === "verified" ||
    delivery?.effect === "dispatched-unknown" ||
    delivery?.effect === "not-dispatched"
  )
    return delivery.effect;
  if (name === "computer_run") {
    const batch = value as { completed?: unknown; steps?: unknown } | null | undefined;
    // A failing first step may already have sent input. Zero completed steps
    // is not proof of zero dispatch when the step's native error says unknown.
    if (
      Array.isArray(batch?.steps) &&
      batch.steps.some(
        (step) =>
          step !== null &&
          typeof step === "object" &&
          (step as { error?: { effect?: unknown } }).error?.effect === "dispatched-unknown",
      )
    )
      return "dispatched-unknown";
    const completed = batch?.completed;
    return typeof completed === "number" && completed > 0 ? "dispatched-unknown" : "not-dispatched";
  }
  return "dispatched-unknown";
}

/** The effect/code pair a failed call reports — a typed refusal or a fault. */
export function computerAuditErrorOutcome(error: unknown): {
  readonly effect: ComputerAuditEffect;
  readonly code: string;
  readonly diagnostics?: ComputerAuditEntry["diagnostics"];
  readonly layer?: ComputerAuditEntry["layer"];
} {
  // A CuaActionError already carries the delivery taxonomy's verdict.
  if (error instanceof CuaActionError)
    return {
      effect: error.effect,
      code: error.code ?? "cua_action_error",
      ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}),
      ...(error.layer ? { layer: error.layer } : {}),
    };
  if (error instanceof ComputerTargetError) return { effect: "refused", code: error.code };
  if (error instanceof ComputerLeaseError) return { effect: "refused", code: error.code };
  if (error instanceof ComputerBackendError) {
    return error.inputPause !== undefined
      ? { effect: "refused", code: "computer_input_paused", layer: "server-manager" }
      : { effect: "error", code: "computer_backend_error" };
  }
  if (error instanceof ToolInputError) return { effect: "refused", code: "invalid_arguments" };
  return { effect: "error", code: "error" };
}

/** Computer tools are capability-gated. Provider-side schema loading varies;
 * inactive sessions receive no computer definitions. */
export interface AgentGatewayComputerToolsOptions {
  readonly manager: ComputerManager;
  /** Already registered Computer tools from another family, for on-demand help only. */
  readonly relatedTools?: readonly ToolEntry[];
  readonly resolveSpaceDesignation?: (context: ToolContext) => Promise<readonly number[]>;
  readonly authorizeAction?: (
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
    signal: AbortSignal,
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
  /**
   * Whether the thread's current task text asked to see the desktop. Read by
   * every raise-shaped call — `computer_activate_window`, a foreground
   * delivery, a visible launch — and absent means "not authorized", never a
   * default yes. The layer implements it from the thread's latest user
   * message; a resolver that fails also refuses.
   */
  readonly resolveForegroundAuthorization?: (
    context: ToolContext,
  ) => Promise<ComputerForegroundAuthorization>;
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
  "Screenshots include screenshotId and pixel width/height; pass x/y as pixel coordinates in that image from its top-left corner. The server maps them onto the desktop.";

/**
 * Both clipboard tools must say the same thing about ownership: the desktop has
 * one clipboard and the human is the other party using it.
 */
const SHARED_CLIPBOARD_NOTE =
  "The desktop has a single clipboard shared with the human user, not a private one for the agent.";

/** The coordinate rule each pointer tool carries, self-contained. */
const POINTER_COORDINATE_HINT =
  "x/y are pixels in the received screenshot, never desktop coordinates.";

/**
 * The parity lever for visual grounding: when the model knows a control's
 * label from get_state, label-targeting resolves to that exact control, while
 * a pixel estimate from a downscaled screenshot can land a few points off.
 */
const SEMANTIC_TARGETING_NOTE = "Prefer label and role from computer_get_state over estimated x/y.";

/** The short form the action tools carry. */
const ACTION_SCREENSHOT_HINT =
  "Returns a screenshot of the affected window unless include_screenshot:false.";

const INCLUDE_ACTION_SCREENSHOT_PROPERTY = {
  include_screenshot: {
    type: "boolean",
    description:
      "Post-action screenshot, default true. For a short sequence, use false then verify with fresh state or a final screenshot.",
  },
} as const;

const WINDOW_FOCUS_NOTE =
  "focused: agent target; keyboardFocused: app keyboard window; active: native activation. Absent fields mean unknown.";

/** The short form the keyboard tools carry. */
const KEYBOARD_TARGET_HINT =
  "Pass window_id or use the last aimed window; hover does not aim keys. Use a field ref or label to disambiguate text targets.";

/** The short form the input tools carry. */
const DELIVERY_HINT =
  "delivery.verified and delivery.effect report evidence, not retry permission — never replay an uncertain action.";

/** Longest step list one computer_run accepts. */
const COMPUTER_RUN_MAX_STEPS = 25;

/** Bounded perception routes whose results do not fit a run's JSON steps. */
const COMPUTER_INSPECTION_TOOL_NAMES = [
  "computer_read_clipboard",
  "computer_zoom",
  "computer_get_accessibility_tree",
  "computer_get_cursor_position",
  "computer_spaces",
] as const;

function isInspectionToolName(name: string): boolean {
  return (COMPUTER_INSPECTION_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * These canonical schemas are flat string/number objects. Validate the
 * selected definition itself, rather than copy its fields into a second
 * schema. Reject unfamiliar schema constraints instead of ignoring them.
 */
function validateInspectionArguments(
  value: unknown,
  definition: ToolEntry["definition"],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolInputError('"arguments" must be an object.');
  }
  const args = value as Record<string, unknown>;
  const schema = definition.inputSchema;
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (schema.type !== "object" || schema.additionalProperties !== false || !properties) {
    throw new ToolInputError("The inspection schema cannot be validated.");
  }
  const required = schema.required as readonly string[] | undefined;
  for (const key of required ?? []) {
    if (!Object.hasOwn(args, key)) throw new ToolInputError(`Missing required argument "${key}".`);
  }
  for (const [key, property] of Object.entries(properties)) {
    if (
      (property.type !== "string" && property.type !== "number") ||
      Object.keys(property).some((field) => field !== "type" && field !== "description")
    ) {
      throw new ToolInputError("The inspection schema cannot be validated.");
    }
    if (!Object.hasOwn(args, key)) continue;
    const value = args[key];
    if (
      (property.type === "string" && typeof value !== "string") ||
      (property.type === "number" && (typeof value !== "number" || !Number.isFinite(value)))
    ) {
      throw new ToolInputError(`Argument "${key}" must be a ${property.type}.`);
    }
  }
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(properties, key)) throw new ToolInputError(`Unknown argument "${key}".`);
  }
  return args;
}

/**
 * Per-app notes that change how the standard tools behave, attached once to
 * the first state read scoped to that app's window. Verified behavior only —
 * a hint that guesses teaches the model a wrong move it then has to unlearn.
 * Keyed by the lowercase appName computer_list_windows reports.
 */
const APP_GUIDANCE: Record<string, string> = {
  slack: COMPUTER_HELP_SECTIONS.slack,
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
        "Writable label from computer_get_state, scoped by window_id without activation.",
    },
    role: {
      type: "string",
      description: "Role to disambiguate the field label.",
    },
    ref: {
      type: "integer",
      minimum: 0,
      description: "Text control ref from computer_get_state.",
    },
    ref_ordinal: {
      type: "integer",
      minimum: 0,
      description: "With label: zero-based duplicate index when no ref is given.",
    },
  };
}

/**
 * Modifiers held down for the whole gesture and released after it.
 *
 * Not expressible as a computer_press_key chord, which presses and releases:
 * by the time the click arrived nothing was held and the application saw a
 * plain click. So shift-click, cmd-click and ctrl-scroll had no reachable
 * spelling at all.
 */
const MODIFIERS_PROPERTY = {
  modifiers: {
    type: "array",
    items: { type: "string", enum: ["ctrl", "alt", "shift", "meta"] },
    maxItems: COMPUTER_MODIFIERS_MAX_ITEMS,
    description: 'Held through the gesture, then released; "meta" is Command on macOS.',
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
      "Frame for x/y; defaults to the latest screenshot. An earlier one must still be valid.",
  },
} as const;

const TARGET_PROPERTIES = {
  x: {
    type: "number",
    description: "Pixel x in the screenshot.",
  },
  y: {
    type: "number",
    description: "Pixel y in the screenshot.",
  },
  ...SCREENSHOT_ID_PROPERTY,
  label: {
    type: "string",
    description:
      "Exact label from computer_get_state; matched verbatim against fresh state, including surrounding spaces.",
  },
  role: {
    type: "string",
    description: "Optional role used to disambiguate the label.",
  },
  ref: {
    type: "integer",
    minimum: 0,
    description:
      "Ref from computer_get_state; distinguishes duplicates and stays bound to that element, never another.",
  },
  ref_ordinal: {
    type: "integer",
    minimum: 0,
    description: "With label: zero-based index among same-labelled controls, when no ref is given.",
  },
} as const;

/** Pointer targeting reveals the same window the input will reach. */
function targetProperties(): Record<string, unknown> {
  return {
    ...TARGET_PROPERTIES,
    window_id: {
      type: "string",
      description:
        "Exact window for label or x/y targeting; outside coordinates are refused. For computer_scroll, window_id alone targets the window.",
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
  readonly diagnostics?: ComputerAuditEntry["diagnostics"];
  readonly layer?: ComputerAuditEntry["layer"];
  readonly wait_seconds?: number;
  readonly requery_hint?: string;
} {
  return {
    error: error.code,
    effect: error.effect,
    message: error.message,
    retryAllowed: false,
    ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}),
    ...(error.layer ? { layer: error.layer } : {}),
    ...(error.waitSeconds !== undefined ? { wait_seconds: error.waitSeconds } : {}),
    ...(error.code === "computer_input_paused" ? { requery_hint: INPUT_PAUSE_REQUERY_HINT } : {}),
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

/**
 * The target a menu invocation names — `window_id` (one exact window, with
 * the driver's focus-sensitive exact-window semantics), or `app`/`pid` (the
 * application-level menu bar of a running process, no window needed, the
 * only route for an app that has none). Exactly one form is required: they
 * are different routes, so mixing them is refused rather than silently
 * preferring one.
 */
function readMenuTargetArg(args: Record<string, unknown>): ComputerMenuTarget {
  const windowId = readWindowIdArg(args);
  const app = readStringArg(args, "app");
  const pid = readNumberArg(args, "pid");
  const forms = [windowId !== undefined, app !== undefined, pid !== undefined].filter(Boolean);
  if (forms.length === 0) {
    throw new ToolInputError(
      'Name the target one way: "window_id" (one exact window), or "app"/"pid" (that running app\'s menu bar, no window needed).',
    );
  }
  if (forms.length > 1) {
    throw new ToolInputError(
      'Pass exactly one of "window_id", "app", or "pid" — they name different menu routes.',
    );
  }
  if (windowId !== undefined) return { windowId };
  if (app !== undefined) return { app };
  if (pid !== undefined && Number.isSafeInteger(pid) && pid > 0) return { pid };
  throw new ToolInputError('"pid" must be a positive integer.');
}

/** The one-to-six-title menu path both the tool and a run step accept. */
function readMenuPathArg(args: Record<string, unknown>, subject: string): readonly string[] {
  const path = readStringArrayArg(args, "path");
  if (!path?.length || path.length > 6 || path.some((title) => title.trim().length === 0)) {
    throw new ToolInputError(`${subject} needs a path of one to six non-empty menu titles.`);
  }
  return path;
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

function readScrollDelta(args: Record<string, unknown>): { deltaX: number; deltaY: number } {
  const deltaX = readNumberArg(args, "delta_x") ?? 0;
  const deltaY = readNumberArg(args, "delta_y") ?? 0;
  if (deltaX === 0 && deltaY === 0) {
    throw new ToolInputError('Scroll needs a nonzero "delta_x" or "delta_y".');
  }
  return { deltaX, deltaY };
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
 * The click's gesture selectors. `count` carries the gestures the folded
 * double- and triple-click tools had, `button` the right-click. The manager
 * owns the support matrix — the primary button at any count, the secondary
 * button at count 1 — and refuses the rest before dispatch, so this reader
 * only bounds the shape.
 */
function readClickGesture(
  args: Record<string, unknown>,
): { count?: 1 | 2 | 3; button?: "left" | "right" | "middle" } | undefined {
  const count = readNumberArg(args, "count");
  const button = readStringArg(args, "button");
  if (count === undefined && button === undefined) return undefined;
  if (count !== undefined && (!Number.isSafeInteger(count) || count < 1 || count > 3)) {
    throw new ToolInputError('Argument "count" must be 1, 2 or 3.');
  }
  if (button !== undefined && button !== "left" && button !== "right" && button !== "middle") {
    throw new ToolInputError('Argument "button" must be "left", "right" or "middle".');
  }
  return {
    ...(count !== undefined ? { count: count as 1 | 2 | 3 } : {}),
    ...(button !== undefined ? { button: button as "left" | "right" | "middle" } : {}),
  };
}

/**
 * The `key` argument: one key name, or one "mod+mod+key" chord. A value with
 * no "+" is a plain key; a "+"-joined value splits into the chord the
 * backend's own validation rules on. A part left empty by a stray "+" makes
 * the whole value a plain key again, so a literal "+" still presses and a
 * malformed "cmd++s" meets the driver's honest unknown-key refusal instead
 * of a half-parsed chord.
 */
function readKeyOrChord(args: Record<string, unknown>): {
  readonly key: string;
  readonly chord: readonly string[] | undefined;
} {
  const key = readStringArg(args, "key", { required: true })!;
  if (!key.includes("+")) return { key, chord: undefined };
  const parts = key.split("+").map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) return { key, chord: undefined };
  if (parts.length > COMPUTER_HOTKEY_MAX_KEYS) {
    throw new ToolInputError(
      `A "+"-joined chord accepts at most ${COMPUTER_HOTKEY_MAX_KEYS} keys; got ${parts.length}.`,
    );
  }
  const oversized = parts.find((part) => part.length > COMPUTER_KEY_NAME_MAX_LENGTH);
  if (oversized !== undefined) {
    throw new ToolInputError(
      `Each key in a chord is at most ${COMPUTER_KEY_NAME_MAX_LENGTH} characters; got one of ${oversized.length}.`,
    );
  }
  return { key, chord: parts };
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

/**
 * Whether every entry in a listing shares one window id. The common scoped
 * read is exactly this case, and repeating the same 15-40 char id on all 60
 * entries was a third of a full elements payload.
 */
function uniformElementWindowId(
  items: readonly { readonly windowId?: string | null }[],
): string | undefined {
  const windowId = items[0]?.windowId;
  return typeof windowId === "string" && items.every((item) => item.windowId === windowId)
    ? windowId
    : undefined;
}

/** The same entries without their `windowId` field, for a hoisted listing. */
function stripElementWindowId<T extends { readonly windowId?: string | null }>(
  items: readonly T[],
): readonly T[] {
  return items.map((item) => {
    const { windowId: _windowId, ...rest } = item;
    return rest as T;
  });
}

/**
 * The wire form of one elements listing: the window id is hoisted out of
 * each entry into a single `elementWindowId` when the whole listing belongs
 * to one window, and kept per entry when the listing spans windows — there
 * the id is what tells the model which window an action must name. Stored
 * digests are never touched, so refs and diffs keep their full identity.
 */
function hoistElementWindowId<T extends { readonly windowId?: string | null }>(
  items: readonly T[],
): { readonly items: readonly T[]; readonly elementWindowId?: string } {
  const elementWindowId = uniformElementWindowId(items);
  if (elementWindowId === undefined) return { items };
  return { items: stripElementWindowId(items), elementWindowId };
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
      const record = value as Record<string, unknown>;
      // A result that already carries its own next step (a null-window
      // launch, a refusal with a branch) keeps it: the generic reminder
      // appends instead of overwriting, or the targeted fix dies here.
      const existing = typeof record.toolGuidance === "string" ? record.toolGuidance : undefined;
      content[index] = {
        type: "text",
        text: JSON.stringify({
          ...record,
          toolGuidance: existing ? `${existing} ${guidance}` : guidance,
        }),
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
   * Native refs retain the observed actuator identity; a fresh tree must never
   * substitute a same-labelled control. Other backends resolve against their
   * tree as before. The cap clears the table without recycling numbers a model
   * could still be holding — old refs then fail loudly instead of retargeting.
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
    // Clear before stamping the listing, so every ref returned in this digest
    // remains resolvable. next stays monotonic across bounded table eviction.
    if (table.entries.size + elements.items.length > MAX_ELEMENT_REFS) {
      table.byKey.clear();
      table.entries.clear();
    }
    const items = elements.items.map((item, index) => {
      const id = elements.refIndex[index]!;
      const nativeIdentity = computerElementRefIdentity(id);
      const key = JSON.stringify([
        id.windowId,
        id.role,
        id.label,
        nativeIdentity === undefined ? ["ordinal", id.ordinal] : ["native", nativeIdentity],
      ]);
      let ref = table.byKey.get(key);
      if (ref === undefined) {
        ref = table.next++;
        table.byKey.set(key, ref);
        table.entries.set(ref, id);
      }
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

  /** One diff and wire format for explicit reads and best-effort action observations. */
  const elementChangeFields = (
    before: ComputerActionableElements | undefined,
    stable: ComputerActionableElements,
    limit = Infinity,
  ) => {
    const changes = diffActionableElements(before?.items ?? [], stable.items);
    let remaining = limit;
    const take = <T>(items: readonly T[]): readonly T[] => {
      const selected = items.slice(0, remaining);
      remaining -= selected.length;
      return selected;
    };
    const added = take(changes.added);
    // A removed entry's ref is a dead handle — the element is
    // gone — so showing it would make it look citable.
    const removed = take(changes.removed).map(({ ref: _ref, ...entry }) => entry);
    const changed = take(changes.changed);
    const omitted =
      changes.added.length +
      changes.removed.length +
      changes.changed.length -
      added.length -
      removed.length -
      changed.length;
    // One window id for the whole change set when every entry
    // names the same window; per entry otherwise, because that
    // is what tells the model which window to address.
    const elementWindowId = uniformElementWindowId([
      ...changes.added,
      ...changes.changed,
      ...changes.removed,
    ]);
    return {
      elementChanges: {
        added: elementWindowId === undefined ? added : stripElementWindowId(added),
        removed: elementWindowId === undefined ? removed : stripElementWindowId(removed),
        changed: elementWindowId === undefined ? changed : stripElementWindowId(changed),
      },
      ...(omitted > 0 ? { elementChangesOmitted: omitted } : {}),
      ...(elementWindowId === undefined ? {} : { elementWindowId }),
      // Either side reporting less than the full tree makes the
      // diff itself partial — removals beyond a cap are invisible.
      ...((before !== undefined && !before.complete) || !stable.complete
        ? { elementChangesIncomplete: true }
        : {}),
    };
  };

  const withActionElementChanges = async (
    result: ComputerActionResult,
    context: ToolContext,
  ): Promise<ComputerActionResult> => {
    const windowId = result.windowId;
    if (windowId === undefined) return result;
    const key = digestScopeKey(context.callerThreadId, windowId, undefined);
    const before = elementDigests.get(key);
    if (before === undefined) return result;
    try {
      assertDesktopOperationActive();
      const { root } = await manager.getState({
        windowId,
        includeTree: true,
        includeText: false,
        includeScreenshot: false,
      });
      assertDesktopOperationActive();
      if (root === undefined) return result;
      const stable = rememberDigest(
        context.callerThreadId,
        key,
        actionableElements(root, { windowId }),
      );
      return { ...result, ...elementChangeFields(before, stable, 40) };
    } catch {
      // The input already ran. Read failures do not change its delivery result;
      // cancellation still ends the operation instead of publishing stale state.
      assertDesktopOperationActive();
      return result;
    }
  };

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
      return bindComputerTargetRef(
        {
          label: entry.label,
          role: entry.role,
          ...(entry.windowId !== null ? { windowId: entry.windowId } : {}),
          refOrdinal: entry.ordinal,
        },
        entry,
      );
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
   * The never-raise authorization a call would carry, resolved only for the
   * calls that can move a window in front of the user — activate, foreground
   * delivery, a visible launch, and their run-step equivalents. A
   * resolver failure or an absent resolver is a refusal, never an inferred yes.
   */
  const foregroundAuthorization = async (
    context: ToolContext,
  ): Promise<ComputerForegroundAuthorization> => {
    const resolve = options.resolveForegroundAuthorization;
    if (resolve === undefined) return COMPUTER_FOREGROUND_NOT_AUTHORIZED;
    try {
      return await resolve(context);
    } catch {
      return COMPUTER_FOREGROUND_NOT_AUTHORIZED;
    }
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

  const progressGuard = new ComputerProgressGuard();

  /**
   * The calls that mutate the desktop — the approval taxonomy minus its one
   * read: the shared clipboard is gated for privacy, and re-reading it is not
   * a loop hazard the way a repeated keystroke is.
   */
  const isMutatingToolCall = (toolName: string): boolean =>
    computerToolRequiresApproval(toolName) && toolName !== "computer_read_clipboard";

  /** Deterministic key for one call: tool name + args with volatile fields out. */
  const repeatedActionKey = (toolName: string, args: Record<string, unknown>): string => {
    const stable = (value: unknown): string =>
      value === null || typeof value !== "object"
        ? (JSON.stringify(value) ?? "null")
        : Array.isArray(value)
          ? `[${value.map(stable).join(",")}]`
          : `{${Object.keys(value)
              .sort()
              .map(
                (key) =>
                  `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`,
              )
              .join(",")}}`;
    const {
      screenshot_id: _s1,
      include_screenshot: _s2,
      screenshotId: _s3,
      includeScreenshot: _s4,
      ...rest
    } = args;
    return `${toolName}${stable(rest)}`;
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
      // the targeted apps before dispatch, the delivered window id after.
      let drivenApps: ReadonlySet<string> = new Set();
      let resultWindowId: string | undefined;
      const audit = (outcome: {
        readonly effect: ComputerAuditEffect;
        readonly code?: string;
        readonly diagnostics?: ComputerAuditEntry["diagnostics"];
        readonly layer?: ComputerAuditEntry["layer"];
      }): void => {
        if (!COMPUTER_AUDITED_TOOLS.has(name)) return;
        const target = computerAuditTarget(args, drivenApps, resultWindowId);
        manager.recordComputerAudit({
          tool: name,
          ...computerAuditGatewayRequestId(context.jsonRpcRequestId),
          threadId: context.callerThreadId,
          ...(context.callerTurnId ? { turnId: context.callerTurnId } : {}),
          args: summarizeComputerAuditArgs(args),
          ...(target !== undefined ? { target } : {}),
          effect: outcome.effect,
          ...(outcome.code !== undefined ? { code: outcome.code } : {}),
          ...(outcome.diagnostics ? { diagnostics: outcome.diagnostics } : {}),
          ...(outcome.layer ? { layer: outcome.layer } : {}),
        });
      };
      const mutating = isMutatingToolCall(name);
      const actionKey = mutating ? repeatedActionKey(name, args) : "";
      let progressAction: ComputerProgressAction | undefined;
      return Effect.tryPromise({
        try: async (abortSignal) => {
          if (name === "computer_invoke_menu" && args.delivery_mode === "background") {
            throw new ToolInputError(
              "computer_invoke_menu requires foreground delivery and explicit visible-use authorization; it cannot preserve background focus.",
            );
          }
          // Fresh screenshots and alternating failed techniques must not
          // disguise retries. No turn ID means no cross-turn retained guard.
          if (mutating && context.callerTurnId) {
            // History lookup is not target validation: frame-setting x/y are
            // desktop bounds, not screenshot pixels, and consent still runs
            // before parsing or resolving a requested input target.
            const requestedWindow = args.window_id ?? args.windowId;
            const refWindow =
              typeof args.ref === "number"
                ? elementRefTables.get(context.callerThreadId)?.entries.get(args.ref)?.windowId
                : undefined;
            progressAction = {
              scope: {
                threadId: context.callerThreadId,
                turnId: context.callerTurnId,
                sessionKey: context.callerSessionKey,
              },
              targetKey:
                typeof requestedWindow === "string"
                  ? requestedWindow
                  : (refWindow ?? (typeof args.app === "string" ? args.app : "selected-window")),
              actionKey,
            };
            const blocked = progressGuard.check(progressAction);
            if (blocked) {
              audit({ effect: "refused", code: blocked.code });
              return {
                result: { ...mcpToolResultJson({ error: blocked }), isError: true },
                signal: undefined,
              };
            }
          }
          if (
            computerToolRequiresApproval(name) &&
            (options.authorizeAction !== undefined ||
              PROVIDERS_WITHOUT_APPROVAL_GATE.has(context.callerProvider) ||
              args.delivery_mode === "foreground" ||
              name === "computer_activate_window" ||
              name === "computer_invoke_menu")
          ) {
            if (!options.authorizeAction) {
              audit({ effect: "refused", code: "approval_unavailable" });
              return {
                result: approvalUnavailableResult(name),
                signal: undefined,
              };
            }
            if (
              !(await options.authorizeAction(
                name,
                name === "computer_activate_window" || name === "computer_invoke_menu"
                  ? { ...args, delivery_mode: "foreground" }
                  : args,
                context,
                abortSignal,
              ))
            ) {
              audit({ effect: "refused", code: "approval_denied" });
              return {
                result: mcpToolResultError(
                  "Computer action was denied or cancelled; no input was sent.",
                ),
                signal: undefined,
              };
            }
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
            );
          const finishTurnTiming =
            name !== "computer_run" &&
            (mutating ||
              [
                "computer_get_state",
                "computer_screenshot",
                "computer_get_accessibility_tree",
                "computer_wait",
              ].includes(name))
              ? beginComputerTurnCall(
                  context.callerThreadId,
                  context.callerTurnId ?? undefined,
                  mutating ? "write" : "observation",
                )
              : undefined;
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
                      args.delivery_mode === "foreground" ||
                      name === "computer_activate_window" ||
                      name === "computer_invoke_menu";
                    const restoresOwnForeground =
                      name === "computer_activate_window" || name === "computer_invoke_menu";
                    const authorization =
                      foreground && !restoresOwnForeground
                        ? await foregroundAuthorization(context)
                        : undefined;
                    return withDesktopDeliveryMode(foreground ? "foreground" : "background", () =>
                      // Activate and menu already restore in the manager;
                      // every other foreground call gets
                      // the same excursion treatment, so a foreground type or
                      // click cannot strand the user's window behind the target.
                      foreground && !restoresOwnForeground
                        ? manager.withForegroundRestore(
                            context.callerThreadId,
                            () =>
                              manager.cursorActivity.during(
                                context.callerThreadId,
                                cursorToolActivity(name),
                                invoke,
                              ),
                            authorization,
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
          const successEffect = computerAuditSuccessEffect(name, value);
          finishTurnTiming?.(
            successEffect !== "not-dispatched" &&
              successEffect !== "refused" &&
              successEffect !== "error" &&
              resultAvailability(value)?.kind !== "permission-required",
          );
          const payload = isToolResult(value) ? toolResultPayload(value) : value;
          const measured = payload as
            | { scroll?: { traveledY?: unknown }; observationEvidence?: unknown }
            | undefined;
          audit({
            effect: successEffect,
            diagnostics: parseCuaActionDiagnostics({
              diagnostics: {
                scroll_delta_y: measured?.scroll?.traveledY,
                observation: measured?.observationEvidence,
              },
            }),
          });
          if (progressAction) {
            const batch = payload as { steps?: Array<{ error?: { code?: unknown } }> } | undefined;
            const refusalCode =
              name === "computer_run" &&
              successEffect === "not-dispatched" &&
              Array.isArray(batch?.steps)
                ? batch.steps.find((step) => typeof step.error?.code === "string")?.error?.code
                : undefined;
            progressGuard.record(progressAction, {
              effect: successEffect,
              ...(typeof refusalCode === "string" ? { code: refusalCode } : {}),
            });
          }
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
          // is a state, not an event, and the log must stay empty for it.
          const outcome = computerAuditErrorOutcome(error);
          if (!(error instanceof ComputerBackendError && error.controlRevoked)) {
            audit(outcome);
          }
          // Refusals and uncertain delivery are tracked separately: a refused
          // retry was not sent, but must not hide a previous uncertain action.
          if (
            progressAction &&
            !(
              error instanceof ComputerBackendError &&
              (error.setupRequired || error.controlRevoked)
            )
          )
            progressGuard.record(progressAction, outcome);
          const failure =
            error instanceof ComputerBackendError && error.inputPause
              ? {
                  ...mcpToolResultJson({
                    error: {
                      code: "computer_input_paused",
                      ...error.inputPause,
                      layer: error instanceof CuaActionError ? error.layer : "server-manager",
                      retryable: false,
                      ...(error instanceof CuaActionError
                        ? { cause: error.code, diagnostics: error.diagnostics }
                        : {}),
                      requery_hint: INPUT_PAUSE_REQUERY_HINT,
                      ...(error instanceof CuaActionError && error.waitSeconds !== undefined
                        ? { wait_seconds: error.waitSeconds }
                        : {}),
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
            enum: name === "computer_invoke_menu" ? ["foreground"] : ["background", "foreground"],
            description:
              name === "computer_invoke_menu"
                ? "This menu route is always foreground and requires the user's explicit visible-use request."
                : "Background by default. Foreground requires the user's own task to ask to see the screen. Never replay uncertain input.",
          },
        },
      },
      annotations: { title, ...annotations },
    },
    handler: handle(name, run),
  });

  /**
   * Direct gateway clients may call these tools by name; provider models use
   * advertised computer_run for supported steps. Discovery does not install a
   * hidden definition in the provider. Capability, approval and audit remain
   * unchanged for both routes.
   */
  const discoveryOnly = (entry: ToolEntry): ToolEntry => ({ ...entry, discoveryOnly: true });

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
        observationEvidence: "target-window-closed",
        note: "The window this action targeted no longer exists — the action likely closed it, so no post-action screenshot was taken. Use computer_list_windows or computer_get_state to see the desktop now.",
      };
    }
    const reused = frames.matchLatest(context.callerThreadId, capture.screenshot, capture.windowId);
    if (reused) {
      return {
        ...result,
        observationEvidence: "frame-unchanged",
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
    return deliverScreenshot(
      context.callerThreadId,
      { ...result, observationEvidence: "fresh-frame" },
      capture.screenshot,
      capture.windowId,
    );
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
        const result = "result" in outcome ? outcome.result : outcome;
        const observed = [
          "computer_click",
          "computer_press_key",
          "computer_type_text",
          "computer_paste",
          "computer_set_value",
          "computer_perform_action",
        ].includes(name)
          ? await withActionElementChanges(result, context)
          : result;
        return "result" in outcome && args.wait_for_label === undefined
          ? withObservation(context, observed, outcome.observation)
          : observeAfterAction(args, observed, context);
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

  /**
   * The folded click's fields: the shared pointer target plus `count` and
   * `button`, which carry what the separate double-, triple- and right-click
   * tools used to spell. The manager owns which gesture pairs a desktop
   * supports and refuses the rest before dispatch.
   */
  const clickSchema = {
    type: "object",
    properties: {
      ...pointerTargetProperties,
      ...MODIFIERS_PROPERTY,
      count: {
        type: "integer",
        minimum: 1,
        maximum: 3,
        description:
          "1 plain; 2 double-click (open item/select word); 3 triple-click (select line/paragraph). A native multi-click gesture, never separate clicks; unsupported gestures are refused.",
      },
      button: {
        type: "string",
        enum: ["left", "right", "middle"],
        description:
          '"left" supports every count; "right" opens the context menu at count 1. Other pairs are refused.',
      },
    },
    additionalProperties: false,
  } as const;

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
    click: [...RUN_TARGET_FIELDS, "modifiers", "count", "button"],
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
    press_key: [
      "key",
      "window_id",
      "windowId",
      "label",
      "role",
      "ref",
      "ref_ordinal",
      "refOrdinal",
    ],
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
    invoke_menu: ["window_id", "windowId", "app", "pid", "path"],
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
      case "click": {
        const target = readTarget(step, context);
        const modifiers = readModifiers(step);
        const gesture = readClickGesture(step);
        return () => manager.click(threadId, target, modifiers, gesture);
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
        const requestedDelta = readScrollDelta(step);
        const delta = screenshotDeltaToDesktop(frame, requestedDelta.deltaX, requestedDelta.deltaY);
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
        const { key, chord } = readKeyOrChord(step);
        const target = readTarget(step, context);
        const exact = target.label !== undefined || target.role !== undefined ? target : undefined;
        return () =>
          chord === undefined
            ? manager.pressKey(threadId, key, target.windowId, exact)
            : manager.hotkey(threadId, chord, target.windowId, exact);
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
          // A pause between steps sends nothing: the pane's input may run.
          if (durationMs > 0) await manager.observeFor(durationMs, desktopOperationSignal());
          return { waitedMs: durationMs };
        };
      }
      case "activate_window": {
        const windowId = readWindowIdArg(step);
        if (windowId === undefined) {
          throw new ToolInputError('Step "activate_window" requires "window_id".');
        }
        // Foreground promotion is scoped to this one step: the rest of the
        // run keeps the batch's delivery mode. The same never-raise gate the
        // standalone tool takes applies per step — a run is not a bypass.
        return async () => {
          const authorization = await foregroundAuthorization(context);
          return withDesktopDeliveryMode("foreground", () =>
            manager.foregroundWithRestore(threadId, windowId, undefined, authorization),
          );
        };
      }
      case "launch_app": {
        const app = readStringArg(step, "app", { required: true })!;
        const appArgs = readStringArrayArg(step, "arguments") ?? [];
        const waitMs = readBooleanArg(step, "wait_for_window") === false ? 0 : 2_000;
        // On macOS a normal launch requests activates=false. Hiding the app
        // is independent from foreground delivery and often disables its UI.
        const hidden = readBooleanArg(step, "hidden");
        return async () => {
          if (dialect !== "macos" && hidden === false) {
            const authorization = await foregroundAuthorization(context);
            if (!authorization.userRequestedVisibleUse) {
              throw new CuaActionError(
                "The user's task did not ask for this app to be shown; launching it visibly " +
                  "would take their screen. Keep the launch in the background, or ask " +
                  "the user to confirm they want to watch.",
                "not-dispatched",
                COMPUTER_FOREGROUND_NOT_REQUESTED_CODE,
              );
            }
          }
          return withLaunchGuidance(
            await manager.launchApp(
              threadId,
              app,
              appArgs,
              waitMs,
              hidden !== undefined ? { hidden } : undefined,
            ),
          );
        };
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
        const target = readMenuTargetArg(step);
        const path = readMenuPathArg(step, 'Step "invoke_menu"');
        return async () =>
          manager.invokeMenu(threadId, target, path, await foregroundAuthorization(context));
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
          const wire = stable === undefined ? undefined : hoistElementWindowId(stable.items);
          return {
            ...(windowId !== undefined ? { windowId } : {}),
            elements: wire?.items ?? [],
            ...(wire?.elementWindowId === undefined
              ? {}
              : { elementWindowId: wire.elementWindowId }),
            // An empty listing with an unreadable tree must not look like
            // "nothing on screen" — carry the read's own status with it.
            ...(state.accessibility !== undefined ? { accessibility: state.accessibility } : {}),
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
          layer: error instanceof CuaActionError ? error.layer : "server-manager",
          ...(error instanceof CuaActionError ? { effect: error.effect } : {}),
          requery_hint: INPUT_PAUSE_REQUERY_HINT,
          ...(error instanceof CuaActionError
            ? { cause: error.code, diagnostics: error.diagnostics }
            : {}),
          ...(error instanceof CuaActionError && error.waitSeconds !== undefined
            ? { wait_seconds: error.waitSeconds }
            : {}),
        }
      : error instanceof CuaActionError
        ? {
            code: error.code,
            effect: error.effect,
            message: error.message,
            retryAllowed: false,
            ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}),
            ...(error.layer ? { layer: error.layer } : {}),
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
    let stoppedReason: "no_usable_window" | undefined;
    // The window the last step touched scopes the closing state read.
    let lastWindowId: string | undefined;
    for (const [index, preparedStep] of prepared.entries()) {
      // Between steps, not just around the batch: a revocation or a dead turn
      // stops the run before the next dispatch, not after it.
      assertDesktopOperationActive();
      await Effect.runPromise(context.assertCallerTurnActive(), {
        signal: desktopOperationSignal(),
      });
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
          preparedStep.run,
        );
        if (
          typeof value === "object" &&
          value !== null &&
          typeof (value as { windowId?: unknown }).windowId === "string"
        ) {
          lastWindowId = (value as { windowId: string }).windowId;
        }
        steps.push({
          step: index,
          type: preparedStep.type,
          ok: true,
          result:
            typeof value === "object" && value !== null
              ? (({ computerId: _omitted, ...rest }) => rest)(value as Record<string, unknown>)
              : value,
        });
        if (
          preparedStep.type === "launch_app" &&
          (value as ComputerLaunchAppResult).windowStatus === "no_usable_window"
        ) {
          // Launch may have succeeded, but the next planned input has no
          // established target. Preserve its result; never call it unexecuted.
          stopped = true;
          stoppedReason = "no_usable_window";
          break;
        }
      } catch (error) {
        // A cancelled desktop operation or dead turn is the call ending, not a
        // step failing: propagate it rather than file it as batch data.
        desktopOperationSignal()?.throwIfAborted();
        await Effect.runPromise(context.assertCallerTurnActive(), {
          signal: desktopOperationSignal(),
        });
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
        assertDesktopOperationActive();
        const state = await manager.getState({
          includeTree: true,
          includeText: false,
          includeScreenshot: false,
          ...(lastWindowId ? { windowId: lastWindowId } : {}),
        });
        assertDesktopOperationActive();
        const { text: _text, root, screenshot: _screenshot, ...rest } = state;
        const elements = root
          ? actionableElements(root, lastWindowId === undefined ? {} : { windowId: lastWindowId })
          : undefined;
        const key = digestScopeKey(threadId, lastWindowId, undefined);
        const before = elementDigests.get(key);
        const stable = elements === undefined ? undefined : rememberDigest(threadId, key, elements);
        const wire = stable === undefined ? undefined : hoistElementWindowId(stable.items);
        return {
          ...(lastWindowId !== undefined && before !== undefined && stable !== undefined
            ? elementChangeFields(before, stable, 40)
            : {}),
          state: {
            ...rest,
            ...(stable !== undefined && wire !== undefined
              ? {
                  elements: wire.items,
                  ...(wire.elementWindowId === undefined
                    ? {}
                    : { elementWindowId: wire.elementWindowId }),
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
      ...(stoppedReason ? { stoppedReason } : {}),
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

  const batchStepTypeFor = (toolName: string): string | undefined => {
    const stepType = toolName.replace(/^computer_/, "");
    return Object.hasOwn(RUN_STEP_FIELDS, stepType) ? stepType : undefined;
  };

  /** Describe real provider routes; an index entry does not register a tool. */
  const computerToolIndexText = (): string => {
    const line = (entry: ToolEntry): string =>
      `- ${entry.definition.name}${
        typeof entry.definition.annotations?.title === "string"
          ? ` — ${entry.definition.annotations.title}`
          : ""
      }`;
    const catalog = [...entries, ...(options.relatedTools ?? [])];
    const hidden = catalog.filter((entry) => entry.discoveryOnly === true);
    return [
      "Advertised by the gateway:",
      ...catalog.filter((entry) => entry.discoveryOnly !== true).map(line),
      "",
      "Available as computer_run steps (read computer_help with tool for fields):",
      ...hidden.filter((entry) => batchStepTypeFor(entry.definition.name) !== undefined).map(line),
      "",
      "Available through computer_inspect (read computer_help with tool for fields):",
      ...hidden.filter((entry) => isInspectionToolName(entry.definition.name)).map(line),
      ...hidden
        .filter(
          (entry) =>
            batchStepTypeFor(entry.definition.name) === undefined &&
            !isInspectionToolName(entry.definition.name),
        )
        .map((entry) => `${line(entry)} (requires direct gateway access or a provider forwarder)`),
    ].join("\n");
  };

  // Named rather than returned inline so the computer_help handler can
  // generate its tools-chapter index from the catalog itself — a folded or
  // renamed tool can never leave the chapter naming something that no longer
  // exists.
  const entries: ToolEntry[] = [
    ...makeComputerSpaceTools({
      manager,
      handle,
      ...(options.resolveSpaceDesignation
        ? { resolveSpaceDesignation: options.resolveSpaceDesignation }
        : {}),
    }),
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
        description: `Read labeled controls and values before acting; prefer semantic targets. ${WINDOW_FOCUS_NOTE} Returns elements by default, without an image or duplicate text. Stable refs distinguish duplicates and remain bound to their original elements; use ref on later actions. A one-window listing hoists its id to elementWindowId. window_id scopes inspection; include_screenshot adds ${overviewScope} (or that window). ${SCREENSHOT_FRAME_NOTE} Use window_id or label_contains to narrow results marked elementsTruncated/elementsOmitted.`,
        inputSchema: {
          type: "object",
          properties: {
            include_screenshot: {
              type: "boolean",
              description: `Add a downscaled image of ${overviewScope} for x/y targeting or visual context. Default false.`,
            },
            include_text: {
              type: "boolean",
              description:
                "Add full accessibility text only when elements are insufficient. Default false; can be large.",
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
                "Filter elements by case-insensitive label substring, including truncated results.",
            },
            diff: {
              type: "boolean",
              description:
                "Return elementChanges (added/removed/changed) since this scope's last read (same window_id and label_contains); the first lists all as added. Position-only changes are omitted; inspect an image for layout.",
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
              ? elementChangeFields(before, stable)
              : (() => {
                  const wire = hoistElementWindowId(stable.items);
                  return {
                    elements: wire.items,
                    ...(wire.elementWindowId === undefined
                      ? {}
                      : { elementWindowId: wire.elementWindowId }),
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
                  };
                })()
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
        description: `Zoom into one part of the desktop when detail is too small to read in a screenshot you have. ${captureTargetNote} ${SCREENSHOT_FRAME_NOTE} A window that is off-screen or unmeasurable is refused rather than answered with pixels it cannot place; bring it forward with computer_activate_window first if the user asked to see it.`,
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
        description: `Wait for delayed content without sending input or changing focus. Prefer label plus window_id when you know the next control: duration_ms is then a maximum, and the tool returns as soon as that unique control appears, with a screenshot by default. Target it by label afterward so a layout change cannot leave stale coordinates. An unavailable accessibility tree returns immediately; use the screenshot and do not repeat semantic waits until the environment changes. Or pass settle:true plus window_id to return as soon as the window's accessibility surface stops changing — duration_ms is again the maximum — or after a fixed pause reported as mode:"fixed" when it cannot be watched. Without label or settle this is a fixed pause with no screenshot. Never repeat the preceding action merely because a page is still loading. Waiting is capped at ${COMPUTER_WAIT_MAX_MS} ms; one accessibility read may finish after the deadline.`,
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
      discoveryOnly: true,
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
      `Launch an application. ${launchAppNote(dialect)} Checks briefly for one unambiguous usable window and returns its id without a screenshot. windowStatus distinguishes readiness from launch delivery. no_usable_window must not trigger automatic relaunches.`,
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
              "Explicitly hide the launched app. Defaults to false on macOS: its windows remain available for background input without requesting activation. true may prevent the app from creating a usable window. This option never authorizes foreground input.",
          },
        },
        required: ["app"],
        additionalProperties: false,
      },
      async (args, context) => {
        const hidden = readBooleanArg(args, "hidden");
        // macOS launches without activating regardless of the hidden option.
        // Other backends retain their explicit visible-launch authorization.
        if (dialect !== "macos" && hidden === false) {
          const authorization = await foregroundAuthorization(context);
          if (!authorization.userRequestedVisibleUse) {
            throw new CuaActionError(
              "The user's task did not ask for this app to be shown; launching it visibly " +
                "would take their screen. Keep the launch in the background, or ask " +
                "the user to confirm they want to watch.",
              "not-dispatched",
              COMPUTER_FOREGROUND_NOT_REQUESTED_CODE,
            );
          }
        }
        const result = await manager.launchApp(
          context.callerThreadId,
          readStringArg(args, "app", { required: true })!,
          readStringArrayArg(args, "arguments") ?? [],
          readBooleanArg(args, "wait_for_window") === false ? 0 : 2_000,
          hidden !== undefined ? { hidden } : undefined,
        );
        return withLaunchGuidance(result);
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
      discoveryOnly: true,
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
      discoveryOnly: true,
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
      discoveryOnly: true,
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
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_inspect",
        description:
          "Inspect clipboard, a magnified window region, desktop inventory or cursor position. Read computer_help with the selected tool for its argument schema. Clipboard reads require task approval.",
        inputSchema: {
          type: "object",
          properties: {
            tool: { type: "string", enum: [...COMPUTER_INSPECTION_TOOL_NAMES] },
            arguments: {
              type: "object",
              description: "Arguments from that tool's schema; default {}.",
            },
          },
          required: ["tool"],
          additionalProperties: false,
        },
        annotations: {
          title: "Inspect the computer",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      handler: (args, context) =>
        Effect.suspend(() => {
          try {
            if (Object.keys(args).some((key) => key !== "tool" && key !== "arguments")) {
              throw new ToolInputError('computer_inspect accepts only "tool" and "arguments".');
            }
            const name = args.tool;
            if (typeof name !== "string" || !isInspectionToolName(name)) {
              throw new ToolInputError("Unknown Computer inspection tool.");
            }
            const entry = entries.find((candidate) => candidate.definition.name === name)!;
            const toolArgs = validateInspectionArguments(
              Object.hasOwn(args, "arguments") ? args.arguments : {},
              entry.definition,
            );
            // Delegate once: the canonical handler owns approval, cancellation,
            // queue admission and image delivery. No second lease or capture.
            return entry.handler(toolArgs, context);
          } catch (error) {
            return Effect.succeed(mcpToolResultError(errorText(error)));
          }
        }),
    },
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_help",
        description:
          "Read Computer guidance: no arguments lists chapters; topic reads one. Pass tool instead for its exact schema and computer_run or computer_inspect route. Lookup does not register a hidden tool with your provider.",
        inputSchema: {
          type: "object",
          properties: {
            topic: {
              type: "string",
              enum: [...COMPUTER_HELP_TOPICS, "all"],
              description:
                'Which chapter to read. Omit for the index of chapters; "all" reads every chapter.',
            },
            tool: {
              type: "string",
              description:
                'Exact desktop tool name, such as "computer_invoke_menu". Use instead of topic.',
            },
          },
          additionalProperties: false,
        },
        annotations: {
          title: "Computer playbook",
          ...READ_ONLY_TOOL_ANNOTATIONS,
        },
      },
      handler: handle("computer_help", async (args) => {
        const toolName = readStringArg(args, "tool");
        const topic = readStringArg(args, "topic");
        if (toolName !== undefined) {
          if (topic !== undefined) {
            throw new ToolInputError("Use either tool or topic, not both.");
          }
          const entry = [...entries, ...(options.relatedTools ?? [])].find(
            (candidate) => candidate.definition.name === toolName,
          );
          if (!entry) {
            throw new ToolInputError(
              `Unknown desktop tool "${toolName}". Read topic "tools" for the index.`,
            );
          }
          const stepType = batchStepTypeFor(toolName);
          return {
            definition: entry.definition,
            advertised: entry.discoveryOnly !== true,
            ...(stepType === undefined
              ? isInspectionToolName(toolName)
                ? {
                    inspection: {
                      name: "computer_inspect",
                      tool: toolName,
                      instruction: "Pass this schema's arguments in the arguments object.",
                    },
                  }
                : entry.discoveryOnly === true
                  ? {
                      availability:
                        "Requires direct gateway access or a provider forwarder; help does not register the tool.",
                    }
                  : {}
              : {
                  batchStep: {
                    type: stepType,
                    fields: [...RUN_STEP_FIELDS[stepType]!, ...RUN_CONDITION_FIELDS],
                    instruction:
                      "Use type plus these fields in computer_run.steps. The tool schema describes their values; per-step screenshots and delivery_mode are not supported.",
                  },
                }),
          };
        }
        // The tools chapter's static intro gains the generated catalog index
        // on the way out — same text for "tools" alone and inside "all".
        const sectionText = (name: string): string | undefined => {
          const text = COMPUTER_HELP_SECTIONS[name as ComputerHelpTopic];
          return name === "tools" && text !== undefined
            ? `${text}\n\n${computerToolIndexText()}`
            : text;
        };
        if (topic === undefined || topic === "all") {
          const chapters =
            topic === "all"
              ? Object.keys(COMPUTER_HELP_SECTIONS)
                  .map((name) => `## ${name}\n${sectionText(name)}`)
                  .join("\n\n")
              : undefined;
          return {
            ...(chapters !== undefined ? { chapters } : { topics: COMPUTER_HELP_INDEX }),
          };
        }
        const section = sectionText(topic);
        if (section === undefined) {
          throw new ToolInputError(
            `Unknown computer_help topic "${topic}". Topics: ${COMPUTER_HELP_TOPICS.join(", ")}, all.`,
          );
        }
        return { topic, text: section };
      }),
    },
    discoveryOnly(
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
    ),
    discoveryOnly(
      actionEntry(
        "computer_invoke_menu",
        "Invoke menu item",
        'Invoke an exact menu-bar path, e.g. ["File", "Save"]. This native route activates the app: it requires the user\'s explicit visible-use request, like computer_activate_window, even in computer_run. Name window_id or app/pid (for an app with no windows). One to six levels; missing or disabled items refuse. Observe afterwards; dispatch does not prove the command succeeded.',
        {
          type: "object",
          properties: {
            window_id: {
              type: "string",
              description: "A window owned by the app whose menu to invoke.",
            },
            app: {
              type: "string",
              description:
                "App name or bundle id, from computer_list_apps. Invokes the app's own menu bar without a window; pass either app or pid, not both.",
            },
            pid: {
              type: "number",
              description:
                "Running app's process id, from computer_list_apps. Invokes the app's own menu bar without a window; pass either app or pid, not both.",
            },
            path: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              maxItems: 6,
              description: 'Menu titles from the menu bar down, e.g. ["File", "Export As…"].',
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
        async (args, context) => {
          const target = readMenuTargetArg(args);
          const path = readMenuPathArg(args, "computer_invoke_menu");
          return withActionElementChanges(
            await manager.invokeMenu(
              context.callerThreadId,
              target,
              path,
              await foregroundAuthorization(context),
            ),
            context,
          );
        },
      ),
    ),
    discoveryOnly(
      actionEntry(
        "computer_kill_app",
        "Force-quit app",
        `Force-terminate the app that owns the exact window — the escalation after a cooperative close (computer_invoke_menu ["File","Quit"], or "cmd+q" via computer_press_key) has already failed. Unsaved state is lost and every window of that app closes; the kill is refused when the window no longer exists. ${DELIVERY_HINT}`,
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
    ),
    {
      // Not actionEntry on purpose: the visibility lifecycle never activates,
      // so advertising delivery_mode would promise a foreground excursion the
      // operation's whole contract is built to refuse.
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      discoveryOnly: true,
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
      discoveryOnly: true,
      definition: {
        name: "computer_set_app_visibility",
        description: `Hide or unhide a running application by pid — the explicit visibility control for when the user asks to get an app out of the way or bring it back. Every window stays open but leaves the screen, without activating, focusing, or switching Spaces, and the semantic tools keep working. The driver reads the hidden state back; confirmed means the readback matched, anything less means observe before relying on it. ${DELIVERY_HINT}`,
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
    observedActionEntry(
      "computer_click",
      "Click",
      `Click a coordinate or a uniquely labelled visible control — once, or as a double-/triple-click via count, with the secondary button via button:"right". Ambiguous and off-screen targets are refused. ${SEMANTIC_TARGETING_NOTE} ${POINTER_COORDINATE_HINT}`,
      clickSchema,
      async (args, context) =>
        manager.click(
          context.callerThreadId,
          readTarget(args, context),
          readModifiers(args),
          readClickGesture(args),
        ),
    ),
    discoveryOnly(
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
    ),
    discoveryOnly(
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
    ),
    observedActionEntry(
      "computer_scroll",
      "Scroll",
      `Scroll with delta_x and delta_y in screenshot pixels; omitted axes default to 0, e.g. {delta_y:300}. amount/direction are not supported. Requires a screenshot even without coordinates. Capped at half its width/height for overlap; scroll.limitedTo reports reductions. scroll.traveledY measures vertical movement; 0 may mean an edge or dropped input. Inspect the returned image before another scroll; use computer_get_state to find controls. ${POINTER_COORDINATE_HINT}`,
      {
        type: "object",
        properties: {
          ...pointerTargetProperties,
          ...MODIFIERS_PROPERTY,
          delta_x: {
            type: "number",
            description:
              "Horizontal scroll distance in screenshot pixels; defaults to 0. Positive scrolls toward the right of the content.",
          },
          delta_y: {
            type: "number",
            description:
              "Vertical scroll distance in screenshot pixels; defaults to 0. Positive scrolls toward the end of the content, the way a wheel notch pulled downward does.",
          },
        },
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
        const requestedDelta = readScrollDelta(args);
        const delta = screenshotDeltaToDesktop(frame, requestedDelta.deltaX, requestedDelta.deltaY);
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
              "An edge, a non-scrollable target or dropped delivery may explain it. Stop scrolling and call " +
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
        // Vertical correlation cannot rule out horizontal travel. Only a
        // vertical-only request or an identical full frame proves no observed
        // movement for the gesture as a whole.
        const noMovementObserved = willBeUnchanged || (limited.deltaX === 0 && traveledY === 0);
        if (noMovementObserved) {
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
        return {
          ...outcome,
          result: {
            ...outcome.result,
            ...(noMovementObserved
              ? {
                  scrollObservation: {
                    status: "no-visible-movement",
                    code: "scroll_noop",
                    ...(traveledY === undefined ? {} : { measuredDeltaY: traveledY }),
                    message:
                      "No content movement was observed. This may be an edge, a non-scrollable target, or dropped delivery. Inspect fresh state and choose a scrollable element; do not blindly repeat the wheel event.",
                  },
                }
              : {
                  scrollObservation:
                    traveledY !== undefined
                      ? { status: "movement-observed", measuredDeltaY: traveledY }
                      : { status: "unknown", reason: "movement_not_measurable" },
                }),
            ...(outcome.result.scroll &&
            (limited.deltaX !== delta.deltaX || limited.deltaY !== delta.deltaY)
              ? {
                  scroll: {
                    ...outcome.result.scroll,
                    requested: delta,
                    limitedTo: limited,
                  },
                }
              : {}),
          },
        };
      },
    ),
    observedActionEntry(
      "computer_type_text",
      "Type text",
      `Insert text through an exact writable ref or label in window_id; this focus-neutral route can run in different windows concurrently. Use computer_set_value to replace the whole field. window_id alone types into the app's focused field. Semantic writes do not send keydown/keyup: verify autocomplete or submission separately. Background physical keys may refuse on multi-window apps. ${KEYBOARD_TARGET_HINT} ${DELIVERY_HINT}`,
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
      `Press a key or chord such as "cmd+s". Pass the observed field ref for exact background Enter/Return. Other shortcuts can still refuse with same_pid_keyboard_ambiguity; use an advertised action instead of retrying. ${hotkeyFormNote(dialect)} ${KEYBOARD_TARGET_HINT} ${DELIVERY_HINT}`,
      {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: keyArgumentNote(dialect),
          },
          ...textTargetProperties,
        },
        required: ["key"],
        additionalProperties: false,
      },
      async (args, context) => {
        const { key, chord } = readKeyOrChord(args);
        const target = readTarget(args, context);
        const exact = target.label !== undefined || target.role !== undefined ? target : undefined;
        return chord === undefined
          ? manager.pressKey(context.callerThreadId, key, target.windowId, exact)
          : manager.hotkey(context.callerThreadId, chord, target.windowId, exact);
      },
    ),
    discoveryOnly(
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
      "Bring a window into view and aim the agent keyboard at it — only when the user's own task text asked to see the screen; otherwise refused with foreground_not_requested (naming an app is not asking to see it). Ordinary background targeting does not activate a window. A desktop that cannot raise the window refuses. It returns no screenshot; observe with computer_screenshot or computer_get_state when needed.",
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
        // Never-raise default: the user's own task text must have asked to see
        // the screen before this tool can move a window in front of them.
        return manager.foregroundWithRestore(
          context.callerThreadId,
          windowId,
          undefined,
          await foregroundAuthorization(context),
        );
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
    discoveryOnly(
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
    ),
    discoveryOnly(
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
    ),
    actionEntry(
      "computer_run",
      "Run computer actions",
      'Batch up to 25 known desktop steps in one call, such as {"steps":[{"type":"press_key","key":"tab","window_id":"..."}]}. Each step uses type plus the matching computer_ tool fields; computer_help({tool:"computer_" + type}) lists exact fields. All steps are validated before dispatch and keep targeting, consent and refusal checks. Read state before acting; use get_state or if_element/unless_element for changes between steps. Stops on failure unless continue_on_error:true. No per-step screenshots or browser steps; an optional final screenshot covers the affected window.',
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
              properties: {
                type: { type: "string", enum: Object.keys(RUN_STEP_FIELDS) },
              },
              // Details are loaded through computer_help when needed; the
              // existing per-kind parser still rejects unsupported fields
              // and malformed values for the entire batch before dispatch.
              additionalProperties: true,
            },
            description:
              "Ordered steps; read computer_help with the matching tool for allowed fields.",
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
  ];
  return entries;
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
 * What a chord may contain, which is not the same question on the two
 * families: macOS throws unless exactly one key is not a modifier, and Linux
 * presses every key at once and releases them in reverse. Neither treats the
 * chord as a sequence of separate keystrokes, so the note says so on both.
 */
function hotkeyFormNote(dialect: ComputerAgentDialect): string {
  return dialect === "macos"
    ? 'A chord is one or more modifiers plus exactly one other key, pressed together and released together — "meta+s" to save, "meta+shift+z" to redo. More than one non-modifier key is refused; to press two shortcuts, call this twice.'
    : 'A chord presses every key in the order given, holds them, then releases in reverse — "ctrl+s" to save, "ctrl+shift+z" to redo. It is not a sequence of separate keystrokes: to press two shortcuts, call this twice.';
}

function keyArgumentNote(dialect: ComputerAgentDialect): string {
  return dialect === "macos"
    ? 'One key name — "enter", "escape", "tab", "backspace", "delete" (forward delete), "home", "end", "pageup", "pagedown", an arrow ("arrowdown" or "down"), "f1"-"f12", a modifier ("command", "shift", "option", "ctrl", "fn", "capslock"), or a single printable character — or one chord joined with "+", modifiers first: "meta" (Command), "ctrl", "alt" (Option), "shift" or "fn", then exactly one other key, as in "meta+s" or "meta+shift+z". xdotool spellings such as "page_up" and "caps_lock" are accepted. "insert" is refused — macOS has no Insert key; "kp_*" keypad keys, "f13"-"f20", "menu" and "help" need the extended keymap.'
    : 'One key name — "enter", "escape", "tab", "backspace", "delete", "home", "end", "pageup", "pagedown", an arrow, "f1"-"f12", a modifier, or a single printable character — or one chord joined with "+", modifiers first: "ctrl", "alt", "shift" or "meta" (Super), then the key they apply to, as in "ctrl+s" or "ctrl+shift+z".';
}

function launchAppNote(dialect: ComputerAgentDialect): string {
  return dialect === "macos"
    ? "Names an application the way macOS does. A normal launch requests no foreground activation and keeps its windows available for background input. hidden:true explicitly hides the app and may create no usable window. Reuse the returned process/window; never kill or relaunch it merely because readiness is delayed."
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
    ? "On macOS an exact-target drag uses the driver's window-local background delivery. Surfaces that drop background events report an unverifiable result: observe the result and never replay the drag or switch to foreground automatically. The duration is limited to 10 seconds and both endpoints must stay inside the exact target window. Verify the drop from the returned screenshot."
    : "This desktop injects the drag at screen coordinates, so it works for anything the pointer can sweep — selecting text, moving a slider — but cross-application drag-and-drop and dragging a window by its titlebar are handled by the compositor and may not follow. Check the result with computer_screenshot rather than assuming the drop landed.";
}

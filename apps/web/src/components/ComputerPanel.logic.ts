import {
  COMPUTER_MAC_BACKEND,
  COMPUTER_NESTED_KWIN_BACKEND,
  type ComputerActionEvent,
  type ComputerAvailability,
  type ComputerFrameHeader,
  type ComputerHealth,
  type ComputerStatusResult,
  type ComputerWindow,
  type ThreadComputerState,
} from "@synara/contracts";
import { listComputerPermissions } from "@synara/shared/computerGrants";
import { COMPUTER_TOOL_TITLES, computerToolName } from "../lib/computerToolPresentation";

export interface ComputerFrameGateState {
  readonly lastSequence: number | null;
}

export type ComputerFrameGateAction = "ignore" | "drop-stale" | "decode";

export interface ComputerFrameGateStep {
  readonly state: ComputerFrameGateState;
  readonly action: ComputerFrameGateAction;
  readonly requestResync: boolean;
}

const UINT32_MODULUS = 0x1_0000_0000;
const UINT32_HALF_RANGE = 0x8000_0000;

export function createComputerFrameGateState(): ComputerFrameGateState {
  return { lastSequence: null };
}

export function stepComputerFrameGate(
  state: ComputerFrameGateState,
  header: Pick<ComputerFrameHeader, "computerId" | "sequence">,
  expectedComputerId: string,
): ComputerFrameGateStep {
  if (header.computerId !== expectedComputerId) {
    return { state, action: "ignore", requestResync: false };
  }

  if (state.lastSequence === null) {
    return { state: { lastSequence: header.sequence }, action: "decode", requestResync: false };
  }

  const distance = (header.sequence - state.lastSequence + UINT32_MODULUS) % UINT32_MODULUS;
  if (distance === 0 || distance >= UINT32_HALF_RANGE) {
    return { state, action: "drop-stale", requestResync: false };
  }

  return {
    state: { lastSequence: header.sequence },
    action: "decode",
    requestResync: distance > 1,
  };
}

/**
 * A backend that has never connected and never failed is not broken — it is
 * idle. The server does not connect at boot, so after every launch health
 * reads non-connected with a clean record until something uses the desktop.
 */
export function computerBackendIsIdle(health: ComputerHealth | undefined): boolean {
  return (
    health?.status === "unavailable" &&
    health.consecutiveFailures === 0 &&
    health.lastFailure === undefined
  );
}

export type ComputerAvailabilityView =
  | { readonly kind: "checking"; readonly title: string; readonly description: string }
  | { readonly kind: "ready"; readonly title: string; readonly description: string }
  | {
      readonly kind: "blocked";
      readonly title: string;
      readonly description: string;
    };

/**
 * `grantsConfirmed` is fresh evidence from the OS itself (the desktop app's
 * native grant check) that every permission is granted. The server cannot
 * know that before its backend starts, which happens only when something uses
 * the desktop, so without it an idle backend stays "not checked".
 */
export function resolveComputerAvailabilityView(
  availability: ComputerAvailability | undefined,
  health?: ComputerHealth,
  grantsConfirmed = false,
): ComputerAvailabilityView {
  // A pending retry is not a dead desktop, and the viewport must not say it is:
  // the frames stop either way, but one of the two states ends by itself.
  if (health?.status === "reconnecting") {
    return {
      kind: "checking",
      title: "Reconnecting to the desktop",
      description: health.lastFailure ? health.lastFailure.message : COMPUTER_RECONNECTING_NOTE,
    };
  }
  if (!availability) {
    return {
      kind: "checking",
      title: "Checking computer availability",
      description: "Waiting for the desktop backend.",
    };
  }
  if (availability.kind === "available") {
    if (grantsConfirmed && computerBackendIsIdle(health)) {
      return {
        kind: "ready",
        title: "All permissions granted",
        description: "Synara connects to the desktop the next time an agent uses it.",
      };
    }
    if (health && health.status !== "connected") {
      return {
        kind: "checking",
        title: "Computer access has not been checked",
        description: "Choose Set up to check that Synara can see and control the desktop.",
      };
    }
    if (health?.captureAvailable === false) {
      return {
        kind: "blocked",
        title: "Screen capture is unavailable",
        description:
          "Desktop input is connected, but Synara cannot take screenshots. Choose Set up to check access.",
      };
    }
    return {
      kind: "ready",
      title: "Connected to the desktop",
      description: "Synara can see and control the desktop through its computer tools.",
    };
  }
  if (availability.kind === "unsupported-platform") {
    return {
      kind: "blocked",
      title: "Computer control is unavailable",
      description: `This server is running on ${availability.platform}. Computer control needs macOS, or a Wayland desktop on Linux — KWin or Hyprland, or Synara's own nested desktop.`,
    };
  }
  // A withheld grant is blocked like anything else, but it is the one blocked
  // state with a name and a fix, so the title says which permission rather than
  // making the user read the paragraph to find out.
  if (availability.kind === "permission-required") {
    return {
      kind: "blocked",
      title: `Computer control needs ${listComputerPermissions(availability.missing)}`,
      description: availability.message,
    };
  }
  return {
    kind: "blocked",
    title: "Computer control is unavailable",
    description: availability.message,
  };
}

/**
 * Whether this desktop still needs something installed or granted — the test
 * behind the settings panel's "Set up" button and behind the chat setup card's
 * "did that work?" answer, which must agree.
 *
 * Keyed on live state, never on the static capability flags alone. Those
 * describe what the backend *is able to* do — on macOS the helper advertises
 * input and capture on a machine that has been granted neither, so a
 * capabilities-only test never offers Set up at all. What separates "nothing to
 * do" from "not ready" is whether a backend resolved, whether it can currently
 * capture, and only then whether it claims the two abilities. A platform that
 * can never run this is not a machine with something left to install.
 *
 * Uses the status fields available on thread snapshots, plus the optional
 * provisioning hint. The thread-scoped state a chat receives by push has to
 * be answerable by the same question — the chat's setup card reads the live
 * thread state, the settings panel reads the polled status, and a second copy
 * of this rule for the other shape is how they would start disagreeing.
 */
export type ComputerSetupProbe = Pick<
  ComputerStatusResult,
  "availability" | "health" | "capabilities" | "provisionable"
>;

export function computerStatusNeedsSetup(
  status: ComputerSetupProbe | undefined,
  grantsConfirmed = false,
): boolean {
  if (!status) return false;
  if (status.availability.kind === "unsupported-platform") return false;
  // An idle backend's placeholder health proves nothing either way; only the
  // OS's own answer that every grant is in place lets it skip Set up.
  const idle = grantsConfirmed && computerBackendIsIdle(status.health);
  return (
    (status.provisionable === true && status.health.status !== "connected" && !idle) ||
    status.availability.kind === "backend-unavailable" ||
    status.availability.kind === "permission-required" ||
    (status.health.captureAvailable === false && !idle) ||
    !status.capabilities.input ||
    !status.capabilities.capture
  );
}

/**
 * How a non-connected backend is described, in one place.
 *
 * Three surfaces said this — the pane's blocked view, the header badge's
 * tooltip, and the settings panel's health notes — and three copies is three
 * chances to describe the same supervision state differently.
 */
export const COMPUTER_RECONNECTING_NOTE =
  "The desktop backend dropped out and is being reconnected.";

/** The note counting reconnects since startup, or null when there were none. */
export function computerReconnectsNote(health: ComputerHealth | undefined): string | null {
  const reconnects = health?.reconnects ?? 0;
  if (reconnects <= 0) return null;
  return `Reconnected ${reconnects === 1 ? "once" : `${reconnects} times`} since startup.`;
}

/**
 * What the canvas is a picture of, for a screen reader.
 *
 * It said "Linux desktop" on every backend, including the Mac one, which is
 * both wrong and the single most important fact about the surface: whether the
 * agent is driving a sandbox or the machine the user is sitting at.
 */
export function computerCanvasLabel(input: {
  readonly availability: ComputerAvailability | undefined;
  readonly visibleDesktop: boolean;
}): string {
  const backend = input.availability?.kind === "available" ? input.availability.backend : undefined;
  if (backend === COMPUTER_MAC_BACKEND) return "This Mac's desktop";
  if (backend === COMPUTER_NESTED_KWIN_BACKEND) return "The agent's own desktop";
  if (input.visibleDesktop) return "This computer's desktop";
  return "The agent's desktop";
}

/**
 * The newest desktop action, in the words a person would use.
 *
 * The backend's `action` is a tool-shaped identifier (`computer_click`,
 * `type_text`) and the pane is not a log viewer, so it is spoken rather than
 * printed. A failure keeps its message, because that is the only part of a
 * failed action worth the space.
 */
export function computerActionLabel(
  action: Pick<ComputerActionEvent, "action" | "ok" | "message"> | undefined,
): string | null {
  if (!action) return null;
  const tool = computerToolName(action.action);
  const fallback = action.action
    .replace(/^computer[_.]/, "")
    .replace(/[_.]+/g, " ")
    .trim();
  if (!tool && fallback.length === 0) return null;
  const label = tool
    ? COMPUTER_TOOL_TITLES[tool]
    : `${fallback[0]!.toUpperCase()}${fallback.slice(1)}`;
  if (action.ok) return label;
  return action.message ? `${label} failed: ${action.message}` : `${label} failed`;
}

export function shouldSubscribeToComputerStream(input: {
  readonly runtimeMode: "live" | "preview";
  readonly isVisible: boolean;
  readonly threadState: ThreadComputerState | undefined;
}): boolean {
  return (
    input.runtimeMode === "live" &&
    input.isVisible &&
    input.threadState?.availability.kind === "available"
  );
}

/** The action, target application, and actual delivery mode for the desktop overlay. */
export function computerActionStatusLabel(
  action: ComputerActionEvent | undefined,
  windows: readonly ComputerWindow[] | undefined,
): string | null {
  const label = computerActionLabel(action);
  if (!label) return null;
  const app = windows?.find((window) => window.id === action?.windowId)?.appName;
  const path = action?.delivery?.path;
  const delivery = path
    ? path.includes("foreground")
      ? "Temporary foreground"
      : "Background action"
    : undefined;
  return [label, app, delivery].filter(Boolean).join(" · ");
}

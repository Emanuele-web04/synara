// FILE: computerProvisioning.ts
// Purpose: One vocabulary for "set up computer control" — the toasts the chat card
//          raises, the inline note the settings panel renders, and the rule for what
//          counts as done. Pure so both surfaces can be pinned by tests.
// Layer: Web UI logic
// Exports: computerProvisionOutcome, computerProvisionStartToast, computerProvisionResultToast,
//          computerProvisionNote
//
// The card and the panel used to each own a private copy of this flow, and they
// said different things about the same server call: one raised a toast the other
// did not, one had no pending state, and the two could fire the underlying
// provision concurrently. The state machine lives in `useProvisionComputer`; the
// words live here.

import type {
  ComputerPermission,
  ComputerProvisionResult,
  DesktopAppSnapPermissionKind,
  DesktopAppSnapState,
  DesktopBridge,
} from "@synara/contracts";
import {
  COMPUTER_PERMISSION_KINDS,
  listComputerPermissions,
  missingComputerAppSnapPermissions,
} from "@synara/shared/computerGrants";

import { computerStatusNeedsSetup } from "~/components/ComputerPanel.logic";
import { isLoopbackHostname } from "~/components/Sidebar.logic";

/** The desktop bridge identifies its live server; remote servers own their own grants. */
export function readLocalComputerPermissionBridge(): DesktopBridge["appSnap"] | null {
  // An injected NativeApi can target a different host than the desktop bridge.
  if (globalThis.window?.nativeApi) return null;
  const bridge = globalThis.window?.desktopBridge;
  if (!bridge?.appSnap) return null;
  try {
    const endpoint = bridge.getWsUrl?.();
    if (!endpoint) return null;
    const url = new URL(endpoint);
    return (url.protocol === "ws:" || url.protocol === "wss:") && isLoopbackHostname(url.hostname)
      ? bridge.appSnap
      : null;
  } catch {
    return null;
  }
}

export function computerPermissionSetupSupported(state: DesktopAppSnapState | null): boolean {
  return state?.supported === true && state.platform === "macos";
}

/** One fresh, explicit activation check; ordinary sends do not call this. */
export async function prepareComputerPermissionGuide(input: {
  readonly getPermissionState?: (
    permissions: readonly DesktopAppSnapPermissionKind[],
  ) => Promise<DesktopAppSnapState>;
  readonly startPermissionSetup?: (
    permissions: readonly DesktopAppSnapPermissionKind[],
  ) => Promise<unknown>;
  readonly isCurrent: () => boolean;
}): Promise<boolean> {
  if (!input.getPermissionState || !input.startPermissionSetup) return input.isCurrent();
  if (!input.isCurrent()) return false;
  const state = await input.getPermissionState(COMPUTER_PERMISSION_KINDS);
  if (!input.isCurrent()) return false;
  if (!computerPermissionSetupSupported(state)) return true;
  if (missingComputerAppSnapPermissions(state).length === 0) return true;
  await input.startPermissionSetup(COMPUTER_PERMISSION_KINDS);
  return false; // Preserve the draft; granting access never auto-sends the task.
}

/** What the server's answer means for the user, once. */
export type ComputerProvisionOutcome = "ready" | "incomplete";

export function computerProvisionOutcome(
  result: ComputerProvisionResult,
): ComputerProvisionOutcome {
  return result.status.availability.kind === "available" &&
    result.status.health.status === "connected" &&
    !computerStatusNeedsSetup(result.status)
    ? "ready"
    : "incomplete";
}

export interface ComputerProvisionToast {
  readonly type: "info" | "success" | "warning" | "error";
  readonly title: string;
  readonly description: string;
}

/**
 * Raised as the call starts, because the call's visible effect is a macOS
 * dialog appearing over Synara and the user needs to know Synara asked for it.
 *
 * The grants are named through `listComputerPermissions` rather than written
 * out, so this cannot drift out of the one fixed ordering every other surface
 * uses — a hand-written "Screen Recording and Accessibility" here against
 * "Accessibility and Screen Recording" in the card is exactly the divergence
 * that module exists to prevent.
 */
export function computerProvisionStartToast(
  missing: readonly ComputerPermission[] = [],
): ComputerProvisionToast {
  const labels = listComputerPermissions(missing);
  return {
    type: "info",
    title: "Setting up computer control",
    description:
      labels.length > 0
        ? `macOS may ask to allow ${labels} for Synara.`
        : "Setting up the desktop may require installing a helper or allowing the permissions Synara needs.",
  };
}

/** The one answer, whichever surface asked. */
export function computerProvisionResultToast(
  result: ComputerProvisionResult,
): ComputerProvisionToast {
  return computerProvisionOutcome(result) === "ready"
    ? { type: "success", title: "Computer control is ready", description: result.summary }
    : {
        type: "warning",
        title: "Computer control still needs setup",
        description: result.summary,
      };
}

export function computerProvisionErrorToast(error: unknown): ComputerProvisionToast {
  return {
    type: "error",
    title: "Couldn't set up computer control",
    description: provisionErrorMessage(error),
  };
}

export function provisionErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "The server gave no reason.";
}

/**
 * The settings panel's inline status line — the same three states the toasts
 * describe, for a surface that has room to keep them on screen.
 */
export function computerProvisionNote(state: {
  readonly isPending: boolean;
  readonly missing?: readonly ComputerPermission[];
  readonly error?: unknown;
  readonly result?: ComputerProvisionResult | undefined;
}): string | undefined {
  if (state.isPending) {
    if (state.missing?.length) {
      return `Checking ${listComputerPermissions(state.missing)}. Allow access in the macOS prompt or System Settings, then return to Synara.`;
    }
    return (
      "Setting up the agent's desktop. This installs or builds whatever this machine still needs, " +
      "and may ask for your password or for desktop permissions. The first run can take a few minutes."
    );
  }
  if (state.error !== undefined && state.error !== null) {
    return `Setting up failed. ${provisionErrorMessage(state.error)}`;
  }
  return state.result?.summary;
}

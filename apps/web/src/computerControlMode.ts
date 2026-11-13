import { readExecutionContext } from "./lib/hosts/executionContext";

/** Explicit composer intent, independent of permission grants and active work. */
export type ComposerComputerControlMode = "off" | "request" | "chat";
export function resolveComputerControlMode(
  mode: ComposerComputerControlMode | undefined,
  legacyEnabled?: boolean,
): ComposerComputerControlMode {
  return mode ?? (legacyEnabled === true ? "chat" : "off");
}

/**
 * The machine-wide "use the computer in new chats" default belongs to this computer.
 * A remote host refuses computer control, so applying it there would reject every send.
 */
export function resolveComputerControlDefault(settingEnabled: boolean): boolean {
  return settingEnabled && !readExecutionContext()?.remote;
}

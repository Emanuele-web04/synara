import { isElectron } from "../../env";
import { readWorkspaceFrame } from "./workspaceFrame";

/** Presentation belongs to the controller; this never grants its native API to a remote task. */
export const isDesktopPresentation =
  isElectron || readWorkspaceFrame()?.controller.desktop === true;

/** A pane's width must not turn a desktop window into a mobile device. */
export function presentationWindow(): Window | undefined {
  if (typeof window === "undefined") return undefined;
  return readWorkspaceFrame() ? window.parent : window;
}

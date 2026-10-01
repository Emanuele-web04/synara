import { COMPUTER_WS_METHODS, DEVICE_WS_METHODS, WS_METHODS } from "@synara/contracts";

export const REMOTE_NATIVE_UNAVAILABLE =
  "This feature is unavailable for remote workspaces. Return to this computer to use it locally.";

const unavailableMethods = new Set<string>([
  ...Object.values(COMPUTER_WS_METHODS),
  ...Object.values(DEVICE_WS_METHODS),
  WS_METHODS.projectsRunDevServer,
  WS_METHODS.projectsStopDevServer,
  WS_METHODS.projectsListDevServers,
  WS_METHODS.shellOpenInEditor,
]);

/** Both the controller UI and the authenticated host enforce this boundary. */
export function remoteMethodUnavailable(method: string): boolean {
  return unavailableMethods.has(method);
}

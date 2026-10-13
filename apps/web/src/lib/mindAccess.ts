import type { AuthSessionState } from "@synara/contracts";

/**
 * Local auth-disabled servers grant the workspace owner role at the WebSocket
 * boundary without creating an HTTP browser session. Paired clients still
 * need an explicit owner role.
 */
export function canAccessMind(session: AuthSessionState | undefined): boolean {
  if (session?.role === "owner") return true;
  return session?.authenticated === false && session.auth.authEnabled === false;
}

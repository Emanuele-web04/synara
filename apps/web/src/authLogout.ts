import { AUTH_SIGNED_OUT_PATH } from "./authSignedOut";
import { clearThreadDetailCache } from "./threadDetailCache";

export type AuthLogoutFlowResult = "cancelled" | "failed" | "redirecting";

export async function logoutCurrentBrowserSession(input: {
  readonly confirm: () => Promise<boolean>;
  readonly logout: () => Promise<unknown>;
  readonly navigate: (path: string) => void;
  readonly onError: (error: unknown) => void;
}): Promise<AuthLogoutFlowResult> {
  if (!(await input.confirm())) return "cancelled";
  try {
    await input.logout();
    // Cached thread detail is per-user data; a signed-out browser must not
    // keep another session's transcripts on this disk.
    await clearThreadDetailCache();
    input.navigate(AUTH_SIGNED_OUT_PATH);
    return "redirecting";
  } catch (error) {
    input.onError(error);
    return "failed";
  }
}

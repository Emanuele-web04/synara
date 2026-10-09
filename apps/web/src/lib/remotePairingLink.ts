/** A short-lived invitation, never an account credential or an authorization grant. */
export function remotePairingLink(
  authority: string | undefined,
  invitation: { code: string; rootFingerprint: string; expiresAt: string },
): string | null {
  if (!authority) return null;
  try {
    const account = new URL(authority);
    if (
      account.protocol !== "https:" ||
      account.username ||
      account.password ||
      account.search ||
      account.hash ||
      !["", "/", "/api/v1"].includes(account.pathname)
    )
      return null;
    const payload = new URLSearchParams({
      v: "1",
      account: account.origin,
      code: invitation.code,
      fingerprint: invitation.rootFingerprint,
      expires: invitation.expiresAt,
    });
    return `synara://connect#${payload}`;
  } catch {
    return null;
  }
}

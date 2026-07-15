/**
 * Canonical GitHub avatar URL derived from an account login. The GitHub CLI's JSON output
 * never includes avatar URLs, so server-side actor normalizers derive a login-addressed URL
 * here when — and only when — GitHub identified the actor as a user. Renderers must preserve a
 * null URL because the actor login field can also carry a Team slug.
 * GitHub App actors ("app/<slug>") have no login-addressable avatar endpoint and resolve to
 * null so callers fall back to an initials treatment.
 */
export function githubAvatarUrlForLogin(login: string | null | undefined): string | null {
  const trimmed = login?.trim();
  if (!trimmed || trimmed.startsWith("app/")) return null;
  return `https://avatars.githubusercontent.com/${encodeURIComponent(trimmed)}?size=64`;
}

/** gh's JSON never includes avatar URLs — derive one only when GitHub identified the actor as a user (a Team slug or app/<slug> resolves to null so callers fall back to initials) */
export function githubAvatarUrlForLogin(login: string | null | undefined): string | null {
  const trimmed = login?.trim();
  if (!trimmed || trimmed.startsWith("app/")) return null;
  return `https://avatars.githubusercontent.com/${encodeURIComponent(trimmed)}?size=64`;
}

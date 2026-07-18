import type { GitHubAccountSelection } from "@synara/contracts";

export function githubAccountIdentityKey(
  account: GitHubAccountSelection | null | undefined,
): string {
  return JSON.stringify([
    account?.host.trim().toLowerCase() ?? null,
    account?.login.trim().toLowerCase() ?? null,
  ]);
}

export function githubAccountScopedCacheKey(
  account: GitHubAccountSelection | null | undefined,
  key: string,
): string {
  return `${githubAccountIdentityKey(account)}\u0000${key}`;
}

export function stripGithubAccountCacheScope(
  scopedKey: string,
  account: GitHubAccountSelection | null | undefined,
): string | null {
  const prefix = `${githubAccountIdentityKey(account)}\u0000`;
  return scopedKey.startsWith(prefix) ? scopedKey.slice(prefix.length) : null;
}

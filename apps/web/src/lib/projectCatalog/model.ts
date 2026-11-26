import type { ProjectAppearance } from "../projectAppearance";

export interface CheckoutRef {
  environmentId: string;
  projectId: string;
}
export interface ThreadRef {
  environmentId: string;
  threadId: string;
}
export interface CatalogCheckout extends CheckoutRef {
  name: string;
  cwd: string;
  hostName: string;
  channel: string;
  hostId?: string;
  observedAt: string;
  repositoryUrls: string[];
  missing?: boolean;
}
export interface LogicalProject {
  id: string;
  name: string;
  appearance: ProjectAppearance | null;
  members: CheckoutRef[];
  preferredCheckout?: CheckoutRef;
}
export interface ProjectCatalog {
  version: 1;
  checkouts: CatalogCheckout[];
  groups: LogicalProject[];
  excludedPairs: string[];
}
export const emptyCatalog = (): ProjectCatalog => ({
  version: 1,
  checkouts: [],
  groups: [],
  excludedPairs: [],
});
export const checkoutKey = (ref: CheckoutRef): string =>
  JSON.stringify([ref.environmentId, ref.projectId]);
const pairKey = (a: CheckoutRef, b: CheckoutRef) =>
  JSON.stringify([checkoutKey(a), checkoutKey(b)].toSorted());

/** Unknown servers retain scheme, port and path case: uncertainty never creates equivalence. */
export function repositoryIdentity(raw: string): string | null {
  if (/(?:^|\/)\.\.?(?:\/|$)/.test(raw) || raw.includes("%") || raw.includes("\\")) return null;
  const scp = /^([^/@:]+@)?([^/:]+):([^/].*)$/.exec(raw);
  let url: URL;
  try {
    url = new URL(scp && !raw.includes("://") ? `ssh://${scp[1] ?? ""}${scp[2]}/${scp[3]}` : raw);
  } catch {
    return null;
  }
  if (!["ssh:", "https:", "http:", "git:"].includes(url.protocol) || url.search || url.hash)
    return null;
  const known = ["github.com", "gitlab.com", "bitbucket.org"].includes(url.hostname.toLowerCase());
  const path =
    known && !url.port ? url.pathname.replace(/\/+$/, "").replace(/\.git$/, "") : url.pathname;
  if (!path || path === "/" || path.includes("%") || path.includes("/../")) return null;
  if (known && !url.port) {
    const parts = path.slice(1).split("/");
    if (parts.length < 2 || parts.some((part) => !part)) return null;
    return `${url.hostname.toLowerCase()}${url.hostname === "github.com" ? path.toLowerCase() : path}`;
  }
  return `${url.protocol}//${url.host}${path}`;
}

export function observeCheckouts(
  catalog: ProjectCatalog,
  environmentId: string,
  incoming: CatalogCheckout[],
): ProjectCatalog {
  const byKey = new Map(incoming.map((checkout) => [checkoutKey(checkout), checkout]));
  const checkouts = catalog.checkouts.map((previous) => {
    const next = byKey.get(checkoutKey(previous));
    if (next) {
      byKey.delete(checkoutKey(previous));
      return { ...next, repositoryUrls: previous.cwd === next.cwd ? previous.repositoryUrls : [] };
    }
    return previous.environmentId === environmentId ? { ...previous, missing: true } : previous;
  });
  return { ...catalog, checkouts: [...checkouts, ...byKey.values()] };
}

export function catalogSuggestions(catalog: ProjectCatalog): [CatalogCheckout, CatalogCheckout][] {
  const suggestions: [CatalogCheckout, CatalogCheckout][] = [];
  const eligible = catalog.checkouts.filter(
    (item) => !item.missing && item.repositoryUrls.length === 1,
  );
  for (let i = 0; i < eligible.length; i++)
    for (let j = i + 1; j < eligible.length; j++) {
      const a = eligible[i]!;
      const b = eligible[j]!;
      const identity = repositoryIdentity(a.repositoryUrls[0]!);
      if (
        !identity ||
        identity !== repositoryIdentity(b.repositoryUrls[0]!) ||
        catalog.excludedPairs.includes(pairKey(a, b))
      )
        continue;
      if (
        catalog.groups.some(
          (group) =>
            group.members.some((ref) => checkoutKey(ref) === checkoutKey(a)) &&
            group.members.some((ref) => checkoutKey(ref) === checkoutKey(b)),
        )
      )
        continue;
      suggestions.push([a, b]);
    }
  return suggestions;
}

export function excludeSuggestion(
  catalog: ProjectCatalog,
  a: CheckoutRef,
  b: CheckoutRef,
): ProjectCatalog {
  return { ...catalog, excludedPairs: [...new Set([...catalog.excludedPairs, pairKey(a, b)])] };
}
export function linkCheckouts(
  catalog: ProjectCatalog,
  refs: CheckoutRef[],
  name: string,
  id: string,
): ProjectCatalog {
  const unique = [...new Map(refs.map((ref) => [checkoutKey(ref), ref])).values()];
  if (
    unique.length < 2 ||
    !name.trim() ||
    unique.some((ref) => !catalog.checkouts.some((item) => checkoutKey(item) === checkoutKey(ref)))
  )
    throw new Error("Select at least two known checkouts and a group name.");
  // Linking is an explicit reassignment. No checkout acquires another checkout's path or threads.
  const selected = new Set(unique.map(checkoutKey));
  const groups = catalog.groups
    .map((group) => {
      const members = group.members.filter((ref) => !selected.has(checkoutKey(ref)));
      const { preferredCheckout, ...rest } = group;
      return {
        ...rest,
        members,
        ...(preferredCheckout &&
        members.some((ref) => checkoutKey(ref) === checkoutKey(preferredCheckout))
          ? { preferredCheckout }
          : {}),
      };
    })
    .filter((group) => group.members.length > 0);
  return {
    ...catalog,
    groups: [
      ...groups,
      {
        id,
        name: name.trim(),
        appearance: null,
        members: unique.map(({ environmentId, projectId }) => ({ environmentId, projectId })),
      },
    ],
  };
}
export function unlinkCheckout(
  catalog: ProjectCatalog,
  groupId: string,
  ref: CheckoutRef,
): ProjectCatalog {
  const group = catalog.groups.find((item) => item.id === groupId);
  let next = catalog;
  for (const other of group?.members ?? [])
    if (checkoutKey(other) !== checkoutKey(ref)) next = excludeSuggestion(next, ref, other);
  return {
    ...next,
    groups: next.groups.flatMap((item) => {
      if (item.id !== groupId) return [item];
      const members = item.members.filter((member) => checkoutKey(member) !== checkoutKey(ref));
      const { preferredCheckout, ...rest } = item;
      return members.length
        ? [
            {
              ...rest,
              members,
              ...(preferredCheckout && checkoutKey(preferredCheckout) !== checkoutKey(ref)
                ? { preferredCheckout }
                : {}),
            },
          ]
        : [];
    }),
  };
}
export function splitGroup(catalog: ProjectCatalog, groupId: string): ProjectCatalog {
  let next = catalog;
  for (const ref of catalog.groups.find((group) => group.id === groupId)?.members ?? [])
    next = unlinkCheckout(next, groupId, ref);
  return next;
}

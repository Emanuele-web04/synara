// FILE: designCanvasPages.ts
// Purpose: A canvas work's page list as one ordered run of pages and dividers,
//          and back. Works store pages in their order plus each divider's anchor,
//          so page order stays where every older reader looks for it.
// Layer: Shared runtime (server store and web page lists)
// Exports: canvasPageList, canvasPageListParts, moveCanvasPageListItem, CanvasPageListItem

import type { CanvasPageDivider } from "@synara/contracts";

export type CanvasPageListItem<P extends { readonly id: string }> =
  | { readonly kind: "page"; readonly id: string; readonly page: P }
  | { readonly kind: "divider"; readonly id: string };

/**
 * The page list in display order: the pages in their order, each divider right above the page
 * it names (dividers naming one page keep their order). A divider naming no page, or no
 * existing page, goes after the last page.
 */
export function canvasPageList<P extends { readonly id: string }>(work: {
  readonly pages: readonly P[];
  readonly dividers?: readonly CanvasPageDivider[] | undefined;
}): CanvasPageListItem<P>[] {
  const dividers = work.dividers ?? [];
  const pageIds = new Set(work.pages.map((page) => page.id));
  const above = new Map<string, CanvasPageListItem<P>[]>();
  const trailing: CanvasPageListItem<P>[] = [];
  for (const divider of dividers) {
    const item = { kind: "divider", id: divider.id } as const;
    if (divider.beforePageId !== null && pageIds.has(divider.beforePageId)) {
      const list = above.get(divider.beforePageId) ?? [];
      list.push(item);
      above.set(divider.beforePageId, list);
    } else trailing.push(item);
  }
  return [
    ...work.pages.flatMap((page) => [
      ...(above.get(page.id) ?? []),
      { kind: "page" as const, id: page.id, page },
    ]),
    ...trailing,
  ];
}

/** The pages in list order and every divider anchored to the page that follows it. */
export function canvasPageListParts<P extends { readonly id: string }>(
  items: readonly CanvasPageListItem<P>[],
): { pages: P[]; dividers: CanvasPageDivider[] } {
  const pages: P[] = [];
  const dividers: CanvasPageDivider[] = [];
  items.forEach((item, index) => {
    if (item.kind === "page") {
      pages.push(item.page);
      return;
    }
    const next = items.slice(index + 1).find((candidate) => candidate.kind === "page");
    dividers.push({ id: item.id, beforePageId: next?.id ?? null });
  });
  return { pages, dividers };
}

/**
 * The list with `id` moved right before `beforeId` (null: last). Moving an item before itself
 * changes nothing. Throws when either ID is not in the list.
 */
export function moveCanvasPageListItem<P extends { readonly id: string }>(
  items: readonly CanvasPageListItem<P>[],
  id: string,
  beforeId: string | null,
): CanvasPageListItem<P>[] {
  const moving = items.find((item) => item.id === id);
  if (!moving) throw new Error("Canvas page not found.");
  if (beforeId === id) return [...items];
  const rest = items.filter((item) => item !== moving);
  const at = beforeId === null ? rest.length : rest.findIndex((item) => item.id === beforeId);
  if (at < 0) throw new Error("Destination page not found.");
  rest.splice(at, 0, moving);
  return rest;
}

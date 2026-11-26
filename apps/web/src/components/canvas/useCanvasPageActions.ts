// FILE: useCanvasPageActions.ts
// Purpose: Page list operations for a canvas work (pages, dividers, icons, order) with the saved
//          work written back to the query cache, so every page surface shares one implementation.
// Layer: Canvas UI hook
// Exports: useCanvasPageActions, CanvasPageActions, CANVAS_PAGE_LIMIT, CANVAS_PAGE_TITLE_MAX_LENGTH

import {
  CANVAS_MAX_PAGE_DIVIDERS,
  CANVAS_MAX_PAGES,
  type CanvasPage,
  type CanvasPageChangeInput,
  type CanvasPageIcon,
  type CanvasWork,
} from "@synara/contracts";
import { canvasPageList, type CanvasPageListItem } from "@synara/shared/designCanvasPages";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "~/i18n";
import { randomUUID } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { toastManager } from "../ui/toast";
import { runCanvasWrite } from "./canvasWorkCache";

export const CANVAS_PAGE_LIMIT = CANVAS_MAX_PAGES;
export const CANVAS_PAGE_TITLE_MAX_LENGTH = 120;

export type CanvasPageActions = ReturnType<typeof useCanvasPageActions>;

export function useCanvasPageActions(
  work: CanvasWork,
  currentPageId: string,
  onSelect: (pageId: string) => void,
) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const readOnly = work.readOnly === true || work.archivedAt !== null;
  const items: CanvasPageListItem<CanvasPage>[] = canvasPageList(work);
  const change = async (operation: CanvasPageChangeInput["operation"]) => {
    return runCanvasWrite(client, work.id, () =>
      ensureNativeApi().canvas.changePages({ workId: work.id, operation }),
    );
  };
  const report = (cause: unknown) =>
    toastManager.add({
      type: "error",
      title: t("workspace:canvasOperationFailed"),
      description: cause instanceof Error ? cause.message : undefined,
    });
  const attempt = async (operation: CanvasPageChangeInput["operation"]) => {
    try {
      await change(operation);
    } catch (cause) {
      report(cause);
    }
  };
  /** The item listed right after `id`, where something "below" it goes (null: last). */
  const after = (id: string) => items[items.findIndex((item) => item.id === id) + 1]?.id ?? null;
  return {
    readOnly,
    /** Pages and dividers in list order. */
    items,
    canCreate: !readOnly && work.pages.length < CANVAS_PAGE_LIMIT,
    canDelete: !readOnly && work.pages.length > 1,
    canAddDivider: !readOnly && (work.dividers?.length ?? 0) < CANVAS_MAX_PAGE_DIVIDERS,
    /** Adds a page named "Page N", opens it and returns its ID (null when saving failed). */
    create: async (): Promise<string | null> => {
      const id = randomUUID();
      try {
        await change({
          type: "create",
          id,
          title: t("workspace:canvasPageDefault", { count: work.pages.length + 1 }),
        });
      } catch (cause) {
        report(cause);
        return null;
      }
      onSelect(id);
      return id;
    },
    rename: (id: string, title: string) => attempt({ type: "rename", id, title }),
    setIcon: (id: string, icon: CanvasPageIcon | null) => attempt({ type: "set_icon", id, icon }),
    /** The page's canvas colour (`#rrggbb` or `#rrggbbaa`); null goes back to the theme's. */
    setColor: (id: string, color: string | null) => attempt({ type: "set_color", id, color }),
    /** A divider right below the page or divider `id` (Add divider, Duplicate divider). */
    addDividerBelow: (id: string) =>
      attempt({ type: "add_divider", id: randomUUID(), beforeId: after(id) }),
    removeDivider: (id: string) => attempt({ type: "delete_divider", id }),
    /** Puts a page or divider right before `beforeId` (null: last). */
    move: (id: string, beforeId: string | null) => {
      if (id === beforeId || after(id) === beforeId) return Promise.resolve();
      return attempt({ type: "move", id, beforeId });
    },
    /** Asks first; deleting the open page opens the next one, or the previous. */
    remove: async (id: string) => {
      const at = work.pages.findIndex((item) => item.id === id);
      const page = work.pages[at];
      if (
        !page ||
        !(await ensureNativeApi().dialogs.confirm(
          t("workspace:canvasDeletePageHint", { title: page.title }),
        ))
      )
        return;
      try {
        const saved = await change({ type: "delete", id });
        if (id !== currentPageId) return;
        const neighbour = work.pages[at + 1] ?? work.pages[at - 1];
        const next = saved.pages.find((item) => item.id === neighbour?.id) ?? saved.pages[0]!;
        onSelect(next.id);
      } catch (cause) {
        report(cause);
      }
    },
  };
}

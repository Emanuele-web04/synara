// FILE: canvasPageContextMenu.ts
// Purpose: The page list's context menus, shared by the Pages section and the page switcher:
//          a page has Rename, Add divider, Page icon (one row, a submenu) and Delete; a divider
//          has Duplicate and Delete.
// Layer: Canvas UI
// Exports: showCanvasPageMenu

import type { CanvasPage, CanvasPageIcon, ContextMenuItem } from "@synara/contracts";
import type { CanvasPageListItem } from "@synara/shared/designCanvasPages";
import type { t as translate } from "~/i18n";
import { contextMenuGroup } from "~/lib/contextMenuGroup";
import { ensureNativeApi } from "~/nativeApi";
import { CANVAS_PAGE_ICON_OPTIONS } from "./canvasPageIcons";
import type { CanvasPageActions } from "./useCanvasPageActions";

type IconAction = `icon:${CanvasPageIcon}` | "icon:none";
type Action =
  | "rename"
  | "add-divider"
  | IconAction
  | "delete"
  | "duplicate-divider"
  | "delete-divider";

export async function showCanvasPageMenu(input: {
  t: typeof translate;
  pages: CanvasPageActions;
  item: CanvasPageListItem<CanvasPage>;
  position: { x: number; y: number };
  onRename: (pageId: string) => void;
}) {
  const { t, pages, item } = input;
  if (pages.readOnly) return;
  const items: ContextMenuItem<Action>[] =
    item.kind === "divider"
      ? [
          ...(pages.canAddDivider
            ? [{ id: "duplicate-divider" as const, label: t("workspace:canvasDuplicateDivider") }]
            : []),
          {
            id: "delete-divider",
            label: t("workspace:canvasDeleteDivider"),
            destructive: true,
            separatorBefore: pages.canAddDivider,
          },
        ]
      : [
          { id: "rename", label: t("workspace:canvasRenamePage") },
          ...(pages.canAddDivider
            ? [{ id: "add-divider" as const, label: t("workspace:canvasAddDivider") }]
            : []),
          ...contextMenuGroup<Action>({ id: "icon:none", label: t("workspace:canvasPageIcon") }, [
            ...(item.page.icon
              ? [{ id: "icon:none" as const, label: t("workspace:canvasPageIconDefault") }]
              : []),
            ...CANVAS_PAGE_ICON_OPTIONS.map((option, index) => ({
              id: `icon:${option.icon}` as const,
              label: t(option.labelKey),
              icon: option.centralName,
              separatorBefore: index === 0 && item.page.icon !== undefined,
            })),
          ]),
          // A canvas keeps at least one page: the last one has no Delete.
          ...(pages.canDelete
            ? [
                {
                  id: "delete" as const,
                  label: t("workspace:canvasDeletePage"),
                  destructive: true,
                  separatorBefore: true,
                },
              ]
            : []),
        ];
  const clicked = await ensureNativeApi().contextMenu.show(items, input.position);
  if (!clicked) return;
  if (clicked.startsWith("icon:")) {
    if (item.kind !== "page") return;
    const icon = clicked.slice("icon:".length);
    return void pages.setIcon(item.id, icon === "none" ? null : (icon as CanvasPageIcon));
  }
  switch (clicked) {
    case "rename":
      return input.onRename(item.id);
    case "add-divider":
    case "duplicate-divider":
      return void pages.addDividerBelow(item.id);
    case "delete":
      return void pages.remove(item.id);
    case "delete-divider":
      return void pages.removeDivider(item.id);
    default:
      return;
  }
}

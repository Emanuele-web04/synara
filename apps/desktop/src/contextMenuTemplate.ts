// FILE: contextMenuTemplate.ts
// Purpose: Turns renderer context menu rows into an Electron menu template, including submenus.
// Layer: desktop main utility
// Exports: buildContextMenuTemplate, CONTEXT_MENU_MAX_DEPTH

import type { DesktopContextMenuItem } from "@synara/contracts";
import type { MenuItemConstructorOptions, NativeImage } from "electron";

/** Renderer input is untrusted; deeper nesting than this is dropped rather than built. */
export const CONTEXT_MENU_MAX_DEPTH = 3;

export interface ContextMenuTemplateOptions {
  readonly decorateLabel: (label: string) => string;
  readonly resolveIcon: (item: DesktopContextMenuItem) => NativeImage | undefined;
  readonly onSelect: (id: string) => void;
}

function isContextMenuItem(item: unknown): item is DesktopContextMenuItem {
  if (typeof item !== "object" || item === null) return false;
  const candidate = item as { id?: unknown; label?: unknown };
  return typeof candidate.id === "string" && typeof candidate.label === "string";
}

/**
 * Builds one menu level. A row with usable `children` becomes a native submenu and never
 * resolves itself; a parent whose children are all invalid is dropped so it cannot read as
 * an action that does nothing.
 */
export function buildContextMenuTemplate(
  items: unknown,
  options: ContextMenuTemplateOptions,
  depth = 1,
): MenuItemConstructorOptions[] {
  if (!Array.isArray(items)) return [];
  const template: MenuItemConstructorOptions[] = [];
  let hasInsertedDestructiveSeparator = false;
  for (const item of items) {
    if (!isContextMenuItem(item)) continue;
    const destructive = item.destructive === true;
    const hasChildren = item.children !== undefined;
    const submenu =
      hasChildren && depth < CONTEXT_MENU_MAX_DEPTH
        ? buildContextMenuTemplate(item.children, options, depth + 1)
        : [];
    if (hasChildren && submenu.length === 0) continue;

    const shouldInsertSeparator =
      item.separatorBefore === true || (destructive && !hasInsertedDestructiveSeparator);
    if (shouldInsertSeparator && template.length > 0) {
      template.push({ type: "separator" });
    }
    if (destructive) {
      hasInsertedDestructiveSeparator = true;
    }
    const itemOption: MenuItemConstructorOptions = { label: options.decorateLabel(item.label) };
    if (hasChildren) {
      itemOption.submenu = submenu;
    } else {
      const { id } = item;
      itemOption.click = () => options.onSelect(id);
    }
    const icon = options.resolveIcon(item);
    if (icon) {
      itemOption.icon = icon;
    }
    template.push(itemOption);
  }
  return template;
}

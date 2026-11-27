// FILE: contextMenuTemplate.ts
// Purpose: Turns renderer context menu rows into an Electron menu template, including submenus
//          and the display-only accelerator of a row that names its key.
// Layer: desktop main utility
// Exports: buildContextMenuTemplate, CONTEXT_MENU_MAX_DEPTH

import { type DesktopContextMenuItem, KeybindingShortcut } from "@synara/contracts";
import { Schema } from "effect";
import type { MenuItemConstructorOptions, NativeImage } from "electron";
import { keybindingShortcutToAccelerator } from "./menuShortcuts";

/** Renderer input is untrusted; deeper nesting than this is dropped rather than built. */
export const CONTEXT_MENU_MAX_DEPTH = 3;

export interface ContextMenuTemplateOptions {
  /** Spells a row's shortcut the way this platform's menus show keys. */
  readonly platform: NodeJS.Platform;
  readonly decorateLabel: (label: string) => string;
  readonly resolveIcon: (item: DesktopContextMenuItem) => NativeImage | undefined;
  readonly onSelect: (id: string) => void;
}

const isKeybindingShortcut = Schema.is(KeybindingShortcut);

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
      // The row names the key that does the same where the menu opened; the menu only shows it.
      const accelerator = isKeybindingShortcut(item.shortcut)
        ? keybindingShortcutToAccelerator(item.shortcut, options.platform, { displayOnly: true })
        : null;
      if (accelerator) {
        itemOption.accelerator = accelerator;
        itemOption.registerAccelerator = false;
      }
    }
    const icon = options.resolveIcon(item);
    if (icon) {
      itemOption.icon = icon;
    }
    template.push(itemOption);
  }
  return template;
}

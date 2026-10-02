import { FLOATING_OVERLAY_SURFACE_CLASS_NAME } from "~/surfaceStyles";
import type { ContextMenuItem } from "@synara/contracts";
import { createCentralIconElement } from "./lib/central-icons";
import { isInlineSvgMenuIcon } from "./lib/nativeMenuIcons";

function createMenuIconElement(icon: string): HTMLElement | null {
  if (!isInlineSvgMenuIcon(icon)) return createCentralIconElement(icon, "opacity-60");
  const wrapper = document.createElement("span");
  wrapper.className = "flex size-4 shrink-0 items-center justify-center opacity-60 [&>svg]:size-4";
  wrapper.innerHTML = icon;
  return wrapper;
}

const HIGHLIGHT_CLASS = "bg-[var(--sidebar-accent)]";
const MENU_CLASS_NAME = `${FLOATING_OVERLAY_SURFACE_CLASS_NAME} fixed z-[10000] min-w-[180px] rounded-xl border border-white/[0.08] shadow-xl animate-in fade-in zoom-in-95`;
const VIEWPORT_MARGIN = 4;
/** Small overlap so the pointer never crosses a gap between a row and its submenu. */
const SUBMENU_OVERLAP = 4;
/**
 * Grace period before hovering a sibling row replaces an open submenu, so a diagonal
 * move from the parent row into its submenu can cross other rows without closing it.
 */
const SUBMENU_SWITCH_DELAY_MS = 150;

interface MenuLevel<T extends string> {
  readonly element: HTMLDivElement;
  readonly items: readonly ContextMenuItem<T>[];
  readonly buttons: HTMLButtonElement[];
  focusedIndex: number;
  /** Index of the row whose submenu is the next level in the stack, or -1. */
  openChildIndex: number;
}

/**
 * Imperative DOM-based context menu that matches the app's Base UI menu styling.
 * Shows a positioned dropdown and returns a promise that resolves
 * with the clicked item id, or null if dismissed. Rows with `children` open a
 * flyout submenu on hover or ArrowRight, mirroring the native desktop menu.
 */
export function showContextMenuFallback<T extends string>(
  items: readonly ContextMenuItem<T>[],
  position?: { x: number; y: number },
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:9999";

    // Stack of open menus: the root first, then each open submenu.
    const levels: MenuLevel<T>[] = [];

    let pendingSwitch: number | undefined;

    function cancelPendingSwitch() {
      window.clearTimeout(pendingSwitch);
      pendingSwitch = undefined;
    }

    function cleanup(result: T | null) {
      cancelPendingSwitch();
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      for (const level of levels) level.element.remove();
      resolve(result);
    }

    function closeLevelsAfter(depth: number) {
      while (levels.length > depth + 1) {
        levels.pop()!.element.remove();
      }
      const level = levels[depth];
      if (!level) return;
      if (level.openChildIndex !== level.focusedIndex) {
        level.buttons[level.openChildIndex]?.classList.remove(HIGHLIGHT_CLASS);
      }
      level.openChildIndex = -1;
    }

    function focusItem(depth: number, index: number) {
      const level = levels[depth];
      if (!level || index < 0 || index >= level.buttons.length) return;
      if (level.focusedIndex !== level.openChildIndex) {
        level.buttons[level.focusedIndex]?.classList.remove(HIGHLIGHT_CLASS);
      }
      level.focusedIndex = index;
      level.buttons[index]?.classList.add(HIGHLIGHT_CLASS);
      level.buttons[index]?.focus();
    }

    function openSubmenu(depth: number, index: number, focusFirst: boolean) {
      const level = levels[depth];
      const children = level?.items[index]?.children;
      const anchor = level?.buttons[index];
      if (!level || !children || children.length === 0 || !anchor) return;
      if (level.openChildIndex !== index) {
        closeLevelsAfter(depth);
        level.openChildIndex = index;
        anchor.classList.add(HIGHLIGHT_CLASS);
        const rect = anchor.getBoundingClientRect();
        openLevel(children, { x: rect.right - SUBMENU_OVERLAP, y: rect.top - 4 }, rect);
      }
      if (focusFirst) focusItem(depth + 1, 0);
    }

    function activate(depth: number, index: number) {
      const item = levels[depth]?.items[index];
      if (!item) return;
      if (item.children) {
        openSubmenu(depth, index, true);
        return;
      }
      cleanup(item.id);
    }

    function onKeyDown(e: KeyboardEvent) {
      cancelPendingSwitch();
      // A hovered flyout can be visible while keyboard focus is still on its
      // parent or a sibling. Route keys to that focused menu, not the flyout.
      const focusedDepth = levels.findIndex((level) =>
        level.buttons.some((button) => button === document.activeElement),
      );
      const depth = focusedDepth === -1 ? levels.length - 1 : focusedDepth;
      const level = levels[depth];
      if (!level) return;
      if (level.focusedIndex !== level.openChildIndex) closeLevelsAfter(depth);
      const count = level.buttons.length;
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup(null);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        closeLevelsAfter(depth);
        focusItem(depth, level.focusedIndex < count - 1 ? level.focusedIndex + 1 : 0);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        closeLevelsAfter(depth);
        focusItem(depth, level.focusedIndex > 0 ? level.focusedIndex - 1 : count - 1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        openSubmenu(depth, level.focusedIndex, true);
      } else if (e.key === "ArrowLeft") {
        if (depth === 0) return;
        e.preventDefault();
        const parentIndex = levels[depth - 1]!.openChildIndex;
        closeLevelsAfter(depth - 1);
        focusItem(depth - 1, parentIndex);
      } else if (e.key === "Enter") {
        e.preventDefault();
        activate(depth, level.focusedIndex);
      }
    }

    /** Appends one menu to the stack. `anchorRect` is the parent row for a submenu. */
    function openLevel(
      levelItems: readonly ContextMenuItem<T>[],
      origin: { x: number; y: number },
      anchorRect?: DOMRect,
    ) {
      const depth = levels.length;
      const menu = document.createElement("div");
      menu.dataset.slot = depth === 0 ? "context-menu-popup" : "context-menu-sub-popup";
      menu.className = MENU_CLASS_NAME;
      menu.style.top = `${origin.y}px`;
      menu.style.left = `${origin.x}px`;
      menu.style.backdropFilter = "blur(24px)";
      (menu.style as any).webkitBackdropFilter = "blur(24px)";

      const inner = document.createElement("div");
      // A submenu taller than the window (many providers or hubs) scrolls in place.
      inner.className = "max-h-[calc(100vh-8px)] overflow-y-auto p-1";
      menu.appendChild(inner);

      const level: MenuLevel<T> = {
        element: menu,
        items: levelItems,
        buttons: [],
        focusedIndex: -1,
        openChildIndex: -1,
      };
      levels.push(level);
      // Reaching a submenu confirms the diagonal move toward it.
      menu.addEventListener("mouseenter", cancelPendingSwitch);

      for (let i = 0; i < levelItems.length; i++) {
        const item = levelItems[i]!;
        const isDestructive = item.destructive === true || item.id === "delete";

        // Keep explicit groups visible in the browser fallback; destructive items remain isolated by default.
        if ((item.separatorBefore === true || isDestructive) && i > 0) {
          const sep = document.createElement("div");
          sep.className = "mx-2.5 my-1 h-px bg-border";
          inner.appendChild(sep);
        }

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = isDestructive
          ? "flex w-full min-h-7 cursor-default select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-ui text-foreground/86 transition-colors"
          : "flex w-full min-h-7 cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-ui text-foreground/86 transition-colors";

        const icon = item.icon ? createMenuIconElement(item.icon) : null;
        if (icon) {
          btn.appendChild(icon);
        }

        const label = document.createElement("span");
        label.textContent = item.label;
        btn.appendChild(label);

        if (item.children) {
          btn.setAttribute("aria-haspopup", "menu");
          const chevron = createCentralIconElement("chevron-right", "ms-auto opacity-60");
          if (chevron) btn.appendChild(chevron);
        }

        btn.addEventListener("click", () => activate(depth, i));
        btn.addEventListener("mouseenter", () => {
          cancelPendingSwitch();
          focusItem(depth, i);
          const applyHover = () => {
            if (item.children) {
              openSubmenu(depth, i, false);
            } else {
              closeLevelsAfter(depth);
            }
          };
          const replacesOpenSubmenu = level.openChildIndex !== -1 && level.openChildIndex !== i;
          if (replacesOpenSubmenu) {
            pendingSwitch = window.setTimeout(applyHover, SUBMENU_SWITCH_DELAY_MS);
          } else {
            applyHover();
          }
        });
        btn.addEventListener("mouseleave", () => {
          // The row that owns the open submenu stays lit while the pointer is inside it.
          if (level.openChildIndex !== i) btn.classList.remove(HIGHLIGHT_CLASS);
          if (level.focusedIndex === i) level.focusedIndex = -1;
        });
        level.buttons.push(btn);
        inner.appendChild(btn);
      }

      document.body.appendChild(menu);

      // Adjust if menu overflows viewport
      requestAnimationFrame(() => {
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
          // A submenu flips to the other side of its parent row instead of covering it.
          const flippedLeft = anchorRect
            ? anchorRect.left - rect.width + SUBMENU_OVERLAP
            : window.innerWidth - rect.width - VIEWPORT_MARGIN;
          menu.style.left = `${Math.max(VIEWPORT_MARGIN, flippedLeft)}px`;
        }
        if (rect.bottom > window.innerHeight) {
          menu.style.top = `${Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.height - VIEWPORT_MARGIN)}px`;
        }
      });
    }

    overlay.addEventListener("mousedown", () => cleanup(null));
    document.addEventListener("keydown", onKeyDown);

    document.body.appendChild(overlay);
    openLevel(items, { x: position?.x ?? 0, y: position?.y ?? 0 });
  });
}

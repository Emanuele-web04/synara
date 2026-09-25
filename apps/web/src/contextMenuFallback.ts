import type { ContextMenuItem } from "@synara/contracts";
import { createCentralIconElement } from "./lib/central-icons";
import { isInlineSvgMenuIcon } from "./lib/nativeMenuIcons";
import {
  SIDEBAR_CONTEXT_MENU_ICON_CLASS_NAME,
  SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME,
  SIDEBAR_CONTEXT_MENU_PANEL_CLASS_NAME,
} from "./components/sidebarContextMenuStyles";

function createMenuIconElement(icon: string): HTMLElement | null {
  const wrapper = document.createElement("span");
  wrapper.className = SIDEBAR_CONTEXT_MENU_ICON_CLASS_NAME;
  wrapper.setAttribute("aria-hidden", "true");
  if (isInlineSvgMenuIcon(icon)) {
    wrapper.innerHTML = icon;
    return wrapper;
  }
  const central = createCentralIconElement(icon);
  if (!central) return null;
  wrapper.appendChild(central);
  return wrapper;
}

/**
 * Imperative DOM-based context menu that matches the app's Base UI menu styling.
 * Shows a positioned dropdown and returns a promise that resolves
 * with the clicked item id, or null if dismissed.
 */
export function showContextMenuFallback<T extends string>(
  items: readonly ContextMenuItem<T>[],
  position?: { x: number; y: number },
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:9999";

    const menu = document.createElement("div");
    menu.dataset.slot = "context-menu-popup";
    menu.setAttribute("role", "menu");
    // Generic label: this fallback also serves non-thread callers (file
    // references, kanban cards), so it cannot claim "Thread actions".
    menu.setAttribute("aria-label", "Context menu");
    menu.className = `fixed z-[10000] ${SIDEBAR_CONTEXT_MENU_PANEL_CLASS_NAME} rounded-xl border border-border shadow-xl`;

    const x = position?.x ?? 0;
    const y = position?.y ?? 0;
    menu.style.top = `${y}px`;
    menu.style.left = `${x}px`;
    menu.style.backgroundColor = `color-mix(in srgb, var(--popover) 90%, transparent)`;
    menu.style.backdropFilter = "blur(24px)";
    (menu.style as any).webkitBackdropFilter = "blur(24px)";

    const inner = document.createElement("div");
    inner.className = "p-1";
    menu.appendChild(inner);

    let focusedIndex = -1;
    const buttons: HTMLButtonElement[] = [];

    function cleanup(result: T | null) {
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      menu.remove();
      resolve(result);
    }

    function focusItem(index: number) {
      if (index < 0 || index >= buttons.length) return;
      buttons[focusedIndex]?.classList.remove("bg-[var(--sidebar-accent)]");
      focusedIndex = index;
      buttons[focusedIndex]?.classList.add("bg-[var(--sidebar-accent)]");
      buttons[focusedIndex]?.focus();
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup(null);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        focusItem(focusedIndex < buttons.length - 1 ? focusedIndex + 1 : 0);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        focusItem(focusedIndex > 0 ? focusedIndex - 1 : buttons.length - 1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (focusedIndex >= 0 && focusedIndex < items.length) {
          cleanup(items[focusedIndex]!.id);
        }
      }
    }

    overlay.addEventListener("mousedown", () => cleanup(null));
    document.addEventListener("keydown", onKeyDown);

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const isDestructive = item.destructive === true || item.id === "delete";

      // Keep explicit groups visible in the browser fallback; destructive items remain isolated by default.
      if ((item.separatorBefore === true || isDestructive) && i > 0) {
        const sep = document.createElement("div");
        sep.className = "mx-2.5 my-1 h-px bg-border";
        sep.setAttribute("role", "separator");
        inner.appendChild(sep);
      }

      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("role", "menuitem");
      btn.className = isDestructive
        ? "flex w-full min-h-7 cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-ui text-destructive transition-colors"
        : `flex w-full min-h-7 cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-ui transition-colors ${SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}`;

      const icon = item.icon ? createMenuIconElement(item.icon) : null;
      if (icon) {
        btn.appendChild(icon);
      }

      const label = document.createElement("span");
      label.textContent = item.label;
      btn.appendChild(label);

      btn.addEventListener("click", () => cleanup(item.id));
      btn.addEventListener("mouseenter", () =>
        focusItem(buttons.length > 0 ? buttons.indexOf(btn) : 0),
      );
      btn.addEventListener("mouseleave", () => {
        btn.classList.remove("bg-[var(--sidebar-accent)]");
        focusedIndex = -1;
      });
      buttons.push(btn);
      inner.appendChild(btn);
    }

    document.body.appendChild(overlay);
    document.body.appendChild(menu);

    // Adjust if menu overflows viewport
    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        menu.style.left = `${window.innerWidth - rect.width - 4}px`;
      }
      if (rect.bottom > window.innerHeight) {
        menu.style.top = `${window.innerHeight - rect.height - 4}px`;
      }
    });

    // WAAPI entrance — the same scale-from-origin + fade as POPUP_MOTION_CLASS
    // on real menus (Tailwind's animate-in/zoom-in utilities are not compiled in
    // apps/web, so the class-based version was dead code).
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      menu.style.transformOrigin = "top left";
      menu.animate(
        [
          { opacity: 0, transform: "scale(0.97)" },
          { opacity: 1, transform: "scale(1)" },
        ],
        { duration: 150, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
    }

    // Keyboard path: focus lands on the first item so Shift+F10 -> ArrowDown
    // moves rather than spending a press on entering the menu.
    focusItem(0);
  });
}

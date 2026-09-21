import type { ContextMenuItem, DesktopContextMenuItem } from "@synara/contracts";
import { getCentralIconUrl } from "./central-icons";

// macOS menus reserve a 16pt image slot; render at 2x so Retina menus stay crisp.
const NATIVE_MENU_ICON_POINTS = 16;
const NATIVE_MENU_ICON_SCALE = 2;

const iconDataUrlCache = new Map<string, Promise<string | null>>();

export function isInlineSvgMenuIcon(icon: string): boolean {
  return icon.startsWith("<svg");
}

async function loadMenuIconSvg(icon: string): Promise<string | null> {
  if (isInlineSvgMenuIcon(icon)) return icon;
  const iconUrl = getCentralIconUrl(icon);
  if (!iconUrl) return null;
  const response = await fetch(iconUrl);
  return response.ok ? response.text() : null;
}

async function rasterizeMenuIcon(icon: string): Promise<string | null> {
  const markup = await loadMenuIconSvg(icon);
  if (!markup) return null;
  // Template images only use alpha; macOS tints them for appearance and highlight.
  const svg = markup.replaceAll("currentColor", "#000");
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();

  const size = NATIVE_MENU_ICON_POINTS * NATIVE_MENU_ICON_SCALE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(image, 0, 0, size, size);
  return canvas.toDataURL("image/png");
}

function resolveIconDataUrl(icon: string): Promise<string | null> {
  const cached = iconDataUrlCache.get(icon);
  if (cached) return cached;
  const pending = rasterizeMenuIcon(icon)
    .catch(() => null)
    .then((dataUrl) => {
      // Let a transient asset failure retry on the next menu open.
      if (!dataUrl) iconDataUrlCache.delete(icon);
      return dataUrl;
    });
  iconDataUrlCache.set(icon, pending);
  return pending;
}

export function withNativeMenuIcons<T extends string>(
  items: readonly ContextMenuItem<T>[],
): Promise<DesktopContextMenuItem<T>[]> {
  return Promise.all(
    items.map(async (item) => {
      if (!item.icon) return item;
      const iconDataUrl = await resolveIconDataUrl(item.icon);
      return iconDataUrl ? { ...item, iconDataUrl } : item;
    }),
  );
}

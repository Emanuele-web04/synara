import type { MenuItemConstructorOptions } from "electron";

export interface DesktopKeyboardInput {
  type: string;
  key: string;
  code?: string;
  control: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

export type DesktopPhysicalZoomAction = "zoomOut" | null;

export type DesktopZoomShortcutAction = "zoomIn" | "zoomOut" | "resetZoom";

export interface DesktopNativeZoomTarget {
  getZoomLevel(): number;
  setZoomLevel(level: number): void;
}

export function resolveDesktopPhysicalZoomAction(
  platform: NodeJS.Platform,
  input: DesktopKeyboardInput,
): DesktopPhysicalZoomAction {
  if (
    platform !== "win32" ||
    input.type !== "keyDown" ||
    !input.control ||
    input.meta ||
    input.shift ||
    input.alt
  ) {
    return null;
  }

  const isMinusKey = input.key === "-" || input.code === "Minus" || input.code === "NumpadSubtract";
  return isMinusKey ? "zoomOut" : null;
}

export function applyDesktopPhysicalZoomAction(
  target: DesktopNativeZoomTarget,
  action: Exclude<DesktopPhysicalZoomAction, null>,
): void {
  if (action === "zoomOut") {
    // reuse the native zoomOut role's exact half-level step so alternating native zoom-in and fallback zoom-out can't drift
    target.setZoomLevel(target.getZoomLevel() - 0.5);
  }
}

export function resolveDesktopZoomShortcutAction(
  platform: NodeJS.Platform,
  input: DesktopKeyboardInput,
): DesktopZoomShortcutAction | null {
  // Linux registers no native zoom accelerators (several desktops surface them as noisy keybinding notifications) — main applies them via before-input-event; macOS/Windows keep native roles and must not double-handle
  if (
    platform !== "linux" ||
    input.type !== "keyDown" ||
    !input.control ||
    input.meta ||
    input.alt
  ) {
    return null;
  }

  // NumLock-off numpad presses surface as navigation keys like Insert — the guard keeps them from zooming
  if (input.code === "NumpadAdd" && input.key === "Add") return "zoomIn";
  if (input.code === "NumpadSubtract" && input.key === "Subtract") {
    return input.shift ? null : "zoomOut";
  }
  // "+" needs Shift on most layouts (incl. Italian) so Shift stays allowed for zoom-in; "-" and "0" have unshifted keys so Shift chords are left alone
  if (input.key === "+" || input.key === "=") return "zoomIn";
  if ((input.key === "-" || input.key === "_") && !input.shift) return "zoomOut";
  if (input.key === "0" && !input.shift) return "resetZoom";
  return null;
}

export function resolveDesktopMenuAccelerator(
  platform: NodeJS.Platform,
  accelerator: MenuItemConstructorOptions["accelerator"],
): MenuItemConstructorOptions["accelerator"] | undefined {
  // several Linux desktops surface Electron menu accelerators as noisy native keybinding notifications — the web app handles these shortcuts itself
  return platform === "linux" ? undefined : accelerator;
}

export function shouldUseNativeZoomMenuRoles(platform: NodeJS.Platform): boolean {
  // Linux uses custom click handlers so no hidden native keybindings register — keyboard zoom is applied by the main process instead
  return platform !== "linux";
}

export function resolveKeyboardShortcutsMenuAccelerator(
  platform: NodeJS.Platform,
): MenuItemConstructorOptions["accelerator"] | undefined {
  // Windows Electron can treat Ctrl+- as Ctrl+/ on some layouts — steals the native zoom-out accelerator before the page receives it
  return platform === "darwin" ? "Cmd+/" : undefined;
}

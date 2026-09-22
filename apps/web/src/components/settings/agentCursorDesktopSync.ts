// FILE: agentCursorDesktopSync.ts
// Purpose: Mirror the agent cursor colors to the desktop main process, which
//          persists them and pushes them to the running Cua driver. A plain
//          browser has no bridge, so every path here is a no-op there.
// Layer: Settings UI wiring

import type { DesktopAgentCursorStyle } from "@synara/contracts";
import { useEffect } from "react";

import {
  DEFAULT_AGENT_CURSOR_COLOR_MODE,
  resolveAgentCursorColors,
  type AppSettings,
} from "~/appSettings";

/**
 * Send one cursor-style value to the desktop main process. A rejected send is
 * swallowed: main already holds the last durable value, and a background
 * mirror failing must not surface as an error in the settings UI.
 */
export function pushAgentCursorStyleToDesktop(style: DesktopAgentCursorStyle | null): void {
  if (typeof window === "undefined") return;
  const bridge = window.desktopBridge?.computer;
  if (!bridge?.setCursorStyle) return;
  void bridge.setCursorStyle(style).catch(() => undefined);
}

/**
 * Mirror the current agent cursor colors on mount and on every change. The
 * panel stays mounted for the settings route's lifetime, so the mount push
 * also refreshes a value that predates the desktop preference file. Stock
 * pushes null, which removes any stored override.
 */
export function useAgentCursorDesktopSync(settings: AppSettings): void {
  const mode = settings.agentCursorColorMode ?? DEFAULT_AGENT_CURSOR_COLOR_MODE;
  const fill = settings.agentCursorFillColor ?? "";
  const rim = settings.agentCursorRimColor ?? "";
  useEffect(() => {
    pushAgentCursorStyleToDesktop(
      resolveAgentCursorColors({
        agentCursorColorMode: mode,
        agentCursorFillColor: fill,
        agentCursorRimColor: rim,
      }),
    );
  }, [mode, fill, rim]);
}

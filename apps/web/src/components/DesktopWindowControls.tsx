import { useEffect, useState, type ReactNode } from "react";

import type { DesktopWindowState } from "@synara/contracts";

import { useDesktopCustomTitleBarMode } from "~/hooks/useDesktopCustomTitleBar";
import { isElectron } from "~/env";
import { Maximize2, Minimize2, MinusIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

const DEFAULT_WINDOW_STATE: DesktopWindowState = {
  isMaximized: false,
  isFullscreen: false,
};

// Linux fallback caption controls. Windows uses Electron's native Window Controls
// Overlay instead, preserving OS hit targets and Snap Layouts without duplicating
// Windows glyph and hover behavior in React.
const CAPTION_BUTTON_CLASS =
  "flex h-full w-[46px] shrink-0 items-center justify-center text-foreground/90 outline-none transition-colors duration-75 select-none hover:bg-foreground/[0.09] active:bg-foreground/[0.05] [-webkit-app-region:no-drag]";

// Destructive close affordance for the Linux renderer-control fallback.
const CLOSE_BUTTON_CLASS = "hover:bg-[#c42b1c] hover:text-white active:bg-[#b9281b]";

function CaptionSvg({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden="true" className="flex size-3.5 items-center justify-center">
      {children}
    </span>
  );
}

export function DesktopWindowControls({ className }: { className?: string }) {
  const [windowState, setWindowState] = useState<DesktopWindowState>(DEFAULT_WINDOW_STATE);
  const customTitleBarMode = useDesktopCustomTitleBarMode();
  const controls = typeof window === "undefined" ? undefined : window.desktopBridge?.windowControls;

  useEffect(() => {
    if (!controls) return;
    let cancelled = false;

    void controls.getState().then((state) => {
      if (!cancelled) setWindowState(state);
    });
    const unsubscribe = controls.onState(setWindowState);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [controls]);

  if (!isElectron || customTitleBarMode !== "renderer" || !controls) {
    return null;
  }

  const { isMaximized } = windowState;

  return (
    <div className={cn("flex h-[46px] items-stretch [-webkit-app-region:no-drag]", className)}>
      <button
        type="button"
        aria-label="Minimize"
        title="Minimize"
        className={CAPTION_BUTTON_CLASS}
        onClick={() => {
          void controls.minimize();
        }}
      >
        <CaptionSvg>
          <MinusIcon className="size-3.5" />
        </CaptionSvg>
      </button>
      <button
        type="button"
        aria-label={isMaximized ? "Restore" : "Maximize"}
        title={isMaximized ? "Restore" : "Maximize"}
        className={CAPTION_BUTTON_CLASS}
        onClick={() => {
          void controls.toggleMaximize().then(setWindowState);
        }}
      >
        <CaptionSvg>
          {isMaximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </CaptionSvg>
      </button>
      <button
        type="button"
        aria-label="Close"
        title="Close"
        className={cn(CAPTION_BUTTON_CLASS, CLOSE_BUTTON_CLASS)}
        onClick={() => {
          void controls.close();
        }}
      >
        <CaptionSvg>
          <XIcon className="size-3.5" />
        </CaptionSvg>
      </button>
    </div>
  );
}

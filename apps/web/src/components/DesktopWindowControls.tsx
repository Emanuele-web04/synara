import { useEffect, useState, type ReactNode } from "react";

import type { DesktopWindowState } from "@synara/contracts";

import { useDesktopCustomTitleBarActive } from "~/hooks/useDesktopCustomTitleBar";
import { isElectron } from "~/env";
import { Maximize2, Minimize2, MinusIcon, XIcon } from "~/lib/icons";
import { cn, getNavigatorPlatform, isWindowsPlatform } from "~/lib/utils";

const DEFAULT_WINDOW_STATE: DesktopWindowState = {
  isMaximized: false,
  isFullscreen: false,
};

// native Windows caption glyphs — these code points resolve in "Segoe Fluent Icons" (Win11) and fall back to "Segoe MDL2 Assets" (Win10): minimize, maximize, restore, close
const GLYPH_MINIMIZE = "\uE921";
const GLYPH_MAXIMIZE = "\uE922";
const GLYPH_RESTORE = "\uE923";
const GLYPH_CLOSE = "\uE8BB";

// match the native Windows caption-button footprint (46px, full title-bar height, flat, centered); deliberately plain <button>s — the app's Button/Tooltip primitives inject their own chrome
const CAPTION_BUTTON_CLASS =
  "flex h-full w-[46px] shrink-0 items-center justify-center text-foreground/90 outline-none transition-colors duration-75 select-none hover:bg-foreground/[0.09] active:bg-foreground/[0.05] [-webkit-app-region:no-drag]";

const CLOSE_BUTTON_CLASS = "hover:bg-[#c42b1c] hover:text-white active:bg-[#b9281b]";

function CaptionGlyph({ glyph }: { glyph: string }) {
  return (
    <span
      aria-hidden="true"
      className="text-[10px] leading-none"
      style={{ fontFamily: '"Segoe Fluent Icons", "Segoe MDL2 Assets"' }}
    >
      {glyph}
    </span>
  );
}

function CaptionSvg({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden="true" className="flex size-3.5 items-center justify-center">
      {children}
    </span>
  );
}

export function DesktopWindowControls({ className }: { className?: string }) {
  const [windowState, setWindowState] = useState<DesktopWindowState>(DEFAULT_WINDOW_STATE);
  const customTitleBarActive = useDesktopCustomTitleBarActive();
  const platform = getNavigatorPlatform();
  const useWindowsGlyphs = isWindowsPlatform(platform);
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

  if (!isElectron || !customTitleBarActive || !controls) {
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
        {useWindowsGlyphs ? (
          <CaptionGlyph glyph={GLYPH_MINIMIZE} />
        ) : (
          <CaptionSvg>
            <MinusIcon className="size-3.5" />
          </CaptionSvg>
        )}
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
        {useWindowsGlyphs ? (
          <CaptionGlyph glyph={isMaximized ? GLYPH_RESTORE : GLYPH_MAXIMIZE} />
        ) : (
          <CaptionSvg>
            {isMaximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </CaptionSvg>
        )}
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
        {useWindowsGlyphs ? (
          <CaptionGlyph glyph={GLYPH_CLOSE} />
        ) : (
          <CaptionSvg>
            <XIcon className="size-3.5" />
          </CaptionSvg>
        )}
      </button>
    </div>
  );
}

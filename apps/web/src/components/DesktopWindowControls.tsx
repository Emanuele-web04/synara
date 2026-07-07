import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { DesktopWindowState } from "@t3tools/contracts";

import { isElectron } from "~/env";
import { cn, isWindowsPlatform } from "~/lib/utils";

const DEFAULT_WINDOW_STATE: DesktopWindowState = {
  isMaximized: false,
  isFullscreen: false,
};

// Native Windows caption glyphs. These code points resolve in "Segoe Fluent Icons"
// (Windows 11) and fall back to "Segoe MDL2 Assets" (Windows 10): minimize, maximize,
// restore (overlapping squares), and close.
const GLYPH_MINIMIZE = "\uE921";
const GLYPH_MAXIMIZE = "\uE922";
const GLYPH_RESTORE = "\uE923";
const GLYPH_CLOSE = "\uE8BB";

// Match the native Windows caption-button footprint: 46px wide, full title-bar
// height, flat (no radius/border), glyph centered. These are deliberately plain
// <button>s rather than the app's Button/Tooltip primitives — those inject a
// rounded "chrome" variant, conflicting size overrides, and a base-ui trigger that
// intercepts the click — so the chrome stays pixel-native and onClick routes
// straight to the window-control IPC.
const CAPTION_BUTTON_CLASS =
  "flex h-full w-[46px] shrink-0 items-center justify-center text-foreground/90 outline-none transition-colors duration-75 select-none hover:bg-foreground/[0.09] active:bg-foreground/[0.05] [-webkit-app-region:no-drag]";

// Windows close-button accent: red fill on hover with a white glyph.
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

export function DesktopWindowControls({ className }: { className?: string }) {
  const { t } = useTranslation();
  const [windowState, setWindowState] = useState<DesktopWindowState>(DEFAULT_WINDOW_STATE);
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  const isWindowsDesktop = isWindowsPlatform(platform);
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

  if (!isElectron || !isWindowsDesktop || !controls) {
    return null;
  }

  const { isMaximized } = windowState;

  return (
    <div className={cn("flex h-[46px] items-stretch [-webkit-app-region:no-drag]", className)}>
      <button
        type="button"
        aria-label={t("app.minimize")}
        title={t("app.minimize")}
        className={CAPTION_BUTTON_CLASS}
        onClick={() => {
          void controls.minimize();
        }}
      >
        <CaptionGlyph glyph={GLYPH_MINIMIZE} />
      </button>
      <button
        type="button"
        aria-label={isMaximized ? t("app.restore") : t("app.maximize")}
        title={isMaximized ? t("app.restore") : t("app.maximize")}
        className={CAPTION_BUTTON_CLASS}
        onClick={() => {
          void controls.toggleMaximize().then(setWindowState);
        }}
      >
        <CaptionGlyph glyph={isMaximized ? GLYPH_RESTORE : GLYPH_MAXIMIZE} />
      </button>
      <button
        type="button"
        aria-label={t("app.close")}
        title={t("app.close")}
        className={cn(CAPTION_BUTTON_CLASS, CLOSE_BUTTON_CLASS)}
        onClick={() => {
          void controls.close();
        }}
      >
        <CaptionGlyph glyph={GLYPH_CLOSE} />
      </button>
    </div>
  );
}

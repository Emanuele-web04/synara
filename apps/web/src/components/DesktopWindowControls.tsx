import { useEffect, useState } from "react";

import type { DesktopWindowState } from "@t3tools/contracts";

import { isElectron } from "~/env";
import { cn, isMacPlatform } from "~/lib/utils";

import { ChatHeaderIconButton } from "./chat/chatHeaderControls";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const DEFAULT_WINDOW_STATE: DesktopWindowState = {
  isMaximized: false,
  isFullscreen: false,
};

const WINDOW_CAPTION_BUTTON_CLASS_NAME =
  "!h-[46px] !w-[46px] rounded-none text-[10px] font-normal hover:bg-[var(--color-background-button-secondary-hover)]";

function WindowsCaptionGlyph({ code }: { code: string }) {
  return (
    <span
      aria-hidden="true"
      className="leading-none"
      style={{
        fontFamily: '"Segoe Fluent Icons", "Segoe MDL2 Assets"',
      }}
    >
      {code}
    </span>
  );
}

export function DesktopWindowControls({ className }: { className?: string }) {
  const [windowState, setWindowState] = useState<DesktopWindowState>(DEFAULT_WINDOW_STATE);
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  const isMacDesktop = isMacPlatform(platform);
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

  if (!isElectron || isMacDesktop || !controls) {
    return null;
  }

  const maximizeLabel = windowState.isMaximized ? "Restore window" : "Maximize window";

  return (
    <div className={cn("flex shrink-0 items-stretch [-webkit-app-region:no-drag]", className)}>
      <Tooltip>
        <TooltipTrigger
          render={
            <ChatHeaderIconButton
              type="button"
              label="Minimize window"
              className={WINDOW_CAPTION_BUTTON_CLASS_NAME}
              onClick={() => {
                void controls.minimize();
              }}
            />
          }
        >
          <WindowsCaptionGlyph code={"\uE921"} />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Minimize</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <ChatHeaderIconButton
              type="button"
              label={maximizeLabel}
              className={WINDOW_CAPTION_BUTTON_CLASS_NAME}
              onClick={() => {
                void controls.toggleMaximize().then(setWindowState);
              }}
            />
          }
        >
          <WindowsCaptionGlyph code={windowState.isMaximized ? "\uE923" : "\uE922"} />
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {windowState.isMaximized ? "Restore" : "Maximize"}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <ChatHeaderIconButton
              type="button"
              label="Close window"
              className={cn(
                WINDOW_CAPTION_BUTTON_CLASS_NAME,
                "hover:bg-[#c42b1c] hover:text-white",
              )}
              onClick={() => {
                void controls.close();
              }}
            />
          }
        >
          <WindowsCaptionGlyph code={"\uE8BB"} />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Close</TooltipPopup>
      </Tooltip>
    </div>
  );
}

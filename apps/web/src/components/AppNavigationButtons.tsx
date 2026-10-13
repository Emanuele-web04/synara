// FILE: AppNavigationButtons.tsx
// Purpose: Renders Electron-only browser-style route back/forward controls.
// Layer: Shared web shell chrome
// Depends on: appNavigation history helpers, header Button/Tooltip primitives

import { goBackInAppHistory, goForwardInAppHistory, useAppNavigationState } from "~/appNavigation";
import { isElectron } from "~/env";
import { cn, isMacNavigatorPlatform } from "~/lib/utils";
import { IoIosArrowRoundBack, IoIosArrowRoundForward } from "react-icons/io";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useTranslation } from "~/i18n";

export function AppNavigationButtons({ className }: { className?: string }) {
  const { t } = useTranslation();

  const { canGoBack, canGoForward } = useAppNavigationState();
  const isMac = isMacNavigatorPlatform();
  const backShortcutLabel = isMac ? "⌘[" : t("Alt+Left");
  const forwardShortcutLabel = isMac ? "⌘]" : t("Alt+Right");

  if (!isElectron) {
    return null;
  }

  return (
    <div
      className={cn(
        "-ms-1 flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]",
        className,
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-8 rounded-lg"
              aria-label={t("Back")}
              disabled={!canGoBack}
              onClick={() => goBackInAppHistory()}
            />
          }
        >
          <IoIosArrowRoundBack className="size-6" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {t("Back (")}
          {backShortcutLabel})
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-8 rounded-lg"
              aria-label={t("Forward")}
              disabled={!canGoForward}
              onClick={() => goForwardInAppHistory()}
            />
          }
        >
          <IoIosArrowRoundForward className="size-6" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {t("Forward (")}
          {forwardShortcutLabel})
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

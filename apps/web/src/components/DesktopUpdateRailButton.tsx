import type { DesktopUpdateState } from "@synara/contracts";
import { UpdateDownloadIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { appRailButtonClassName } from "./AppRail";
import {
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateDownloadPercent,
  isDesktopUpdateButtonDisabled,
} from "./desktopUpdate.logic";
import { SidebarIconButton } from "./SidebarIconButton";

/** Rail presentation; Sidebar retains updater subscription and action ownership. */
export function DesktopUpdateRailButton({
  state,
  installing,
  onClick,
}: {
  state: DesktopUpdateState;
  installing: boolean;
  onClick: () => void;
}) {
  const label = getDesktopUpdateButtonTooltip(state, { installing });
  const disabled = isDesktopUpdateButtonDisabled(state) || installing;
  const percent = getDesktopUpdateDownloadPercent(state);
  return (
    <SidebarIconButton
      icon={UpdateDownloadIcon}
      label={label}
      tooltip={label}
      tooltipSide="right"
      size="lg"
      aria-disabled={disabled || undefined}
      disabled={disabled}
      className={cn(
        appRailButtonClassName(false),
        "w-auto min-w-9 max-w-full",
        disabled && "cursor-not-allowed",
      )}
      onClick={onClick}
    >
      <span
        className={cn(
          "inline-flex min-h-7 min-w-7 shrink-0 items-center justify-center rounded-full text-white",
          state.flavor === "beta" ? "bg-[image:var(--beta-gradient)]" : "bg-[var(--info)]",
        )}
      >
        {percent !== null ? (
          <span className="text-ui-2xs font-semibold leading-none tabular-nums">{percent}%</span>
        ) : (
          <UpdateDownloadIcon className="size-4" />
        )}
      </span>
    </SidebarIconButton>
  );
}

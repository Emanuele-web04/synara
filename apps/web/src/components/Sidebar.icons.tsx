// FILE: Sidebar.icons.tsx
// Purpose: Presentational glyph/badge components for sidebar thread rows.
// Layer: Sidebar UI (props-only, no store/hooks).
// Exports: WorktreeBadgeGlyph, ThreadStatusTrailingGlyph, ProviderAvatarWithTerminal, ThreadPrStatusBadge

import type { MouseEvent } from "react";
import { TerminalIcon } from "~/lib/icons";
import { LuSplit } from "react-icons/lu";
import { HiOutlineCheckCircle } from "react-icons/hi2";
import type { ProviderKind } from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import { ProviderIcon } from "./ProviderIcon";
import { ThreadRunningSpinner } from "./ThreadRunningSpinner";
import { SidebarGlyph, sidebarGlyphClass } from "./sidebarGlyphs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import type { PrStatusIndicator, TerminalStatusIndicator, ThreadStatusPill } from "./Sidebar.logic";

export function WorktreeBadgeGlyph({ className }: { className?: string }) {
  return (
    <LuSplit aria-hidden="true" className={cn("rotate-90", sidebarGlyphClass("meta", className))} />
  );
}

// Trailing status indicator shown in the timestamp slot: spinner while working,
// check when completed, otherwise a colored status dot. Replaces the relative
// timestamp whenever the thread has an active/unseen status.
export function ThreadStatusTrailingGlyph({ threadStatus }: { threadStatus: ThreadStatusPill }) {
  if (threadStatus.label === "Completed") {
    return (
      <HiOutlineCheckCircle
        aria-hidden="true"
        className={cn("size-3.5 shrink-0", threadStatus.colorClass)}
      />
    );
  }
  if (threadStatus.pulse) {
    return <ThreadRunningSpinner />;
  }
  return (
    <span
      aria-hidden="true"
      className={cn("size-1.5 shrink-0 rounded-full", threadStatus.dotClass)}
    />
  );
}

export function ProviderAvatarWithTerminal({
  provider,
  handoffSourceProvider,
  handoffTooltip,
  terminalStatus,
  terminalCount,
}: {
  provider: ProviderKind;
  handoffSourceProvider?: ProviderKind | null;
  handoffTooltip?: string | null;
  terminalStatus: TerminalStatusIndicator | null;
  terminalCount: number;
}) {
  const showBadge = terminalCount > 1 || terminalStatus !== null;
  const badgeTooltip =
    terminalCount > 1
      ? `${terminalCount} terminal${terminalCount === 1 ? "" : "s"} open`
      : (terminalStatus?.label ?? "Terminal open");
  const badgeColorClass = terminalStatus?.colorClass ?? "text-muted-foreground/70";

  const hasHandoff = Boolean(handoffSourceProvider);
  const containerClass = hasHandoff
    ? "relative inline-flex h-3 w-4.5 shrink-0 items-center"
    : "relative inline-flex size-3 shrink-0 items-center justify-center";

  const avatarNode = hasHandoff ? (
    <span className={containerClass}>
      <span className="absolute left-0 top-1/2 inline-flex size-3 -translate-y-1/2 items-center justify-center rounded-full bg-background shadow-xs">
        <ProviderIcon provider={handoffSourceProvider!} className="size-2" />
      </span>
      <span className="absolute right-0 top-1/2 z-10 inline-flex size-3 -translate-y-1/2 items-center justify-center rounded-full bg-background shadow-xs">
        <ProviderIcon provider={provider} className="size-2" />
      </span>
    </span>
  ) : (
    <span className={containerClass}>
      <ProviderIcon provider={provider} className="size-3" />
    </span>
  );

  const wrappedAvatar =
    hasHandoff && handoffTooltip ? (
      <Tooltip>
        <TooltipTrigger render={avatarNode} />
        <TooltipPopup side="top">{handoffTooltip}</TooltipPopup>
      </Tooltip>
    ) : (
      avatarNode
    );

  return (
    <span className="relative inline-flex shrink-0 items-center">
      {wrappedAvatar}
      {showBadge ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={badgeTooltip}
                className="absolute -top-1.5 -right-1.5 inline-flex size-3 min-w-3 items-center justify-center rounded-full bg-background px-px shadow-xs"
              >
                {terminalCount > 1 ? (
                  <span
                    className={cn(
                      "text-[8px] font-semibold leading-none tabular-nums",
                      badgeColorClass,
                    )}
                  >
                    {terminalCount}
                  </span>
                ) : (
                  <TerminalIcon className={cn("size-2.5", badgeColorClass)} />
                )}
              </span>
            }
          />
          <TooltipPopup side="top">{badgeTooltip}</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}

export function ThreadPrStatusBadge({
  prStatus,
  onOpen,
  className,
}: {
  prStatus: PrStatusIndicator;
  onOpen: (event: MouseEvent<HTMLElement>, prUrl: string) => void;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={prStatus.tooltip}
            className={cn(
              "inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm outline-hidden transition-colors focus-visible:ring-1 focus-visible:ring-ring",
              prStatus.colorClass,
              className,
            )}
            onClick={(event) => onOpen(event, prStatus.url)}
          >
            <SidebarGlyph icon={prStatus.icon} variant="meta" className="size-3.5" />
          </button>
        }
      />
      <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

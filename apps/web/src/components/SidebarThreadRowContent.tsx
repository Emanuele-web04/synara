// FILE: SidebarThreadRowContent.tsx
// Purpose: Owns the shared identity and status content rendered by every Sidebar thread row.
// Exports: SidebarThreadRowContent and its terminal-status presentation type.

import { memo, type ReactNode } from "react";

import { isGenericChatThreadTitle } from "@synara/shared/chatThreads";
import { pluralize } from "@synara/shared/text";

import { useThreadHasPendingDraft } from "../composerDraftStore";
import { resolveThreadHandoffBadgeLabel } from "../lib/threadHandoff";
import { SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME } from "../sidebarRowStyles";
import type { SidebarThreadSummary } from "../types";
import { TerminalIcon } from "../lib/icons";
import { cn } from "../lib/utils";
import { ProviderIcon } from "./ProviderIcon";
import { SidebarGlyph } from "./sidebarGlyphs";
import { SidebarDraftGlyph } from "./SidebarStatusTrailingGlyph";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export interface SidebarThreadTerminalStatus {
  label: "Terminal input needed" | "Terminal task completed" | "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

function ProviderAvatarWithTerminal({
  thread,
  terminalStatus,
  terminalCount,
}: {
  thread: SidebarThreadSummary;
  terminalStatus: SidebarThreadTerminalStatus | null;
  terminalCount: number;
}) {
  const provider = thread.session?.provider ?? thread.modelSelection.provider;
  const handoffSourceProvider = thread.handoff?.sourceProvider ?? null;
  const handoffTooltip = resolveThreadHandoffBadgeLabel(thread);
  const showBadge = terminalCount > 1 || terminalStatus !== null;
  const badgeTooltip =
    terminalCount > 1
      ? `${terminalCount} ${pluralize(terminalCount, "terminal")} open`
      : (terminalStatus?.label ?? "Terminal open");
  const badgeColorClass = terminalStatus?.colorClass ?? "text-muted-foreground/55";

  const hasHandoff = Boolean(handoffSourceProvider);
  const containerClass = hasHandoff
    ? "relative inline-flex h-3 w-4.5 shrink-0 items-center"
    : "relative inline-flex size-3 shrink-0 items-center justify-center";

  const avatarNode = hasHandoff ? (
    <span className={containerClass}>
      <span className="sidebar-icon-chip absolute left-0 top-1/2 inline-flex size-3 -translate-y-1/2 items-center justify-center rounded-full">
        <ProviderIcon provider={handoffSourceProvider!} className="size-2" />
      </span>
      <span className="sidebar-icon-chip absolute right-0 top-1/2 z-10 inline-flex size-3 -translate-y-1/2 items-center justify-center rounded-full">
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
                className="sidebar-icon-chip absolute -top-1.5 -right-1.5 inline-flex size-3 min-w-3 items-center justify-center rounded-full px-px"
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

const MemoizedProviderAvatarWithTerminal = memo(
  ProviderAvatarWithTerminal,
  (previous, next) =>
    previous.thread === next.thread &&
    previous.terminalCount === next.terminalCount &&
    previous.terminalStatus?.label === next.terminalStatus?.label &&
    previous.terminalStatus?.colorClass === next.terminalStatus?.colorClass &&
    previous.terminalStatus?.pulse === next.terminalStatus?.pulse,
);

export function SidebarThreadRowContent({
  thread,
  terminalEntryPoint,
  terminalStatus,
  terminalCount,
  isActive,
  variant,
  pendingStatusColorClass,
  suffix,
}: {
  thread: SidebarThreadSummary;
  terminalEntryPoint: boolean;
  terminalStatus: SidebarThreadTerminalStatus | null;
  terminalCount: number;
  isActive: boolean;
  variant: "pinned" | "standard";
  pendingStatusColorClass?: string | null | undefined;
  suffix?: ReactNode;
}) {
  const showThreadProviderAvatar = !isGenericChatThreadTitle(thread.title);
  const hasPendingDraft = useThreadHasPendingDraft(thread.id);

  return (
    <>
      {terminalEntryPoint ? (
        <SidebarGlyph icon={TerminalIcon} variant="chrome" />
      ) : showThreadProviderAvatar ? (
        <MemoizedProviderAvatarWithTerminal
          thread={thread}
          terminalStatus={terminalStatus}
          terminalCount={terminalCount}
        />
      ) : null}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
        <span
          className={cn(
            // Pinned rows size the title from its text so the suffix yields width first.
            "min-w-0 truncate-fade text-ui leading-5",
            variant === "pinned" ? "flex-auto" : "flex-1",
            isActive ? "text-foreground" : SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
          )}
          data-testid={variant === "pinned" ? `thread-title-${thread.id}` : undefined}
        >
          {thread.title}
        </span>
        {hasPendingDraft ? <SidebarDraftGlyph /> : null}
        {pendingStatusColorClass ? (
          <span
            aria-label="Pending approval"
            className={cn("shrink-0 text-ui-xs font-medium", pendingStatusColorClass)}
          >
            Pending
          </span>
        ) : null}
        {variant === "pinned" ? suffix : null}
      </div>
      {variant === "pinned" ? null : suffix}
    </>
  );
}

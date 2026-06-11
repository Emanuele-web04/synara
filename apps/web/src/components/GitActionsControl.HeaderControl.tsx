// FILE: GitActionsControl.HeaderControl.tsx
// Purpose: Chat-header quick-action button + dropdown picker for the git action control.
// Layer: Header action control (presentational)
// Exports: GitActionsHeaderControl.

import type { GitStatusResult } from "@t3tools/contracts";
import { ChevronDownIcon } from "~/lib/icons";
import { Button } from "~/components/ui/button";
import {
  ChatHeaderSplitDivider,
  ChatHeaderSplitGroup,
  CHAT_HEADER_CONTROL_CLASS_NAME,
  CHAT_HEADER_ICON_CONTROL_CLASS_NAME,
  CHAT_HEADER_ICON_STRENGTH_CLASS_NAME,
  CHAT_HEADER_SPLIT_LEADING_CLASS_NAME,
  CHAT_HEADER_SPLIT_TRAILING_CLASS_NAME,
} from "./chat/chatHeaderControls";
import { Menu, MenuGroup, MenuGroupLabel, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/utils";
import {
  type GitPickerMenuItem,
  GitPickerMenuRow,
  GitQuickActionIcon,
} from "./GitActionsControl.Glyphs";
import type { GitQuickAction } from "./GitActionsControl.logic";

interface GitActionsHeaderControlProps {
  quickAction: GitQuickAction;
  quickActionDisabledReason: string | null;
  hideQuickActionLabel: boolean;
  isGitActionRunning: boolean;
  runQuickAction: () => void;
  onMenuOpen: () => void;
  gitPickerMenuItems: GitPickerMenuItem[];
  gitStatusForActions: GitStatusResult | null;
  isGitStatusOutOfSync: boolean;
  gitStatusError: { message: string } | null;
}

export function GitActionsHeaderControl({
  quickAction,
  quickActionDisabledReason,
  hideQuickActionLabel,
  isGitActionRunning,
  runQuickAction,
  onMenuOpen,
  gitPickerMenuItems,
  gitStatusForActions,
  isGitStatusOutOfSync,
  gitStatusError,
}: GitActionsHeaderControlProps) {
  return (
    <ChatHeaderSplitGroup label="Git actions">
      {quickActionDisabledReason ? (
        <Popover>
          <PopoverTrigger
            openOnHover
            render={
              <Button
                aria-label={quickAction.label}
                aria-disabled="true"
                className={cn(
                  hideQuickActionLabel
                    ? CHAT_HEADER_ICON_CONTROL_CLASS_NAME
                    : CHAT_HEADER_CONTROL_CLASS_NAME,
                  CHAT_HEADER_ICON_STRENGTH_CLASS_NAME,
                  CHAT_HEADER_SPLIT_LEADING_CLASS_NAME,
                  "cursor-not-allowed opacity-64",
                )}
                size={hideQuickActionLabel ? "icon-xs" : "xs"}
                variant="chrome-outline"
                title={quickAction.label}
              />
            }
          >
            <GitQuickActionIcon quickAction={quickAction} />
            {!hideQuickActionLabel ? (
              <span className="font-normal">{quickAction.label}</span>
            ) : null}
          </PopoverTrigger>
          <PopoverPopup tooltipStyle side="bottom" align="start">
            {quickActionDisabledReason}
          </PopoverPopup>
        </Popover>
      ) : (
        <Button
          variant="chrome-outline"
          size={hideQuickActionLabel ? "icon-xs" : "xs"}
          className={cn(
            hideQuickActionLabel
              ? CHAT_HEADER_ICON_CONTROL_CLASS_NAME
              : CHAT_HEADER_CONTROL_CLASS_NAME,
            CHAT_HEADER_ICON_STRENGTH_CLASS_NAME,
            CHAT_HEADER_SPLIT_LEADING_CLASS_NAME,
          )}
          disabled={isGitActionRunning || quickAction.disabled}
          aria-label={quickAction.label}
          title={quickAction.label}
          onClick={runQuickAction}
        >
          <GitQuickActionIcon quickAction={quickAction} />
          {!hideQuickActionLabel ? <span className="font-normal">{quickAction.label}</span> : null}
        </Button>
      )}
      <ChatHeaderSplitDivider />
      <Menu
        onOpenChange={(open) => {
          if (open) onMenuOpen();
        }}
      >
        <MenuTrigger
          render={
            <Button
              aria-label="Git action options"
              size="icon-xs"
              variant="chrome-outline"
              className={cn(
                CHAT_HEADER_ICON_CONTROL_CLASS_NAME,
                CHAT_HEADER_ICON_STRENGTH_CLASS_NAME,
                CHAT_HEADER_SPLIT_TRAILING_CLASS_NAME,
              )}
            />
          }
          disabled={isGitActionRunning}
        >
          <ChevronDownIcon aria-hidden="true" className="size-3.5" />
        </MenuTrigger>
        <ComposerPickerMenuPopup align="end" side="bottom" className="w-50 min-w-50">
          <MenuGroup>
            <MenuGroupLabel>Git actions</MenuGroupLabel>
            {gitPickerMenuItems.map((item) => {
              const menuRow = <GitPickerMenuRow item={item} />;
              if (item.disabled && item.disabledReason) {
                return (
                  <Popover key={item.id}>
                    <PopoverTrigger
                      openOnHover
                      nativeButton={false}
                      render={<span className="block cursor-not-allowed" />}
                    >
                      {menuRow}
                    </PopoverTrigger>
                    <PopoverPopup tooltipStyle side="left" align="center">
                      {item.disabledReason}
                    </PopoverPopup>
                  </Popover>
                );
              }
              return <GitPickerMenuRow key={item.id} item={item} />;
            })}
          </MenuGroup>
          {(gitStatusForActions?.branch === null ||
            (gitStatusForActions &&
              gitStatusForActions.branch !== null &&
              !gitStatusForActions.hasWorkingTreeChanges &&
              gitStatusForActions.behindCount > 0 &&
              gitStatusForActions.aheadCount === 0) ||
            isGitStatusOutOfSync ||
            gitStatusError) && <MenuSeparator className="mx-3 mt-2" />}
          {gitStatusForActions?.branch === null && (
            <p className="px-3 py-1.5 text-xs text-warning">
              Detached HEAD: create and checkout a branch to enable push and PR actions.
            </p>
          )}
          {gitStatusForActions &&
            gitStatusForActions.branch !== null &&
            !gitStatusForActions.hasWorkingTreeChanges &&
            gitStatusForActions.behindCount > 0 &&
            gitStatusForActions.aheadCount === 0 && (
              <p className="px-3 py-1.5 text-xs text-warning">
                Behind upstream. Pull/rebase first.
              </p>
            )}
          {isGitStatusOutOfSync && (
            <p className="px-3 py-1.5 text-xs text-muted-foreground">Refreshing git status...</p>
          )}
          {gitStatusError && (
            <p className="px-3 py-1.5 text-xs text-destructive">{gitStatusError.message}</p>
          )}
        </ComposerPickerMenuPopup>
      </Menu>
    </ChatHeaderSplitGroup>
  );
}

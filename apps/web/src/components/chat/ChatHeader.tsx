// FILE: ChatHeader.tsx
// Purpose: Renders the chat top bar with project actions and panel toggles.
// Layer: Chat shell header
// Depends on: project action controls, git actions, and panel toggle callbacks

import {
  type EditorId,
  type ProjectScript,
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { isGenericChatThreadTitle } from "@t3tools/shared/chatThreads";
import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import { FiGitBranch } from "react-icons/fi";
import { HiMiniArrowsPointingOut } from "react-icons/hi2";
import { TbExchange } from "react-icons/tb";
import type { ThreadPrimarySurface } from "../../types";
import GitActionsControl from "../GitActionsControl";
import { ArrowRightIcon, HandoffIcon, PanelRightCloseIcon, TerminalIcon, XIcon } from "~/lib/icons";
import {
  CHAT_HEADER_TOGGLE_CLASS_NAME,
  ChatHeaderButton,
  ChatHeaderIconButton,
  SurfaceChipIcon,
} from "./chatHeaderControls";
import { IconButton } from "../ui/icon-button";
import { Badge } from "../ui/badge";
import { Menu, MenuItem, MenuTrigger } from "../ui/menu";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import { OpenInPicker } from "./OpenInPicker";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarHeaderNavigationControls } from "../SidebarHeaderNavigationControls";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { Toggle } from "../ui/toggle";
import { useSidebar } from "../ui/sidebar";
import { cn } from "~/lib/utils";
import { useIsDisposableThread } from "~/hooks/useIsDisposableThread";
import { useOpenFavoriteEditorShortcut } from "~/hooks/useOpenFavoriteEditorShortcut";
import type { RepoDiffTotals } from "~/hooks/useRepoDiffTotals";
import { ProviderIcon } from "../ProviderIcon";
import { ProviderUsageMenuControl } from "../ProviderUsageMenuControl";
import { EnvironmentToggle, type EnvironmentToggleState } from "./environment/EnvironmentToggle";

/**
 * Width (px) below which collapsible header controls drop their text labels and
 * fold into icon-only buttons. Measured on the header element itself, so it fires
 * for any layout that narrows the chat column (split chat, right dock, small window).
 */
const HEADER_COMPACT_BREAKPOINT = 700;

interface ChatHeaderProps {
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  activeThreadEntryPoint: ThreadPrimarySurface;
  activeProvider: ProviderKind;
  activeProjectName: string | undefined;
  threadBreadcrumbs: ReadonlyArray<{
    threadId: ThreadId;
    title: string;
  }>;
  hideHandoffControls?: boolean;
  isGitRepo: boolean;
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  diffToggleShortcutLabel: string | null;
  handoffBadgeLabel: string | null;
  handoffActionLabel: string;
  handoffDisabled: boolean;
  handoffActionTargetProviders: ReadonlyArray<ProviderKind>;
  handoffBadgeSourceProvider: ProviderKind | null;
  handoffBadgeTargetProvider: ProviderKind | null;
  gitCwd: string | null;
  diffTotals: RepoDiffTotals;
  showGitActions?: boolean;
  diffOpen: boolean;
  diffDisabledReason?: string | null;
  surfaceMode?: "single" | "split";
  isSidechat?: boolean;
  // When provided (and the thread is not disposable), the header collapses the
  // Open-in-editor + git-actions + diff-toggle cluster into one Environment button that
  // drives the Environment panel; otherwise the legacy cluster is rendered.
  environment?: EnvironmentToggleState | null;
  chatLayoutAction?: {
    kind: "split" | "maximize";
    label: string;
    shortcutLabel: string | null;
    onClick: () => void;
  } | null;
  changeThreadAction?: {
    label: string;
    onClick: () => void;
  } | null;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onToggleDiff: () => void;
  onCreateHandoff: (targetProvider: ProviderKind) => void;
  onNavigateToThread: (threadId: ThreadId) => void;
  onRenameThread: () => void;
  onCloseThreadPane?: () => void;
}

export type ChatHeaderThreadIconKind = "none" | "provider" | "terminal";

export function resolveChatHeaderThreadIconKind(
  entryPoint: ThreadPrimarySurface,
  title?: string,
): ChatHeaderThreadIconKind {
  if (entryPoint === "chat" && isGenericChatThreadTitle(title)) {
    return "none";
  }
  return entryPoint === "terminal" ? "terminal" : "provider";
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadId,
  activeThreadTitle,
  activeThreadEntryPoint,
  activeProvider,
  activeProjectName,
  threadBreadcrumbs,
  hideHandoffControls = false,
  isGitRepo,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  diffToggleShortcutLabel,
  handoffBadgeLabel,
  handoffActionLabel,
  handoffDisabled,
  handoffActionTargetProviders,
  handoffBadgeSourceProvider,
  handoffBadgeTargetProvider,
  gitCwd,
  diffTotals,
  showGitActions = true,
  diffOpen,
  diffDisabledReason = null,
  surfaceMode = "single",
  isSidechat = false,
  environment = null,
  chatLayoutAction = null,
  changeThreadAction = null,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onToggleDiff,
  onCreateHandoff,
  onNavigateToThread,
  onRenameThread,
  onCloseThreadPane,
}: ChatHeaderProps) {
  const { isMobile, state } = useSidebar();
  const headerRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const [openAddActionNonce, setOpenAddActionNonce] = useState(0);
  const {
    additions: diffAdditions,
    deletions: diffDeletions,
    hasChanges: showDiffTotals,
  } = diffTotals;
  const isDisposableThread = useIsDisposableThread(activeThreadId);

  // Own the open-favorite editor shortcut here so it survives regardless of which editor UI
  // is mounted (the legacy Open-in button, the Environment panel's Editor section, or
  // neither while the panel is closed). The header is always present for a project thread.
  useOpenFavoriteEditorShortcut({
    keybindings,
    availableEditors,
    openInCwd,
    enabled: !isDisposableThread && Boolean(activeProjectName),
  });

  const isSplitPane = surfaceMode === "split";
  // Split-chat creation moved to a shortcut only; the header keeps just the inline
  // "maximize" affordance for an already-split focused pane.
  const inlineChatLayoutAction = chatLayoutAction?.kind === "maximize" ? chatLayoutAction : null;
  const threadIconKind = resolveChatHeaderThreadIconKind(activeThreadEntryPoint, activeThreadTitle);
  const showSidechatTitleChip = isSidechat && compact;

  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const measure = () => setCompact(isSplitPane || el.clientWidth < HEADER_COMPACT_BREAKPOINT);
    measure();
    const observer = new ResizeObserver(() => measure());
    observer.observe(el);
    return () => observer.disconnect();
  }, [isSplitPane]);

  const renderProviderIcon = (provider: ProviderKind | null, className: string) => {
    return (
      <ProviderIcon
        provider={provider}
        tone="header"
        className={className}
        fallback={<FiGitBranch className={className} />}
      />
    );
  };

  // The right-side diff toggle (the "open the diff on the right" affordance). It stays in
  // the header in both layouts — beside the Environment button when that is enabled, and
  // inside the legacy cluster otherwise — so the familiar right-sidebar control is always a
  // single click away. Declared once here to avoid duplicating the markup across branches.
  const diffToggleControl = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className={cn(
              CHAT_HEADER_TOGGLE_CLASS_NAME,
              showDiffTotals ? null : "!size-7 [&_svg,&_[data-slot=central-icon]]:mx-0",
            )}
            pressed={diffOpen}
            onPressedChange={onToggleDiff}
            aria-label="Toggle diff panel"
            variant="default"
            size="xs"
            disabled={!isGitRepo || (diffDisabledReason !== null && !diffOpen)}
          >
            {showDiffTotals ? (
              <span className="inline-flex items-center gap-1">
                <span className="font-system-ui text-[length:var(--app-font-size-ui-sm,11px)] sm:text-[length:var(--app-font-size-ui-xs,10px)] font-normal tracking-normal tabular-nums text-success">
                  +{diffAdditions}
                </span>
                <span className="font-system-ui text-[length:var(--app-font-size-ui-sm,11px)] sm:text-[length:var(--app-font-size-ui-xs,10px)] font-normal tracking-normal tabular-nums text-destructive">
                  -{diffDeletions}
                </span>
              </span>
            ) : null}
            <SurfaceChipIcon icon={PanelRightCloseIcon} className="size-4" />
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">
        {!isGitRepo
          ? "Diff panel is unavailable because this project is not a git repository."
          : diffDisabledReason && !diffOpen
            ? diffDisabledReason
            : diffToggleShortcutLabel
              ? `Toggle diff panel (${diffToggleShortcutLabel})`
              : "Toggle diff panel"}
      </TooltipPopup>
    </Tooltip>
  );

  return (
    <div ref={headerRef} className="flex min-w-0 flex-1 items-center gap-2">
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center overflow-hidden",
          !isMobile && state === "collapsed" ? "gap-4" : "gap-2 sm:gap-3",
        )}
      >
        <SidebarHeaderNavigationControls />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="flex min-w-0 flex-1 flex-col">
            {threadBreadcrumbs.length > 0 ? (
              <div className="flex min-w-0 items-center gap-1 overflow-hidden text-[11px] text-muted-foreground/55">
                {threadBreadcrumbs.map((breadcrumb, index) => (
                  <React.Fragment key={breadcrumb.threadId}>
                    {index > 0 ? (
                      <span className="shrink-0 text-muted-foreground/35">/</span>
                    ) : null}
                    <button
                      type="button"
                      className="min-w-0 truncate transition-colors hover:text-foreground/80"
                      title={breadcrumb.title}
                      onClick={() => onNavigateToThread(breadcrumb.threadId)}
                    >
                      {breadcrumb.title}
                    </button>
                  </React.Fragment>
                ))}
              </div>
            ) : null}
            <div className="flex min-w-0 items-center gap-2">
              <div
                className={cn(
                  "flex min-w-0 items-center gap-2",
                  showSidechatTitleChip &&
                    "rounded-lg bg-secondary py-1 pl-2 pr-1 text-secondary-foreground",
                )}
              >
                {threadIconKind === "none" ? null : (
                  <span
                    className="inline-flex size-3.5 shrink-0 items-center justify-center"
                    title={
                      threadIconKind === "terminal"
                        ? "Terminal"
                        : PROVIDER_DISPLAY_NAMES[activeProvider]
                    }
                  >
                    {threadIconKind === "terminal" ? (
                      <TerminalIcon className="size-3.5 text-[var(--color-text-accent)]" />
                    ) : (
                      renderProviderIcon(activeProvider, "size-3.5")
                    )}
                  </span>
                )}
                <h2
                  className="max-w-[clamp(12rem,42vw,36rem)] truncate text-sm font-medium text-foreground"
                  title={activeThreadTitle}
                  onDoubleClick={() => onRenameThread()}
                >
                  {activeThreadTitle}
                </h2>
                {showSidechatTitleChip && onCloseThreadPane ? (
                  <IconButton
                    variant="chrome"
                    size="icon-xs"
                    label="Close selected sidechat"
                    tooltip="Close selected sidechat"
                    tooltipSide="bottom"
                    className="size-5 rounded-lg [-webkit-app-region:no-drag] [&_svg]:size-3"
                    onClick={(event) => {
                      event.stopPropagation();
                      onCloseThreadPane();
                    }}
                  >
                    <XIcon />
                  </IconButton>
                ) : null}
              </div>
              {!hideHandoffControls && handoffBadgeLabel ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Badge
                        variant="outline"
                        className="hidden !h-6 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-[10px] sm:inline-flex"
                      >
                        <span className="inline-flex size-4 shrink-0 items-center justify-center">
                          {renderProviderIcon(handoffBadgeSourceProvider, "size-3")}
                        </span>
                        <ArrowRightIcon className="size-2.5 shrink-0 opacity-45" />
                        <span className="inline-flex size-4 shrink-0 items-center justify-center">
                          {renderProviderIcon(handoffBadgeTargetProvider, "size-3")}
                        </span>
                      </Badge>
                    }
                  />
                  <TooltipPopup side="bottom">{handoffBadgeLabel}</TooltipPopup>
                </Tooltip>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]">
        {!isDisposableThread && !hideHandoffControls && !environment ? (
          <ProviderUsageMenuControl provider={activeProvider} />
        ) : null}
        {!isDisposableThread && !hideHandoffControls ? (
          <Menu modal={false}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <MenuTrigger
                    render={
                      <ChatHeaderButton
                        type="button"
                        tone="outline"
                        className={compact ? "gap-1" : "gap-1.5"}
                        aria-label={handoffActionLabel}
                        disabled={handoffDisabled || handoffActionTargetProviders.length === 0}
                      />
                    }
                  >
                    <HandoffIcon className="size-[1em] shrink-0 opacity-80" />
                    {!compact ? <span className="truncate font-normal">Hand off</span> : null}
                  </MenuTrigger>
                }
              />
              <TooltipPopup side="bottom">{handoffActionLabel}</TooltipPopup>
            </Tooltip>
            <ComposerPickerMenuPopup align="end" side="bottom" className="w-48 min-w-48">
              {handoffActionTargetProviders.map((provider) => (
                <MenuItem key={provider} onClick={() => onCreateHandoff(provider)}>
                  {renderProviderIcon(provider, "size-3.5 shrink-0")}
                  <span>Handoff to {PROVIDER_DISPLAY_NAMES[provider]}</span>
                </MenuItem>
              ))}
            </ComposerPickerMenuPopup>
          </Menu>
        ) : null}
        {/* Keep one shared project-actions controller mounted so both inline and
            compact header menus open the same dialog/state machine. */}
        {!isDisposableThread && activeProjectScripts ? (
          <ProjectScriptsControl
            scripts={activeProjectScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            showInlineControls={!compact}
            openAddActionNonce={openAddActionNonce}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        ) : null}

        {!isDisposableThread && inlineChatLayoutAction ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <ChatHeaderIconButton
                  type="button"
                  label={inlineChatLayoutAction.label}
                  onClick={inlineChatLayoutAction.onClick}
                >
                  <HiMiniArrowsPointingOut className="size-3.5" />
                </ChatHeaderIconButton>
              }
            />
            <TooltipPopup side="bottom">{inlineChatLayoutAction.label}</TooltipPopup>
          </Tooltip>
        ) : null}

        {/* Change thread stays as a standalone control (split/sidechat only). */}
        {!isDisposableThread && changeThreadAction ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <ChatHeaderIconButton
                  type="button"
                  label={changeThreadAction.label}
                  onClick={changeThreadAction.onClick}
                >
                  <TbExchange className="size-3.5" />
                </ChatHeaderIconButton>
              }
            />
            <TooltipPopup side="bottom">{changeThreadAction.label}</TooltipPopup>
          </Tooltip>
        ) : null}

        {/* Environment: one button consolidating Open-in-editor and git actions into the
            Environment panel. The right-side diff toggle stays beside it so the familiar
            "open the diff on the right" control is preserved. Falls back to the legacy split
            controls for disposable threads (which never surface the panel). */}
        {environment && !isDisposableThread ? (
          <>
            <EnvironmentToggle environment={environment} />
            {diffToggleControl}
          </>
        ) : (
          <>
            {/* Open in editor: dedicated split-button with an editor switcher; the project
                "Add action" entry lives at the bottom of that same menu. */}
            {!isDisposableThread && activeProjectName ? (
              <OpenInPicker
                keybindings={keybindings}
                availableEditors={availableEditors}
                openInCwd={openInCwd}
                {...(activeProjectScripts
                  ? { onAddAction: () => setOpenAddActionNonce((current) => current + 1) }
                  : {})}
              />
            ) : null}

            {!isDisposableThread && activeProjectName && showGitActions ? (
              <GitActionsControl
                gitCwd={gitCwd}
                activeThreadId={activeThreadId}
                hideQuickActionLabel={compact}
              />
            ) : null}
            {diffToggleControl}
          </>
        )}
      </div>
    </div>
  );
});

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
import { useQuery } from "@tanstack/react-query";
import React, { memo, useEffect, useRef, useState } from "react";
import { BsLayoutSplit, BsTerminal } from "react-icons/bs";
import { FiGitBranch } from "react-icons/fi";
import { HiMiniArrowsPointingOut } from "react-icons/hi2";
import { TbLayoutSidebarRight } from "react-icons/tb";
import GitActionsControl from "../GitActionsControl";
import { AppsIcon, ArrowRightIcon, GlobeIcon, PlusIcon } from "~/lib/icons";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { Toggle } from "../ui/toggle";
import { SidebarHeaderTrigger, useSidebar } from "../ui/sidebar";
import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { resolveEditorIcon } from "../../editorMetadata";
import { usePreferredEditor } from "../../editorPreferences";
import { useIsDisposableThread } from "~/hooks/useIsDisposableThread";
import { ClaudeAI, Gemini, OpenAI } from "../Icons";
import { gitStatusQueryOptions } from "~/lib/gitReactQuery";

/** Width (px) below which collapsible header controls fold into the ellipsis menu. */
const HEADER_COMPACT_BREAKPOINT = 480;

interface ChatHeaderProps {
  activeThreadId: ThreadId;
  activeThreadTitle: string;
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
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalToggleShortcutLabel: string | null;
  browserToggleShortcutLabel: string | null;
  diffToggleShortcutLabel: string | null;
  handoffBadgeLabel: string | null;
  handoffActionLabel: string;
  handoffDisabled: boolean;
  handoffActionTargetProvider: ProviderKind | null;
  handoffBadgeSourceProvider: ProviderKind | null;
  handoffBadgeTargetProvider: ProviderKind | null;
  browserOpen: boolean;
  gitCwd: string | null;
  showGitActions?: boolean;
  diffOpen: boolean;
  diffDisabledReason?: string | null;
  surfaceMode?: "single" | "split";
  chatLayoutAction?: {
    kind: "split" | "maximize";
    label: string;
    shortcutLabel: string | null;
    onClick: () => void;
  } | null;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onToggleTerminal: () => void;
  onToggleDiff: () => void;
  onToggleBrowser: () => void;
  onCreateHandoff: () => void;
  onNavigateToThread: (threadId: ThreadId) => void;
  onRenameThread: () => void;
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadId,
  activeThreadTitle,
  activeProjectName,
  threadBreadcrumbs,
  hideHandoffControls = false,
  isGitRepo,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  terminalAvailable,
  terminalOpen,
  terminalToggleShortcutLabel,
  browserToggleShortcutLabel,
  diffToggleShortcutLabel,
  handoffBadgeLabel,
  handoffActionLabel,
  handoffDisabled,
  handoffActionTargetProvider,
  handoffBadgeSourceProvider,
  handoffBadgeTargetProvider,
  browserOpen,
  gitCwd,
  showGitActions = true,
  diffOpen,
  diffDisabledReason = null,
  surfaceMode = "single",
  chatLayoutAction = null,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onToggleTerminal,
  onToggleDiff,
  onToggleBrowser,
  onCreateHandoff,
  onNavigateToThread,
  onRenameThread,
}: ChatHeaderProps) {
  const { isMobile, state } = useSidebar();
  const headerRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const [openAddActionNonce, setOpenAddActionNonce] = useState(0);
  const [preferredEditor] = usePreferredEditor(availableEditors);
  const EditorIcon = preferredEditor ? resolveEditorIcon(preferredEditor) : null;
  // Reuse the shared git status query so the diff toggle can show live totals
  // without introducing a second API shape just for the header control.
  const { data: gitStatus = null } = useQuery(gitStatusQueryOptions(gitCwd));
  const diffTotals = gitStatus?.workingTree ?? null;
  const showDiffTotals = (diffTotals?.insertions ?? 0) > 0 || (diffTotals?.deletions ?? 0) > 0;
  const isDisposableThread = useIsDisposableThread(activeThreadId);

  const isSplitPane = surfaceMode === "split";

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
    if (provider === "claudeAgent") {
      return <ClaudeAI className={cn("text-foreground", className)} />;
    }
    if (provider === "gemini") {
      return <Gemini className={cn("text-foreground", className)} />;
    }
    if (provider === "codex") {
      return <OpenAI className={cn("text-muted-foreground/75", className)} />;
    }
    return <FiGitBranch className={className} />;
  };

  return (
    <div ref={headerRef} className="flex min-w-0 flex-1 items-center gap-2">
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center overflow-hidden",
          !isMobile && state === "collapsed" ? "gap-4" : "gap-2 sm:gap-3",
        )}
      >
        <SidebarHeaderTrigger className="size-7 shrink-0" />
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
              <h2
                className="max-w-[clamp(16rem,50vw,40rem)] truncate text-sm font-medium text-foreground"
                title={activeThreadTitle}
                onDoubleClick={() => onRenameThread()}
              >
                {activeThreadTitle}
              </h2>
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
        {!isDisposableThread && !hideHandoffControls ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className={compact ? "shrink-0 gap-1" : "shrink-0 gap-1.5"}
                  aria-label={handoffActionLabel}
                  disabled={handoffDisabled}
                  onClick={onCreateHandoff}
                >
                  <FiGitBranch className="size-3.5 shrink-0" />
                  {compact ? (
                    <ArrowRightIcon className="size-2.5 shrink-0 opacity-45" />
                  ) : (
                    <span className="truncate font-normal">Hand off to</span>
                  )}
                  {renderProviderIcon(handoffActionTargetProvider, "size-3.5 shrink-0")}
                  {!compact && (
                    <span className="truncate font-normal">
                      {PROVIDER_DISPLAY_NAMES[handoffActionTargetProvider ?? "codex"]}
                    </span>
                  )}
                </Button>
              }
            />
            <TooltipPopup side="bottom">{handoffActionLabel}</TooltipPopup>
          </Tooltip>
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

        {/* Panel toggles menu — editor, terminal, browser, split chat. */}
        {!isDisposableThread &&
        (terminalAvailable || activeProjectName || chatLayoutAction || isElectron) ? (
          <Menu modal={false}>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="outline"
                  className="shrink-0"
                  aria-label="Panel toggles"
                />
              }
            >
              <AppsIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup
              align="end"
              side="bottom"
              className="w-50 rounded-lg border-border bg-popover shadow-lg"
            >
              {activeProjectName ? (
                <MenuItem
                  onClick={() => {
                    const api = readNativeApi();
                    if (api && openInCwd && preferredEditor) {
                      void api.shell.openInEditor(openInCwd, preferredEditor);
                    }
                  }}
                  disabled={!preferredEditor || !openInCwd}
                >
                  {EditorIcon ? (
                    <EditorIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : null}
                  <span>Open in editor</span>
                </MenuItem>
              ) : null}
              <MenuItem onClick={onToggleTerminal} disabled={!terminalAvailable}>
                <BsTerminal className="size-3.5 shrink-0" />
                <span>{terminalOpen ? "Hide terminal" : "Show terminal"}</span>
                {terminalToggleShortcutLabel && (
                  <span className="ml-auto text-[11px] opacity-60">
                    {terminalToggleShortcutLabel}
                  </span>
                )}
              </MenuItem>
              {isElectron ? (
                <MenuItem onClick={onToggleBrowser}>
                  <GlobeIcon className="size-3.5 shrink-0" />
                  <span>{browserOpen ? "Hide browser" : "Show browser"}</span>
                  {browserToggleShortcutLabel && (
                    <span className="ml-auto text-[11px] opacity-60">
                      {browserToggleShortcutLabel}
                    </span>
                  )}
                </MenuItem>
              ) : null}
              {chatLayoutAction ? (
                <MenuItem onClick={chatLayoutAction.onClick}>
                  {chatLayoutAction.kind === "split" ? (
                    <BsLayoutSplit className="size-3.5 shrink-0" />
                  ) : (
                    <HiMiniArrowsPointingOut className="size-3.5 shrink-0" />
                  )}
                  <span>{chatLayoutAction.label}</span>
                  {chatLayoutAction.shortcutLabel && (
                    <span className="ml-auto text-[11px] opacity-60">
                      {chatLayoutAction.shortcutLabel}
                    </span>
                  )}
                </MenuItem>
              ) : null}
              {activeProjectScripts ? (
                <>
                  <MenuSeparator className="mx-1" />
                  <MenuItem onClick={() => setOpenAddActionNonce((current) => current + 1)}>
                    <PlusIcon className="size-3.5 shrink-0" />
                    <span>Add action</span>
                  </MenuItem>
                </>
              ) : null}
            </MenuPopup>
          </Menu>
        ) : null}

        {!isDisposableThread && activeProjectName && showGitActions ? (
          <GitActionsControl gitCwd={gitCwd} activeThreadId={activeThreadId} />
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className={cn(
                  "shrink-0 border-0",
                  showDiffTotals
                    ? "gap-2 px-1.5 text-[length:var(--app-font-size-ui-sm,11px)]"
                    : "",
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
                    <span className="font-chat-code text-[length:var(--app-font-size-ui-sm,11px)] sm:text-[length:var(--app-font-size-ui-xs,10px)] font-normal tracking-normal tabular-nums text-success">
                      +{diffTotals?.insertions ?? 0}
                    </span>
                    <span className="font-chat-code text-[length:var(--app-font-size-ui-sm,11px)] sm:text-[length:var(--app-font-size-ui-xs,10px)] font-normal tracking-normal tabular-nums text-destructive">
                      -{diffTotals?.deletions ?? 0}
                    </span>
                  </span>
                ) : null}
                <TbLayoutSidebarRight className="size-3.5" />
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
      </div>
    </div>
  );
});

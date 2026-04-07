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
import { BsLayoutSplit } from "react-icons/bs";
import { FiGitBranch } from "react-icons/fi";
import { HiMiniArrowsPointingOut } from "react-icons/hi2";
import GitActionsControl from "../GitActionsControl";
import {
  ArrowRightIcon,
  DiffIcon,
  EllipsisIcon,
  GlobeIcon,
  PlusIcon,
  TerminalSquareIcon,
} from "~/lib/icons";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { Toggle } from "../ui/toggle";
import { SidebarTrigger, useSidebar } from "../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";
import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { usePreferredEditor } from "../../editorPreferences";
import { AntigravityIcon, ClaudeAI, CursorIcon, OpenAI, VisualStudioCode, Zed } from "../Icons";
import { gitStatusQueryOptions } from "~/lib/gitReactQuery";

/** Width (px) below which collapsible header controls fold into the ellipsis menu. */
const HEADER_COMPACT_BREAKPOINT = 480;

const EDITOR_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  cursor: CursorIcon,
  vscode: VisualStudioCode,
  zed: Zed,
  antigravity: AntigravityIcon,
};

interface ChatHeaderProps {
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
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
  diffOpen: boolean;
  surfaceMode?: "single" | "split";
  chatLayoutAction?: {
    kind: "split" | "maximize";
    label: string;
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
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadId,
  activeThreadTitle,
  activeProjectName,
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
  diffOpen,
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
}: ChatHeaderProps) {
  const { isMobile, state } = useSidebar();
  const needsDesktopTrafficLightInset = isElectron && !isMobile && state === "collapsed";
  const headerRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const [preferredEditor] = usePreferredEditor(availableEditors);
  const EditorIcon = preferredEditor ? EDITOR_ICONS[preferredEditor] : null;
  // Reuse the shared git status query so the diff toggle can show live totals
  // without introducing a second API shape just for the header control.
  const { data: gitStatus = null } = useQuery(gitStatusQueryOptions(gitCwd));
  const diffTotals = gitStatus?.workingTree ?? null;
  const showDiffTotals = (diffTotals?.insertions ?? 0) > 0 || (diffTotals?.deletions ?? 0) > 0;

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

  const hasCollapsibleControls = Boolean(
    activeProjectScripts || activeProjectName || terminalAvailable,
  );
  const renderProviderIcon = (provider: ProviderKind | null, className: string) => {
    if (provider === "claudeAgent") {
      return <ClaudeAI className={cn("text-[#d97757]", className)} />;
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
          "flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3",
          needsDesktopTrafficLightInset ? "pl-[84px]" : "",
        )}
      >
        <div className="shrink-0 md:hidden">
          <SidebarTrigger className="size-7 shrink-0" />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h2
            className="max-w-[clamp(16rem,50vw,40rem)] truncate text-sm font-medium text-foreground"
            title={activeThreadTitle}
          >
            {activeThreadTitle}
          </h2>
          {handoffBadgeLabel ? (
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
      <div className="flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]">
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
                  <span className="truncate">Hand off to</span>
                )}
                {renderProviderIcon(handoffActionTargetProvider, "size-3.5 shrink-0")}
                {!compact && (
                  <span className="truncate">
                    {PROVIDER_DISPLAY_NAMES[handoffActionTargetProvider ?? "codex"]}
                  </span>
                )}
              </Button>
            }
          />
          <TooltipPopup side="bottom">{handoffActionLabel}</TooltipPopup>
        </Tooltip>
        {/* Inline controls — shown when there's enough room. */}
        {!compact && (
          <>
            {activeProjectScripts ? (
              <ProjectScriptsControl
                scripts={activeProjectScripts}
                keybindings={keybindings}
                preferredScriptId={preferredScriptId}
                onRunScript={onRunProjectScript}
                onAddScript={onAddProjectScript}
                onUpdateScript={onUpdateProjectScript}
                onDeleteScript={onDeleteProjectScript}
              />
            ) : null}
            {activeProjectName ? (
              <OpenInPicker
                keybindings={keybindings}
                availableEditors={availableEditors}
                openInCwd={openInCwd}
              />
            ) : null}
            {terminalAvailable ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Toggle
                      className="shrink-0"
                      pressed={terminalOpen}
                      onPressedChange={onToggleTerminal}
                      aria-label="Toggle terminal"
                      variant="outline"
                      size="xs"
                    >
                      <TerminalSquareIcon className="size-3" />
                    </Toggle>
                  }
                />
                <TooltipPopup side="bottom">
                  {terminalToggleShortcutLabel
                    ? `Toggle terminal (${terminalToggleShortcutLabel})`
                    : "Toggle terminal"}
                </TooltipPopup>
              </Tooltip>
            ) : null}
          </>
        )}

        {/* Overflow ellipsis — shown only when compact. */}
        {compact && hasCollapsibleControls ? (
          <Menu modal={false}>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="outline"
                  className="shrink-0"
                  aria-label="More actions"
                />
              }
            >
              <EllipsisIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end" side="bottom" className="min-w-[13rem]">
              {activeProjectScripts
                ? activeProjectScripts.map((script) => (
                    <MenuItem key={script.id} onClick={() => onRunProjectScript(script)}>
                      <span className="truncate">{script.name}</span>
                    </MenuItem>
                  ))
                : null}
              {activeProjectScripts ? (
                <MenuItem
                  onClick={() => {
                    setCompact(false);
                  }}
                >
                  <PlusIcon className="size-3.5 shrink-0" />
                  <span>Add action</span>
                </MenuItem>
              ) : null}
              {activeProjectName ? (
                <>
                  <MenuSeparator className="mx-1" />
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
                </>
              ) : null}
              <MenuSeparator className="mx-1" />
              <MenuItem onClick={onToggleTerminal} disabled={!terminalAvailable}>
                <TerminalSquareIcon className="size-3.5 shrink-0" />
                <span>Terminal</span>
                {terminalToggleShortcutLabel && (
                  <span className="ml-auto text-[11px] opacity-60">
                    {terminalToggleShortcutLabel}
                  </span>
                )}
              </MenuItem>
            </MenuPopup>
          </Menu>
        ) : null}

        {activeProjectName ? (
          <GitActionsControl gitCwd={gitCwd} activeThreadId={activeThreadId} />
        ) : null}
        {chatLayoutAction ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="outline"
                  className="shrink-0"
                  aria-label={chatLayoutAction.label}
                  onClick={chatLayoutAction.onClick}
                />
              }
            >
              {chatLayoutAction.kind === "split" ? (
                <BsLayoutSplit className="size-3.5" />
              ) : (
                <HiMiniArrowsPointingOut className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="bottom">{chatLayoutAction.label}</TooltipPopup>
          </Tooltip>
        ) : null}
        {isElectron ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  className="shrink-0"
                  pressed={browserOpen}
                  onPressedChange={onToggleBrowser}
                  aria-label="Toggle browser panel"
                  variant="outline"
                  size="xs"
                >
                  <GlobeIcon className="size-3" />
                </Toggle>
              }
            />
            <TooltipPopup side="bottom">
              {browserToggleShortcutLabel
                ? `Toggle in-app browser (${browserToggleShortcutLabel})`
                : "Toggle in-app browser"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className={cn("shrink-0", showDiffTotals ? "gap-1 px-1.5 text-[12px]" : "")}
                pressed={diffOpen}
                onPressedChange={onToggleDiff}
                aria-label="Toggle diff panel"
                variant="outline"
                size="xs"
                disabled={!isGitRepo}
              >
                <DiffIcon className="size-3" />
                {showDiffTotals ? (
                  <>
                    <span className="font-mono text-[12px] font-light tracking-normal tabular-nums text-success">
                      +{diffTotals?.insertions ?? 0}
                    </span>
                    <span className="font-mono text-[12px] font-light tracking-normal tabular-nums text-destructive">
                      -{diffTotals?.deletions ?? 0}
                    </span>
                  </>
                ) : null}
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {!isGitRepo
              ? "Diff panel is unavailable because this project is not a git repository."
              : diffToggleShortcutLabel
                ? `Toggle diff panel (${diffToggleShortcutLabel})`
                : "Toggle diff panel"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
});

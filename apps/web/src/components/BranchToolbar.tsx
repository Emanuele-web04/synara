// FILE: BranchToolbar.tsx
// Purpose: Renders the chat thread's compact workspace controls, including the
// local usage popover, inline workspace handoff actions, and runtime access toggle.
import type { ThreadId, RuntimeMode } from "@t3tools/contracts";
import { deriveAssociatedWorktreeMetadata } from "@t3tools/shared/threadWorkspace";
import { LuSplit } from "react-icons/lu";
import { ChevronDownIcon, ChevronRightIcon, HandoffIcon } from "~/lib/icons";
import { FiThumbsUp } from "react-icons/fi";
import { HiOutlineHandRaised } from "react-icons/hi2";
import { PiLaptop } from "react-icons/pi";
import { useCallback, useMemo, useRef, useState } from "react";
import { useAppSettings } from "~/appSettings";

import { newCommandId, cn } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useProviderUsageSummary } from "../hooks/useProviderUsageSummary";
import { resolveThreadEnvironmentPresentation } from "../lib/threadEnvironment";
import { useStore } from "../store";
import {
  createAllThreadsSelector,
  createProjectSelector,
  createThreadSelector,
} from "../storeSelectors";
import {
  EnvMode,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
} from "./BranchToolbar.logic";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { ContextWindowMeter } from "./chat/ContextWindowMeter";
import type { ContextWindowSnapshot } from "../lib/contextWindow";
import { ProviderUsagePanelContent } from "./ProviderUsagePanelContent";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";
import type { ThreadWorkspacePatch } from "../types";

function WorktreeGlyph({ className }: { className?: string }) {
  return <LuSplit className={cn("rotate-90", className)} />;
}

interface BranchToolbarProps {
  threadId: ThreadId;
  className?: string;
  onEnvModeChange: (mode: EnvMode) => void;
  envLocked: boolean;
  runtimeMode?: RuntimeMode;
  onRuntimeModeChange?: (mode: RuntimeMode) => void;
  onHandoffToWorktree?: () => void;
  onHandoffToLocal?: () => void;
  handoffBusy?: boolean;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
  contextWindow?: ContextWindowSnapshot | null;
  cumulativeCostUsd?: number | null;
  activeContextWindowLabel?: string | null;
  pendingContextWindowLabel?: string | null;
}

export interface RuntimeUsageControlsProps {
  runtimeMode?: RuntimeMode | undefined;
  onRuntimeModeChange?: ((mode: RuntimeMode) => void) | undefined;
  contextWindow?: ContextWindowSnapshot | null | undefined;
  cumulativeCostUsd?: number | null | undefined;
  activeContextWindowLabel?: string | null | undefined;
  pendingContextWindowLabel?: string | null | undefined;
  className?: string | undefined;
}

export function RuntimeUsageControls({
  runtimeMode,
  onRuntimeModeChange,
  contextWindow,
  cumulativeCostUsd,
  activeContextWindowLabel,
  pendingContextWindowLabel,
  className,
}: RuntimeUsageControlsProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 text-[var(--color-text-foreground-secondary)]",
        className,
      )}
    >
      {runtimeMode && onRuntimeModeChange ? (
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[length:var(--app-font-size-ui-xs,10px)] font-normal transition-colors hover:text-[var(--color-text-foreground)]"
          onClick={() =>
            onRuntimeModeChange(runtimeMode === "full-access" ? "approval-required" : "full-access")
          }
          title={
            runtimeMode === "full-access"
              ? "Full access — click to require approvals"
              : "Ask every action"
          }
        >
          {runtimeMode === "full-access" ? (
            <FiThumbsUp className="size-3 shrink-0" />
          ) : (
            <HiOutlineHandRaised className="size-3 shrink-0" />
          )}
          <span className="leading-none">
            {runtimeMode === "full-access" ? "Full access" : "Default permissions"}
          </span>
        </button>
      ) : null}
      {contextWindow ? (
        <ContextWindowMeter
          usage={contextWindow}
          {...(cumulativeCostUsd != null ? { cumulativeCostUsd } : {})}
          {...(activeContextWindowLabel !== undefined
            ? { activeWindowLabel: activeContextWindowLabel }
            : {})}
          {...(pendingContextWindowLabel !== undefined
            ? { pendingWindowLabel: pendingContextWindowLabel }
            : {})}
        />
      ) : null}
    </div>
  );
}

export default function BranchToolbar({
  threadId,
  className,
  onEnvModeChange,
  envLocked,
  runtimeMode,
  onRuntimeModeChange,
  onHandoffToWorktree,
  onHandoffToLocal,
  handoffBusy = false,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
  contextWindow,
  cumulativeCostUsd,
  activeContextWindowLabel,
  pendingContextWindowLabel,
}: BranchToolbarProps) {
  const setThreadWorkspaceAction = useStore((store) => store.setThreadWorkspace);
  const draftThread = useComposerDraftStore((store) => store.getDraftThread(threadId));
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const threads = useStore(useRef(createAllThreadsSelector()).current);
  const { settings } = useAppSettings();

  const serverThread = useStore(useMemo(() => createThreadSelector(threadId), [threadId]));
  const activeProjectId = serverThread?.projectId ?? draftThread?.projectId ?? null;
  const activeProject = useStore(
    useMemo(() => createProjectSelector(activeProjectId), [activeProjectId]),
  );
  const activeThreadId = serverThread?.id ?? (draftThread ? threadId : undefined);
  const activeThreadBranch = serverThread?.branch ?? draftThread?.branch ?? null;
  const activeWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const activeProvider =
    serverThread?.session?.provider ?? serverThread?.modelSelection.provider ?? null;
  const branchCwd = activeWorktreePath ?? activeProject?.cwd ?? null;
  const hasServerThread = serverThread !== undefined;
  const effectiveEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread,
    draftThreadEnvMode: draftThread?.envMode,
    serverThreadEnvMode: serverThread?.envMode,
  });
  const environmentPresentation = resolveThreadEnvironmentPresentation({
    envMode: effectiveEnvMode,
    worktreePath: activeWorktreePath,
  });

  const setThreadWorkspace = useCallback(
    (patch: ThreadWorkspacePatch) => {
      if (!activeThreadId) return;
      const branch = patch.branch !== undefined ? patch.branch : activeThreadBranch;
      const worktreePath =
        patch.worktreePath !== undefined ? patch.worktreePath : activeWorktreePath;
      const nextEnvMode =
        patch.envMode !== undefined ? patch.envMode : worktreePath ? "worktree" : effectiveEnvMode;
      const nextAssociatedWorktree = deriveAssociatedWorktreeMetadata({
        branch,
        worktreePath,
        associatedWorktreePath:
          patch.associatedWorktreePath !== undefined
            ? patch.associatedWorktreePath
            : (serverThread?.associatedWorktreePath ?? null),
        associatedWorktreeBranch:
          patch.associatedWorktreeBranch !== undefined ? patch.associatedWorktreeBranch : branch,
        associatedWorktreeRef:
          patch.associatedWorktreeRef !== undefined ? patch.associatedWorktreeRef : branch,
      });
      const api = readNativeApi();
      // If the effective cwd is about to change, stop the running session so the
      // next message creates a new one with the correct cwd.
      if (serverThread?.session && worktreePath !== activeWorktreePath && api) {
        void api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId: activeThreadId,
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }
      if (api && hasServerThread) {
        void api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: activeThreadId,
          envMode: nextEnvMode,
          branch,
          worktreePath,
          associatedWorktreePath: nextAssociatedWorktree.associatedWorktreePath,
          associatedWorktreeBranch: nextAssociatedWorktree.associatedWorktreeBranch,
          associatedWorktreeRef: nextAssociatedWorktree.associatedWorktreeRef,
        });
      }
      if (hasServerThread) {
        setThreadWorkspaceAction(activeThreadId, {
          envMode: nextEnvMode,
          branch,
          worktreePath,
          ...nextAssociatedWorktree,
        });
        return;
      }
      const nextDraftEnvMode = resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: worktreePath,
        currentWorktreePath: activeWorktreePath,
        effectiveEnvMode,
      });
      setDraftThreadContext(threadId, {
        branch,
        worktreePath,
        envMode: nextDraftEnvMode,
      });
    },
    [
      activeThreadId,
      activeThreadBranch,
      serverThread?.session,
      activeWorktreePath,
      hasServerThread,
      setThreadWorkspaceAction,
      serverThread?.associatedWorktreePath,
      setDraftThreadContext,
      threadId,
      effectiveEnvMode,
    ],
  );

  const canHandoffToWorktree = Boolean(
    hasServerThread && envLocked && !activeWorktreePath && effectiveEnvMode === "local",
  );
  const canHandoffToLocal = Boolean(hasServerThread && activeWorktreePath);
  const canSwitchToWorktree = Boolean(
    !envLocked && !activeWorktreePath && effectiveEnvMode === "local",
  );
  const canSwitchToLocal = Boolean(!envLocked && effectiveEnvMode === "worktree");
  const showEnvPicker = effectiveEnvMode === "local" || canSwitchToLocal;

  const usageSummary = useProviderUsageSummary({
    provider: activeProvider,
    threads,
    codexHomePath: settings.codexHomePath || null,
  });
  const [rateLimitsOpen, setRateLimitsOpen] = useState(true);
  const [envPickerOpen, setEnvPickerOpen] = useState(false);

  if (!activeThreadId || !activeProject) return null;

  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-3xl items-center justify-between px-3 pb-3 pt-1",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        {showEnvPicker ? (
          <Popover open={envPickerOpen} onOpenChange={setEnvPickerOpen}>
            <PopoverTrigger className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[length:var(--app-font-size-ui-xs,10px)] font-normal text-[var(--color-text-foreground-secondary)] transition-colors hover:bg-[var(--color-background-elevated-secondary)] hover:text-[var(--color-text-foreground)]">
              {environmentPresentation.mode === "local" ? (
                <PiLaptop className="size-3.5" />
              ) : (
                <WorktreeGlyph className="size-3.5" />
              )}
              {environmentPresentation.shortLabel}
              <ChevronDownIcon className="size-3 opacity-60" />
            </PopoverTrigger>
            <PopoverPopup
              align="start"
              side="top"
              sideOffset={6}
              className="w-56 [&_[data-slot=popover-viewport]]:py-0 [&_[data-slot=popover-viewport]]:[--viewport-inline-padding:0px]"
            >
              <div className="py-1.5">
                <p className="px-3 pb-1 pt-1 text-[11px] font-medium text-[var(--color-text-foreground-secondary)]">
                  Continue in
                </p>
                {environmentPresentation.mode === "local" ? (
                  <div className="flex w-full items-center gap-2 px-3 py-1.5 text-sm">
                    <PiLaptop className="size-4 text-[var(--color-text-foreground-secondary)]" />
                    <span>{environmentPresentation.localOptionLabel}</span>
                    <svg
                      className="ml-auto size-4 text-[var(--color-text-foreground)]"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-[var(--color-text-foreground)] transition-colors hover:bg-[var(--color-background-elevated-secondary)]"
                    onClick={() => {
                      setEnvPickerOpen(false);
                      onEnvModeChange("local");
                    }}
                  >
                    <PiLaptop className="size-4 text-[var(--color-text-foreground-secondary)]" />
                    <span>{environmentPresentation.localOptionLabel}</span>
                  </button>
                )}
                {canSwitchToWorktree ? (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-[var(--color-text-foreground)] transition-colors hover:bg-[var(--color-background-elevated-secondary)]"
                    onClick={() => {
                      setEnvPickerOpen(false);
                      onEnvModeChange("worktree");
                    }}
                  >
                    <WorktreeGlyph className="size-4 text-[var(--color-text-foreground-secondary)]" />
                    <span>New worktree</span>
                  </button>
                ) : null}
                {effectiveEnvMode === "worktree" && !canHandoffToLocal ? (
                  <div className="flex w-full items-center gap-2 px-3 py-1.5 text-sm">
                    <WorktreeGlyph className="size-4 text-[var(--color-text-foreground-secondary)]" />
                    <span>{environmentPresentation.worktreeOptionLabel}</span>
                    <svg
                      className="ml-auto size-4 text-[var(--color-text-foreground)]"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </div>
                ) : null}
                {canHandoffToWorktree && onHandoffToWorktree ? (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-[var(--color-text-foreground)] transition-colors hover:bg-[var(--color-background-elevated-secondary)] disabled:pointer-events-none disabled:opacity-50"
                    disabled={handoffBusy}
                    onClick={() => {
                      setEnvPickerOpen(false);
                      onHandoffToWorktree();
                    }}
                  >
                    <WorktreeGlyph className="size-4 text-[var(--color-text-foreground-secondary)]" />
                    <span>Hand off to new worktree</span>
                  </button>
                ) : null}
                {canHandoffToLocal && onHandoffToLocal ? (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-[var(--color-text-foreground)] transition-colors hover:bg-[var(--color-background-elevated-secondary)] disabled:pointer-events-none disabled:opacity-50"
                    disabled={handoffBusy}
                    onClick={() => {
                      setEnvPickerOpen(false);
                      onHandoffToLocal();
                    }}
                  >
                    <HandoffIcon className="size-4 text-[var(--color-text-foreground-secondary)]" />
                    <span>Hand off to local</span>
                  </button>
                ) : null}
              </div>

              <div className="mx-3 border-t border-[color:var(--color-border-light)]" />

              <div className="py-1.5">
                <Collapsible open={rateLimitsOpen} onOpenChange={setRateLimitsOpen}>
                  <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm text-[var(--color-text-foreground)] transition-colors hover:bg-[var(--color-background-elevated-secondary)]">
                    <svg
                      className="size-4 text-[var(--color-text-foreground-secondary)]"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                    <span>Rate limits remaining</span>
                    <ChevronRightIcon
                      className={cn(
                        "ml-auto size-3.5 text-[var(--color-text-foreground-secondary)] transition-transform duration-150",
                        rateLimitsOpen && "rotate-90",
                      )}
                    />
                  </CollapsibleTrigger>
                  <CollapsiblePanel>
                    <ProviderUsagePanelContent
                      provider={activeProvider}
                      rateLimits={usageSummary.rateLimits}
                      usageLines={usageSummary.usageLines}
                      isLoading={usageSummary.isLoading}
                      learnMoreHref={usageSummary.learnMoreHref}
                      showTitle={false}
                      className="px-3 pb-1 pt-1"
                    />
                  </CollapsiblePanel>
                </Collapsible>
              </div>
            </PopoverPopup>
          </Popover>
        ) : (
          <span className="inline-flex items-center gap-1 px-1.5 text-[length:var(--app-font-size-ui-xs,10px)] font-normal text-[var(--color-text-foreground-secondary)]">
            <WorktreeGlyph className="size-3.5" />
            {environmentPresentation.shortLabel}
          </span>
        )}

        <BranchToolbarBranchSelector
          activeProjectCwd={activeProject.cwd}
          activeThreadBranch={activeThreadBranch}
          activeWorktreePath={activeWorktreePath}
          branchCwd={branchCwd}
          effectiveEnvMode={effectiveEnvMode}
          envLocked={envLocked}
          onSetThreadWorkspace={setThreadWorkspace}
          {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
          {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
        />
      </div>

      <RuntimeUsageControls
        runtimeMode={runtimeMode}
        onRuntimeModeChange={onRuntimeModeChange}
        contextWindow={contextWindow}
        cumulativeCostUsd={cumulativeCostUsd}
        activeContextWindowLabel={activeContextWindowLabel}
        pendingContextWindowLabel={pendingContextWindowLabel}
      />
    </div>
  );
}

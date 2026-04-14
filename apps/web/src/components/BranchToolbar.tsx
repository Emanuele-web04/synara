// FILE: BranchToolbar.tsx
// Purpose: Renders the chat thread's compact workspace controls, including the
// local usage popover, inline workspace handoff actions, and runtime access toggle.
import type { ThreadId, RuntimeMode } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { deriveAssociatedWorktreeMetadata } from "@t3tools/shared/threadWorkspace";
import { LuSplit } from "react-icons/lu";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  HandoffIcon,
} from "~/lib/icons";
import { LiaUnlockAltSolid, LiaLockSolid } from "react-icons/lia";
import { PiLaptop } from "react-icons/pi";
import { useCallback, useMemo, useState } from "react";

import { newCommandId, cn } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { resolveThreadEnvironmentPresentation } from "../lib/threadEnvironment";
import { useStore } from "../store";
import { createProjectSelector, createThreadSelector } from "../storeSelectors";
import {
  EnvMode,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
} from "./BranchToolbar.logic";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { ContextWindowMeter } from "./chat/ContextWindowMeter";
import type { ContextWindowSnapshot } from "../lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";
import type { ThreadWorkspacePatch } from "../types";
import {
  deriveAccountRateLimits,
  deriveRateLimitLearnMoreHref,
  mergeProviderRateLimits,
} from "~/lib/rateLimits";
import {
  normalizeOpenUsageSnapshot,
  normalizeOpenUsageUsageLines,
} from "~/lib/openUsageRateLimits";
import { openUsageProviderSnapshotQueryOptions } from "~/lib/openUsageReactQuery";
import { RateLimitSummaryList } from "./RateLimitSummaryList";

function WorktreeGlyph({ className }: { className?: string }) {
  return <LuSplit className={cn("rotate-90", className)} />;
}

interface BranchToolbarProps {
  threadId: ThreadId;
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
}

export default function BranchToolbar({
  threadId,
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
}: BranchToolbarProps) {
  const threads = useStore((store) => store.threads);
  const setThreadWorkspaceAction = useStore((store) => store.setThreadWorkspace);
  const draftThread = useComposerDraftStore((store) => store.getDraftThread(threadId));
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);

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

  const openUsageSnapshotQuery = useQuery(
    openUsageProviderSnapshotQueryOptions(effectiveEnvMode === "local" ? activeProvider : null),
  );
  const runtimeRateLimits = useMemo(() => {
    const derived = deriveAccountRateLimits(threads);
    return activeProvider
      ? derived.filter((rateLimit) => rateLimit.provider === activeProvider)
      : derived;
  }, [activeProvider, threads]);
  const openUsageRateLimits = useMemo(() => {
    const normalized = normalizeOpenUsageSnapshot(openUsageSnapshotQuery.data, activeProvider);
    return normalized ? [normalized] : [];
  }, [activeProvider, openUsageSnapshotQuery.data]);
  const openUsageUsageLines = useMemo(
    () => normalizeOpenUsageUsageLines(openUsageSnapshotQuery.data),
    [openUsageSnapshotQuery.data],
  );
  const rateLimits = useMemo(
    () => mergeProviderRateLimits(runtimeRateLimits, openUsageRateLimits),
    [openUsageRateLimits, runtimeRateLimits],
  );
  const learnMoreHref = useMemo(() => deriveRateLimitLearnMoreHref(rateLimits), [rateLimits]);
  const [rateLimitsOpen, setRateLimitsOpen] = useState(true);
  const [envPickerOpen, setEnvPickerOpen] = useState(false);

  if (!activeThreadId || !activeProject) return null;

  return (
    <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-3 pb-3 pt-1">
      <div className="flex items-center gap-2">
        {showEnvPicker ? (
          <Popover open={envPickerOpen} onOpenChange={setEnvPickerOpen}>
            <PopoverTrigger className="inline-flex cursor-pointer items-center gap-1 px-1.5 text-[length:var(--app-font-size-ui-xs,10px)] font-normal text-muted-foreground/70 transition-colors hover:text-foreground/80">
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
                <p className="px-3 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">
                  Continue in
                </p>
                {environmentPresentation.mode === "local" ? (
                  <div className="flex w-full items-center gap-2 px-3 py-1.5 text-sm">
                    <PiLaptop className="size-4 text-muted-foreground" />
                    <span>{environmentPresentation.localOptionLabel}</span>
                    <svg
                      className="ml-auto size-4 text-foreground"
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
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                    onClick={() => {
                      setEnvPickerOpen(false);
                      onEnvModeChange("local");
                    }}
                  >
                    <PiLaptop className="size-4 text-muted-foreground" />
                    <span>{environmentPresentation.localOptionLabel}</span>
                  </button>
                )}
                {canSwitchToWorktree ? (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                    onClick={() => {
                      setEnvPickerOpen(false);
                      onEnvModeChange("worktree");
                    }}
                  >
                    <WorktreeGlyph className="size-4 text-muted-foreground" />
                    <span>New worktree</span>
                  </button>
                ) : null}
                {effectiveEnvMode === "worktree" && !canHandoffToLocal ? (
                  <div className="flex w-full items-center gap-2 px-3 py-1.5 text-sm">
                    <WorktreeGlyph className="size-4 text-muted-foreground" />
                    <span>{environmentPresentation.worktreeOptionLabel}</span>
                    <svg
                      className="ml-auto size-4 text-foreground"
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
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                    disabled={handoffBusy}
                    onClick={() => {
                      setEnvPickerOpen(false);
                      onHandoffToWorktree();
                    }}
                  >
                    <WorktreeGlyph className="size-4 text-muted-foreground" />
                    <span>Hand off to new worktree</span>
                  </button>
                ) : null}
                {canHandoffToLocal && onHandoffToLocal ? (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                    disabled={handoffBusy}
                    onClick={() => {
                      setEnvPickerOpen(false);
                      onHandoffToLocal();
                    }}
                  >
                    <HandoffIcon className="size-4 text-muted-foreground" />
                    <span>Hand off to local</span>
                  </button>
                ) : null}
              </div>

              <div className="mx-3 border-t border-border/50" />

              <div className="py-1.5">
                <Collapsible open={rateLimitsOpen} onOpenChange={setRateLimitsOpen}>
                  <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors hover:bg-accent">
                    <svg
                      className="size-4 text-muted-foreground"
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
                        "ml-auto size-3.5 text-muted-foreground transition-transform duration-150",
                        rateLimitsOpen && "rotate-90",
                      )}
                    />
                  </CollapsibleTrigger>
                  <CollapsiblePanel>
                    <div className="space-y-2 px-3 pb-1 pt-1">
                      <RateLimitSummaryList rateLimits={rateLimits} />
                      {learnMoreHref ? (
                        <a
                          href={learnMoreHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 pt-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                        >
                          Learn more
                          <ExternalLinkIcon className="size-3" />
                        </a>
                      ) : null}
                    </div>
                  </CollapsiblePanel>
                </Collapsible>
              </div>

              {openUsageUsageLines.length > 0 ? (
                <>
                  <div className="mx-3 border-t border-border/50" />
                  <div className="space-y-2 px-3 pb-2 pt-2">
                    <p className="text-[11px] font-medium text-muted-foreground">Token usage</p>
                    {openUsageUsageLines.map((line) => (
                      <div
                        key={line.label}
                        className="flex items-start justify-between gap-3 text-xs"
                      >
                        <span className="font-medium text-foreground">{line.label}</span>
                        <span className="text-right tabular-nums text-muted-foreground">
                          <span className="text-foreground">{line.value}</span>
                          {line.subtitle ? (
                            <span className="block text-[11px] text-muted-foreground">
                              {line.subtitle}
                            </span>
                          ) : null}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
            </PopoverPopup>
          </Popover>
        ) : (
          <span className="inline-flex items-center gap-1 px-1.5 text-[length:var(--app-font-size-ui-xs,10px)] font-normal text-muted-foreground/70">
            <WorktreeGlyph className="size-3.5" />
            {environmentPresentation.shortLabel}
          </span>
        )}

        {runtimeMode && onRuntimeModeChange ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[length:var(--app-font-size-ui-xs,10px)] font-normal text-muted-foreground/70 transition-colors hover:text-foreground/80"
            onClick={() =>
              onRuntimeModeChange(
                runtimeMode === "full-access" ? "approval-required" : "full-access",
              )
            }
            title={
              runtimeMode === "full-access"
                ? "Full access — click to require approvals"
                : "Supervised — click for full access"
            }
          >
            {runtimeMode === "full-access" ? (
              <LiaUnlockAltSolid className="size-3 -scale-x-100" />
            ) : (
              <LiaLockSolid className="size-3" />
            )}
            {runtimeMode === "full-access" ? "Full access" : "Supervised"}
          </button>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
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
        {contextWindow ? (
          <ContextWindowMeter
            usage={contextWindow}
            {...(cumulativeCostUsd != null ? { cumulativeCostUsd } : {})}
          />
        ) : null}
      </div>
    </div>
  );
}

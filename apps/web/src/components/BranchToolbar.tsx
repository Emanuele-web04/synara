import type { ThreadId, RuntimeMode } from "@t3tools/contracts";
import { deriveAssociatedWorktreeMetadata } from "@t3tools/shared/threadWorkspace";
import { GitForkIcon, HandoffIcon } from "~/lib/icons";
import { LiaUnlockAltSolid, LiaLockSolid } from "react-icons/lia";
import { PiLaptop } from "react-icons/pi";
import { useCallback } from "react";

import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useStore } from "../store";
import {
  EnvMode,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
} from "./BranchToolbar.logic";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { ContextWindowMeter } from "./chat/ContextWindowMeter";
import type { ContextWindowSnapshot } from "../lib/contextWindow";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import type { ThreadWorkspacePatch } from "../types";

const envModeItems = [
  { value: "local", label: "Local" },
  { value: "worktree", label: "New worktree" },
] as const;

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
  const projects = useStore((store) => store.projects);
  const setThreadWorkspaceAction = useStore((store) => store.setThreadWorkspace);
  const draftThread = useComposerDraftStore((store) => store.getDraftThread(threadId));
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);

  const serverThread = threads.find((thread) => thread.id === threadId);
  const activeProjectId = serverThread?.projectId ?? draftThread?.projectId ?? null;
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const activeThreadId = serverThread?.id ?? (draftThread ? threadId : undefined);
  const activeThreadBranch = serverThread?.branch ?? draftThread?.branch ?? null;
  const activeWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const branchCwd = activeWorktreePath ?? activeProject?.cwd ?? null;
  const hasServerThread = serverThread !== undefined;
  const effectiveEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread,
    draftThreadEnvMode: draftThread?.envMode,
    serverThreadEnvMode: serverThread?.envMode,
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
      serverThread?.associatedWorktreeBranch,
      serverThread?.associatedWorktreePath,
      serverThread?.associatedWorktreeRef,
      setDraftThreadContext,
      threadId,
      effectiveEnvMode,
    ],
  );

  const canHandoffToWorktree = Boolean(
    hasServerThread && envLocked && !activeWorktreePath && effectiveEnvMode === "local",
  );
  const canHandoffToLocal = Boolean(hasServerThread && activeWorktreePath);

  if (!activeThreadId || !activeProject) return null;

  return (
    <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 pb-3 pt-1">
      <div className="flex items-center gap-2">
        {envLocked || activeWorktreePath ? (
          <span className="inline-flex items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-xs font-normal text-muted-foreground/70">
            {effectiveEnvMode === "worktree" ? (
              <>
                <GitForkIcon className="size-3" />
                Worktree
              </>
            ) : (
              <>
                <PiLaptop className="size-3" />
                Local
              </>
            )}
          </span>
        ) : (
          <Select
            value={effectiveEnvMode}
            onValueChange={(value) => onEnvModeChange(value as EnvMode)}
            items={envModeItems}
          >
            <SelectTrigger variant="ghost" size="xs" className="font-normal">
              {effectiveEnvMode === "worktree" ? (
                <GitForkIcon className="size-3" />
              ) : (
                <PiLaptop className="size-3" />
              )}
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="local">
                <span className="inline-flex items-center gap-1.5">
                  <PiLaptop className="size-3" />
                  Local
                </span>
              </SelectItem>
              <SelectItem value="worktree">
                <span className="inline-flex items-center gap-1.5">
                  <GitForkIcon className="size-3" />
                  New worktree
                </span>
              </SelectItem>
            </SelectPopup>
          </Select>
        )}

        {canHandoffToWorktree && onHandoffToWorktree ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-xs font-normal text-muted-foreground/70 transition-colors hover:text-foreground/80 disabled:pointer-events-none disabled:opacity-50"
            disabled={handoffBusy}
            onClick={onHandoffToWorktree}
          >
            <HandoffIcon className="size-3.5" />
            Hand off
          </button>
        ) : null}
        {canHandoffToLocal && onHandoffToLocal ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-xs font-normal text-muted-foreground/70 transition-colors hover:text-foreground/80 disabled:pointer-events-none disabled:opacity-50"
            disabled={handoffBusy}
            onClick={onHandoffToLocal}
          >
            <HandoffIcon className="size-3.5" />
            Hand off to local
          </button>
        ) : null}
        {runtimeMode && onRuntimeModeChange ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-normal text-muted-foreground/70 transition-colors hover:text-foreground/80"
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

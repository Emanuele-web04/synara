import type { OrchestrationWorktreeWorkspace } from "@synara/contracts";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { FiGitBranch } from "react-icons/fi";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";

export interface WorktreeWorkspaceRenameDialogProps {
  open: boolean;
  workspace: OrchestrationWorktreeWorkspace | null;
  /** Owner-resolved publication state. Omission keeps rename display-only. */
  branchRenameAvailability?: BranchRenameAvailability;
  onOpenChange: (open: boolean) => void;
  onRename: (input: { title: string; renameBranch: boolean }) => Promise<void>;
}

export type BranchRenameAvailability =
  | "not-ready"
  | "checking"
  | "available"
  | "protected"
  | "unverified"
  | "unavailable";

export function branchNameFromWorkspaceTitle(title: string, currentBranch: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  const separatorIndex = currentBranch.lastIndexOf("/");
  const prefix = separatorIndex > 0 ? currentBranch.slice(0, separatorIndex) : null;
  return prefix ? `${prefix}/${slug || "workspace"}` : slug || "workspace";
}

export function branchRenameHelpText(
  availability: BranchRenameAvailability,
  nextBranch: string | null,
): string {
  switch (availability) {
    case "not-ready":
      return "The branch can be renamed after this workspace is ready.";
    case "checking":
      return "Checking whether this branch is published…";
    case "available":
      return nextBranch ? `The local branch will become ${nextBranch}.` : "";
    case "protected":
      return "This branch is published or has a pull request. Rename it on GitHub first.";
    case "unverified":
      return "Synara could not verify whether this branch is published. You can still rename the workspace label.";
    case "unavailable":
      return "Branch verification is unavailable. You can still rename the workspace label.";
  }
}

export function shouldRenameWorkspaceBranch(
  requested: boolean,
  availability: BranchRenameAvailability,
): boolean {
  return requested && availability === "available";
}

export function WorktreeWorkspaceRenameDialog({
  open,
  workspace,
  branchRenameAvailability,
  onOpenChange,
  onRename,
}: WorktreeWorkspaceRenameDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const workspaceNameHelpId = useId();
  const branchRenameHelpId = useId();
  const renameErrorId = useId();
  const [title, setTitle] = useState("");
  const [renameBranch, setRenameBranch] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !workspace) return;
    setTitle(workspace.title);
    setRenameBranch(false);
    setError(null);
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, workspace]);

  const nextBranch = useMemo(
    () => (workspace?.branch ? branchNameFromWorkspaceTitle(title, workspace.branch) : null),
    [title, workspace?.branch],
  );
  const canSave = title.trim().length > 0 && !isSaving;
  const branchAvailability: BranchRenameAvailability =
    workspace?.state !== "ready" || !workspace.path || !workspace.branch
      ? "not-ready"
      : (branchRenameAvailability ?? "unavailable");
  const canRenameBranch = branchAvailability === "available";
  const branchHelpText = branchRenameHelpText(branchAvailability, nextBranch);

  const save = async () => {
    if (!canSave) return;
    setIsSaving(true);
    setError(null);
    try {
      await onRename({
        title: title.trim(),
        renameBranch: shouldRenameWorkspaceBranch(renameBranch, branchAvailability),
      });
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The workspace could not be renamed.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isSaving) onOpenChange(nextOpen);
      }}
    >
      <DialogPopup surface="solid" className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Rename workspace</DialogTitle>
          <DialogDescription>
            Change the workspace label without moving its files or interrupting active terminals.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Workspace name</span>
            <Input
              ref={inputRef}
              value={title}
              aria-describedby={`${workspaceNameHelpId}${error ? ` ${renameErrorId}` : ""}`}
              aria-invalid={error ? true : undefined}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void save();
                }
              }}
            />
            <span
              id={workspaceNameHelpId}
              className="text-xs leading-relaxed text-muted-foreground"
            >
              This changes the display name only. The workspace folder stays where it is.
            </span>
          </label>
          <label className="flex items-start gap-3 rounded-lg border border-border/65 px-3 py-2.5">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-foreground"
              checked={renameBranch}
              disabled={!canRenameBranch}
              aria-describedby={branchRenameHelpId}
              onChange={(event) => setRenameBranch(event.target.checked)}
            />
            <span className="grid min-w-0 gap-0.5">
              <span className="flex items-center gap-1.5 text-sm text-foreground">
                <FiGitBranch className="size-3.5 text-muted-foreground" />
                Also rename branch
              </span>
              <span
                id={branchRenameHelpId}
                role={branchAvailability === "checking" ? "status" : undefined}
                aria-live="polite"
                className="text-xs leading-relaxed text-muted-foreground"
              >
                {branchHelpText}
              </span>
            </span>
          </label>
          {error ? (
            <p id={renameErrorId} role="alert" className="text-xs leading-relaxed text-red-400">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={() => void save()}>
            {isSaving ? <Spinner className="size-3.5" /> : null}
            {isSaving ? "Renaming workspace…" : "Rename workspace"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

// FILE: GitActionsControl.Dialogs.tsx
// Purpose: Commit, default-branch confirmation, and create-branch dialogs for the git action control.
// Layer: Header action control (presentational)
// Exports: CommitDialog, DefaultBranchActionDialog, CreateBranchDialog.

import type { GitStatusResult } from "@t3tools/contracts";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Textarea } from "~/components/ui/textarea";
import {
  type DefaultBranchActionDialogCopy,
  type DefaultBranchConfirmableAction,
  requiresFeatureBranchForDefaultBranchAction,
} from "./GitActionsControl.logic";

type GitFileEntry = GitStatusResult["workingTree"]["files"][number];

const COMMIT_DIALOG_TITLE = "Commit changes";
const COMMIT_DIALOG_DESCRIPTION =
  "Review and confirm your commit. Leave the message blank to auto-generate one.";

interface CommitDialogProps {
  open: boolean;
  onClose: () => void;
  gitStatusForActions: GitStatusResult | null;
  isDefaultBranch: boolean;
  allFiles: readonly GitFileEntry[];
  selectedFiles: readonly GitFileEntry[];
  excludedFiles: ReadonlySet<string>;
  setExcludedFiles: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
  allSelected: boolean;
  noneSelected: boolean;
  isEditingFiles: boolean;
  setIsEditingFiles: React.Dispatch<React.SetStateAction<boolean>>;
  dialogCommitMessage: string;
  setDialogCommitMessage: (value: string) => void;
  openChangedFileInEditor: (filePath: string) => void;
  onCommit: () => void;
  onCommitOnNewBranch: () => void;
}

export function CommitDialog({
  open,
  onClose,
  gitStatusForActions,
  isDefaultBranch,
  allFiles,
  selectedFiles,
  excludedFiles,
  setExcludedFiles,
  allSelected,
  noneSelected,
  isEditingFiles,
  setIsEditingFiles,
  dialogCommitMessage,
  setDialogCommitMessage,
  openChangedFileInEditor,
  onCommit,
  onCommitOnNewBranch,
}: CommitDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose();
        }
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{COMMIT_DIALOG_TITLE}</DialogTitle>
          <DialogDescription>{COMMIT_DIALOG_DESCRIPTION}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="space-y-3 rounded-lg border border-[color:var(--color-border)] bg-[var(--color-background-elevated-secondary)] p-3 text-xs">
            <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
              <span className="text-muted-foreground">Branch</span>
              <span className="flex items-center justify-between gap-2">
                <span className="font-medium">
                  {gitStatusForActions?.branch ?? "(detached HEAD)"}
                </span>
                {isDefaultBranch && (
                  <span className="text-right text-warning text-xs">Warning: default branch</span>
                )}
              </span>
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {isEditingFiles && allFiles.length > 0 && (
                    <Checkbox
                      checked={allSelected}
                      indeterminate={!allSelected && !noneSelected}
                      onCheckedChange={() => {
                        setExcludedFiles(
                          allSelected ? new Set(allFiles.map((f) => f.path)) : new Set(),
                        );
                      }}
                    />
                  )}
                  <span className="text-muted-foreground">Files</span>
                  {!allSelected && !isEditingFiles && (
                    <span className="text-muted-foreground">
                      ({selectedFiles.length} of {allFiles.length})
                    </span>
                  )}
                </div>
                {allFiles.length > 0 && (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => setIsEditingFiles((prev) => !prev)}
                  >
                    {isEditingFiles ? "Done" : "Edit"}
                  </Button>
                )}
              </div>
              {!gitStatusForActions || allFiles.length === 0 ? (
                <p className="font-medium">none</p>
              ) : (
                <div className="space-y-2">
                  <ScrollArea className="h-44 rounded-md border border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)]">
                    <div className="space-y-1 p-1">
                      {allFiles.map((file) => {
                        const isExcluded = excludedFiles.has(file.path);
                        return (
                          <div
                            key={file.path}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1 font-mono text-xs transition-colors hover:bg-[var(--color-background-button-secondary-hover)]"
                          >
                            {isEditingFiles && (
                              <Checkbox
                                checked={!excludedFiles.has(file.path)}
                                onCheckedChange={() => {
                                  setExcludedFiles((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(file.path)) {
                                      next.delete(file.path);
                                    } else {
                                      next.add(file.path);
                                    }
                                    return next;
                                  });
                                }}
                              />
                            )}
                            {/* Raw <button> intentionally — list-row click target, not a shadcn Button. */}
                            <button
                              type="button"
                              className="group flex flex-1 items-center justify-between gap-3 text-left truncate"
                              onClick={() => openChangedFileInEditor(file.path)}
                            >
                              <span
                                className={`truncate underline-offset-2 group-hover:underline group-focus-visible:underline${isExcluded ? " text-muted-foreground" : ""}`}
                              >
                                {file.path}
                              </span>
                              <span className="shrink-0">
                                {isExcluded ? (
                                  <span className="text-muted-foreground">Excluded</span>
                                ) : (
                                  <>
                                    <span className="text-success">+{file.insertions}</span>
                                    <span className="text-muted-foreground"> / </span>
                                    <span className="text-destructive">-{file.deletions}</span>
                                  </>
                                )}
                              </span>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </ScrollArea>
                  <div className="flex justify-end font-mono">
                    <span className="text-success">
                      +{selectedFiles.reduce((sum, f) => sum + f.insertions, 0)}
                    </span>
                    <span className="text-muted-foreground"> / </span>
                    <span className="text-destructive">
                      -{selectedFiles.reduce((sum, f) => sum + f.deletions, 0)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium">Commit message (optional)</p>
            <Textarea
              value={dialogCommitMessage}
              onChange={(event) => setDialogCommitMessage(event.target.value)}
              placeholder="Leave empty to auto-generate"
              size="sm"
            />
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="outline" size="sm" disabled={noneSelected} onClick={onCommitOnNewBranch}>
            Commit on new branch
          </Button>
          <Button size="sm" disabled={noneSelected} onClick={onCommit}>
            Commit
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

interface DefaultBranchActionDialogProps {
  pendingAction: { action: DefaultBranchConfirmableAction } | null;
  copy: DefaultBranchActionDialogCopy | null;
  onAbort: () => void;
  onContinue: () => void;
  onCheckoutFeatureBranch: () => void;
}

export function DefaultBranchActionDialog({
  pendingAction,
  copy,
  onAbort,
  onContinue,
  onCheckoutFeatureBranch,
}: DefaultBranchActionDialogProps) {
  return (
    <Dialog
      open={pendingAction !== null}
      onOpenChange={(open) => {
        if (!open) {
          onAbort();
        }
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{copy?.title ?? "Run action on default branch?"}</DialogTitle>
          <DialogDescription>{copy?.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onAbort}>
            Abort
          </Button>
          <Button variant="outline" size="sm" onClick={onContinue}>
            {pendingAction && requiresFeatureBranchForDefaultBranchAction(pendingAction.action)
              ? "Create feature branch & continue"
              : (copy?.continueLabel ?? "Continue")}
          </Button>
          {pendingAction && !requiresFeatureBranchForDefaultBranchAction(pendingAction.action) ? (
            <Button size="sm" onClick={onCheckoutFeatureBranch}>
              Checkout feature branch & continue
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

interface CreateBranchDialogProps {
  open: boolean;
  onClose: () => void;
  createBranchName: string;
  setCreateBranchName: (value: string) => void;
  createBranchNameConflicts: boolean;
  onSubmit: (branchName: string) => void;
}

export function CreateBranchDialog({
  open,
  onClose,
  createBranchName,
  setCreateBranchName,
  createBranchNameConflicts,
  onSubmit,
}: CreateBranchDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose();
        }
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create Branch</DialogTitle>
          <DialogDescription>
            Create and switch to a branch from the current HEAD. Future commits, pushes, and PRs
            will use it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              const trimmedName = createBranchName.trim();
              if (!trimmedName || createBranchNameConflicts) {
                return;
              }
              onSubmit(trimmedName);
            }}
          >
            <div className="space-y-1.5">
              <label className="block font-medium text-sm" htmlFor="create-branch-name">
                Branch name
              </label>
              <Input
                autoFocus
                id="create-branch-name"
                placeholder="feature/my-change"
                value={createBranchName}
                onChange={(event) => setCreateBranchName(event.target.value)}
              />
            </div>
            {createBranchNameConflicts ? (
              <p className="text-destructive text-sm">A branch with this name already exists.</p>
            ) : null}
            <DialogFooter variant="bare">
              <Button variant="outline" size="sm" type="button" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={createBranchName.trim().length === 0 || createBranchNameConflicts}
              >
                Create Branch
              </Button>
            </DialogFooter>
          </form>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

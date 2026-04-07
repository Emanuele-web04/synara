import { useEffect, useRef } from "react";
import { HandoffIcon } from "~/lib/icons";
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

interface ThreadWorktreeHandoffDialogProps {
  open: boolean;
  branchName: string;
  busy?: boolean;
  onBranchNameChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void> | void;
}

export function ThreadWorktreeHandoffDialog({
  open,
  branchName,
  busy = false,
  onBranchNameChange,
  onOpenChange,
  onConfirm,
}: ThreadWorktreeHandoffDialogProps) {
  const branchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      branchInputRef.current?.focus();
      branchInputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader className="space-y-5">
          <div className="inline-flex size-12 items-center justify-center rounded-2xl bg-muted/60 text-foreground">
            <HandoffIcon className="size-6" />
          </div>
          <div className="space-y-2">
            <DialogTitle>Hand off thread to worktree</DialogTitle>
            <DialogDescription className="max-w-lg text-[15px] leading-7">
              Create and check out a branch in a new worktree to continue working in parallel.
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy && branchName.trim().length > 0) {
                void onConfirm();
              }
            }}
          >
            <div className="space-y-2">
              <label className="block font-medium text-sm" htmlFor="handoff-worktree-branch">
                Branch name
              </label>
              <Input
                ref={branchInputRef}
                id="handoff-worktree-branch"
                size="lg"
                value={branchName}
                onChange={(event) => onBranchNameChange(event.target.value)}
                placeholder="dpcode/my-change"
              />
            </div>
            <DialogFooter variant="bare" className="px-0 pb-0 pt-2 sm:justify-start">
              <Button
                type="submit"
                size="lg"
                className="w-full"
                disabled={busy || branchName.trim().length === 0}
              >
                {busy ? "Handing off..." : "Hand off"}
              </Button>
            </DialogFooter>
          </form>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

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
  worktreeName: string;
  busy?: boolean;
  onWorktreeNameChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void> | void;
}

export function ThreadWorktreeHandoffDialog({
  open,
  worktreeName,
  busy = false,
  onWorktreeNameChange,
  onOpenChange,
  onConfirm,
}: ThreadWorktreeHandoffDialogProps) {
  const worktreeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      worktreeInputRef.current?.focus();
      worktreeInputRef.current?.select();
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
              Create a new detached worktree from the selected base branch to continue working in
              parallel. You can create a branch later from inside the worktree.
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy && worktreeName.trim().length > 0) {
                void onConfirm();
              }
            }}
          >
            <div className="space-y-2">
              <label className="block font-medium text-sm" htmlFor="handoff-worktree-name">
                Worktree name
              </label>
              <Input
                ref={worktreeInputRef}
                id="handoff-worktree-name"
                size="lg"
                value={worktreeName}
                onChange={(event) => onWorktreeNameChange(event.target.value)}
                placeholder="dpcode/check-code"
              />
            </div>
            <DialogFooter variant="bare" className="px-0 pb-0 pt-2 sm:justify-start">
              <Button
                type="submit"
                size="lg"
                className="w-full"
                disabled={busy || worktreeName.trim().length === 0}
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

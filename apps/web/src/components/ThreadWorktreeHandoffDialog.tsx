import { useEffect, useRef } from "react";
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

  const canSubmit = !busy && worktreeName.trim().length > 0;

  const handleSubmit = () => {
    if (canSubmit) {
      void onConfirm();
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>交接到工作树</DialogTitle>
          <DialogDescription>从当前分支创建独立工作树，以便并行继续工作。</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              handleSubmit();
            }}
          >
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">工作树名称</span>
              <Input
                ref={worktreeInputRef}
                value={worktreeName}
                disabled={busy}
                onChange={(event) => onWorktreeNameChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    onOpenChange(false);
                  }
                }}
                placeholder="synara/feature-name"
              />
            </label>
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={!canSubmit}>
            {busy ? "正在交接…" : "交接"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

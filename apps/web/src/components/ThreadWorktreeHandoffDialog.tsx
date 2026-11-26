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
import { useTranslation } from "~/i18n";

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
  busy: busyProp,
  onWorktreeNameChange,
  onOpenChange,
  onConfirm,
}: ThreadWorktreeHandoffDialogProps) {
  const { t } = useTranslation();

  const busy = busyProp ?? false;
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
          <DialogTitle>{t("common:worktreeHandoff_title")}</DialogTitle>
          <DialogDescription>
            {t("common:createADetachedWorktreeFromTheCurrentBranchTo")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              handleSubmit();
            }}
          >
            <label className="grid gap-1.5">
              <span className="text-ui leading-snug font-medium text-foreground">
                {t("common:worktreeHandoff_worktreeName")}
              </span>
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
                placeholder={t("common:synaraFeatureName")}
              />
            </label>
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("common:form_cancel")}
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={!canSubmit}>
            {busy ? t("common:worktreeHandoff_handingOff") : t("common:header_handOff")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

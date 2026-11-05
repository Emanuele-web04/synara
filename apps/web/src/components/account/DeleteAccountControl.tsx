// Account erasure entry point for Settings. Reuses the shared alert dialog and
// fenced account mutation; local workspace history is never deleted here.
import { useState } from "react";
import { useTranslation } from "~/i18n";
import { useAccount } from "~/hooks/useAccount";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";

export function DeleteAccountControl() {
  const { t } = useTranslation();
  const account = useAccount();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState(false);
  const [target, setTarget] = useState<{
    id: string;
    email: string;
    accountAuthority: string;
  } | null>(null);
  const me = account.me;
  const accountAuthority =
    account.status?.state === "signed-in" ? account.status.accountAuthority : undefined;
  if (!me) return null;
  return (
    <section className="flex flex-col items-start gap-2 border-t pt-4">
      <Button
        variant="ghost"
        size="sm"
        disabled={!accountAuthority}
        onClick={() => {
          if (!accountAuthority) return;
          setConfirmation("");
          setError(false);
          setTarget({ id: me.id, email: me.email, accountAuthority });
          setOpen(true);
        }}
      >
        {t("settings:remote_account_delete_open")}
      </Button>
      <AlertDialog
        open={
          open &&
          target?.id === me.id &&
          target.email === me.email &&
          target.accountAuthority === accountAuthority
        }
        onOpenChange={setOpen}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings:remote_account_delete_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings:remote_account_delete_description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex flex-col gap-2 text-ui-sm">
            {t("settings:remote_account_delete_confirm", { email: me.email })}
            <Input
              type="email"
              autoComplete="off"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
          {error ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {t("settings:remote_account_delete_failed")}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose
              render={<Button variant="outline" size="sm" />}
              disabled={account.deleteAccount.isPending}
            >
              {t("common:form_cancel")}
            </AlertDialogClose>
            <Button
              variant="destructive"
              size="sm"
              disabled={
                account.deleteAccount.isPending ||
                confirmation.trim().toLowerCase() !== me.email.toLowerCase()
              }
              onClick={() => {
                if (!target) return;
                setError(false);
                void account.deleteAccount
                  .mutateAsync({
                    confirmation: "delete",
                    email: confirmation.trim(),
                    userId: target.id,
                    accountAuthority: target.accountAuthority,
                  })
                  .then(() => setOpen(false))
                  .catch(() => setError(true));
              }}
            >
              {account.deleteAccount.isPending
                ? t("settings:remote_account_deleting")
                : t("settings:remote_account_delete_action")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}

// Account erasure entry point for Settings. Reuses the shared alert dialog and
// fenced account mutation; local workspace history is never deleted here.
import { useState } from "react";
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
        Delete account…
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
            <AlertDialogTitle>Delete your Synara account?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes your cloud profile, synced usage, saved Inbox and managed connections.
              Chats stored on your computers remain. Access is disabled immediately and cloud
              erasure continues in the background. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex flex-col gap-2 text-ui-sm">
            Enter {me.email} to confirm
            <Input
              type="email"
              autoComplete="off"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
          {error ? (
            <p role="alert" className="text-ui-sm text-destructive">
              Could not confirm deletion. Try again; if signed out, sign in to check your account.
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose
              render={<Button variant="outline" size="sm" />}
              disabled={account.deleteAccount.isPending}
            >
              Cancel
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
              {account.deleteAccount.isPending ? "Deleting…" : "Delete account"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}

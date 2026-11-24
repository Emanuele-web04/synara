// FILE: signOutWithToast.ts
// Purpose: Sign out of the Synara account, reporting a failure as a toast. Shared by the
//          account menu in the rail and Settings › Profile.
// Layer: Account UI support
// Exports: signOutWithToast

import { toastManager } from "~/components/ui/toast";
import type { useAccount } from "~/hooks/useAccount";
import { t } from "~/i18n";
import { accountErrorMessage } from "~/lib/accountLogic";

export async function signOutWithToast(
  account: Pick<ReturnType<typeof useAccount>, "signOut">,
): Promise<void> {
  try {
    await account.signOut.mutateAsync();
  } catch (cause) {
    toastManager.add({
      type: "error",
      title: t("settings:profile_signOutFailed"),
      description: accountErrorMessage(cause, t("settings:profile_signOutRetry")),
    });
  }
}

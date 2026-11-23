// FILE: SynbotConfirmDialog.tsx
// Purpose: SynBot's one confirmation for Stop all and Remove (the kit's AlertDialog), whichever
//          surface asked: the sidebar's foot, a bot's menu, the bot sheet or the desktop app
//          menu. It shows the question kept in synbotActions.ts; after a removal it leaves the
//          removed bot's chat for SynBot's. Mounted once per window: by SynbotDesktopBridge at
//          the app root, or by the bot sheet's host inside a workspace frame (no bridge there).
// Layer: SynBot UI
// Exports: SynbotConfirmDialog

import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { useTranslation } from "~/i18n";
import {
  cancelSynbotConfirm,
  confirmSynbotAction,
  useSynbotConfirm,
  type SynbotConfirmRequest,
} from "~/synbot/synbotActions";

import { AlertDialog } from "./kit/Dialog";

export function SynbotConfirmDialog() {
  const { t } = useTranslation();
  const router = useRouter();
  const request = useSynbotConfirm((store) => store.request);
  const busy = useSynbotConfirm((store) => store.busy);
  // The last question keeps its words while the dialog closes.
  const [shown, setShown] = useState<SynbotConfirmRequest | null>(request);
  if (request !== null && request !== shown) setShown(request);

  const confirm = () => {
    void confirmSynbotAction().then((removedId) => {
      if (removedId === null) return;
      // Its chat was open: SynBot's takes its place.
      const { pathname, search } = router.state.location;
      if (pathname === "/synbot" && (search as { readonly bot?: string }).bot === removedId) {
        void router.navigate({ to: "/synbot", search: {} });
      }
    });
  };

  const removing = shown?.kind === "remove" ? shown.bot : null;
  return (
    <AlertDialog
      open={request !== null}
      title={
        removing
          ? t("synbotEditor:removeTitle", { value0: removing.name })
          : t("synbot:stopAllTitle")
      }
      message={removing ? t("synbotEditor:removeMessage") : t("synbot:stopAllDescription")}
      confirmLabel={removing ? t("synbotEditor:remove") : t("synbot:stopAll")}
      danger
      busy={busy}
      onConfirm={confirm}
      onCancel={cancelSynbotConfirm}
    />
  );
}

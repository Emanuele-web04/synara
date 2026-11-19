// FILE: useStopAction.ts
// Purpose: A card's Stop: runs the stop request, keeps the button busy until it settles, and
//          says why in a toast when it fails. Shared by the task and hand-off cards.
// Layer: SynBot hooks
// Exports: useStopAction

import { describeErrorMessage } from "@synara/shared/errorMessages";
import { useState } from "react";

import { useTranslation } from "~/i18n";

import { toastManager } from "../../ui/toast";

export function useStopAction() {
  const { t } = useTranslation();
  const [stopping, setStopping] = useState(false);
  /** `request` returns the stop's promise, or nothing when there is nothing to stop. */
  const stop = (request: () => Promise<unknown> | undefined) => {
    const pending = request();
    if (!pending) return;
    setStopping(true);
    void pending
      .catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: t("synbot:stopFailed"),
          description: describeErrorMessage(error, String(error)),
        }),
      )
      .finally(() => setStopping(false));
  };
  return { stopping, stop };
}

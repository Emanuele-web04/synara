// FILE: useCardAnswer.ts
// Purpose: Answers a SynBot choice card through bots.cardAction: one answer at a time, the
//          chosen option kept until the card's resolution arrives, a toast when it fails. Shared
//          by the choice card and the hand-off (baton) card's Start / Not now.
// Layer: SynBot thread UI hook
// Exports: useCardAnswer

import type { BotCard, ThreadId } from "@synara/contracts";
import { useState } from "react";
import { describeErrorMessage } from "@synara/shared/errorMessages";

import { useTranslation } from "~/i18n";
import { readNativeApi } from "~/nativeApi";

import { toastManager } from "../../ui/toast";

export function useCardAnswer(card: BotCard, threadId: ThreadId | null) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<string | null>(null);
  const [answered, setAnswered] = useState<{ optionId: string; label: string } | null>(null);
  const answer = (optionId: string, label: string) => {
    const api = readNativeApi();
    if (!api || !threadId || pending !== null) return;
    setPending(optionId);
    void api.bots
      .cardAction({ threadId, cardId: card.id, optionId })
      .then(() => setAnswered({ optionId, label }))
      .catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: t("synbot:answerFailed"),
          description: describeErrorMessage(error, String(error)),
        }),
      )
      .finally(() => setPending(null));
  };
  return { pending, answered, answer };
}

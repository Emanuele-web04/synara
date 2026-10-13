// FILE: ThreadDetailHydrationState.tsx
// Purpose: Render the transcript placeholder while thread history syncs (or after it fails).
// Layer: Chat presentation
// Depends on: shared Spinner and Button primitives, DelayedLoaderFade.

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";

import { DelayedLoaderFade } from "./DelayedLoaderFade";
import { useTranslation } from "~/i18n";

export const ThreadDetailHydrationState = function ThreadDetailHydrationState({
  state,
  onRetry,
}: {
  state: "loading" | "failed";
  onRetry: () => void;
}) {
  const { t } = useTranslation();

  if (state === "loading") {
    return (
      // Delayed like the chat mount loader: a snapshot that lands within a few frames
      // (a warm reconnect, a short thread) swaps in without flashing the spinner first.
      <DelayedLoaderFade>
        <div className="flex flex-col items-center gap-3 select-none">
          <Spinner
            aria-label={t("Loading conversation")}
            className="size-5 text-muted-foreground/50"
          />
          <span className="text-ui leading-snug text-muted-foreground/50">
            {t("Loading conversation")}
          </span>
        </div>
      </DelayedLoaderFade>
    );
  }
  return (
    <div className="flex flex-col items-center gap-3 select-none">
      <span className="text-ui leading-snug text-muted-foreground">
        {t("This conversation didn't load.")}
      </span>
      <Button onClick={onRetry} size="sm" variant="outline">
        {t("Try again")}
      </Button>
    </div>
  );
};

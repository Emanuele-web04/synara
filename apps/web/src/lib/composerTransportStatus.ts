import { addWsTransportStateListener } from "../wsTransportEvents";

/** Delay outage notices, but clear them immediately on recovery. Only owns UI timers. */
export function subscribeComposerTransportStatus(listener: (message: string | null) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let message: string | null = null;
  let visible = false;
  const cancelTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const unsubscribe = addWsTransportStateListener(
    (state) => {
      message =
        state === "open"
          ? null
          : state === "incompatible"
            ? "Synara connection is incompatible."
            : state === "disposed"
              ? "Disconnected from Synara."
              : "Reconnecting to Synara…";
      if (message === null) {
        cancelTimer();
        if (visible) listener(null);
        visible = false;
      } else if (visible) {
        listener(message);
      } else if (timer === undefined) {
        // Closed/connecting transitions are one continuous outage, not fresh blips.
        timer = setTimeout(() => {
          timer = undefined;
          visible = true;
          listener(message);
        }, 1500);
      }
    },
    { replayCurrent: true },
  );
  return () => {
    unsubscribe();
    cancelTimer();
  };
}

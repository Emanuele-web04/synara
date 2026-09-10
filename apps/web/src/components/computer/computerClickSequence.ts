/** Delay a single click so a paired browser click can use one desktop RPC. */
export function createComputerClickSequence(delayMs = 500) {
  let pending: { send: (count: 1 | 2) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  const clear = () => {
    if (pending) clearTimeout(pending.timer);
    pending = undefined;
  };
  return {
    flush() {
      const previous = pending;
      clear();
      previous?.send(1);
    },
    click(detail: number, send: (count: 1 | 2) => void) {
      if (pending) {
        const previous = pending;
        clear();
        if (detail === 2) {
          send(2);
          return;
        }
        previous.send(1);
      }
      pending = {
        send,
        timer: setTimeout(() => {
          clear();
          send(1);
        }, delayMs),
      };
    },
    clear,
  };
}

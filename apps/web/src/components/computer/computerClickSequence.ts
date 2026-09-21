// FILE: computerClickSequence.ts
// Purpose: Hold a single click briefly so a double click reaches the desktop as one RPC.
// Layer: web UI utility
// Exports: createComputerClickSequence, COMPUTER_DOUBLE_CLICK_WINDOW_MS
//
// The desktop's click API takes a count, and a double click has to arrive as
// one `clickCount: 2` — two separate single clicks at the same point are two
// single clicks as far as the target application is concerned. So a first
// click waits to see whether a second is coming.
//
// Every single click pays that wait, which is why the window is not generous:
// it is the delay between pressing the mouse and the desktop reacting.

/**
 * How long a single click waits for its partner.
 *
 * Platform double-click defaults sit at 500 ms (macOS) and 400 ms (GTK/Qt),
 * but those are ceilings for the slowest deliberate double click, and this
 * window is charged to every single click instead. 300 ms covers an ordinary
 * double click while keeping the pane feeling attached to the hand — and a
 * double click that misses the window still works, as two single clicks.
 */
export const COMPUTER_DOUBLE_CLICK_WINDOW_MS = 300;

export function createComputerClickSequence(delayMs = COMPUTER_DOUBLE_CLICK_WINDOW_MS) {
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

// FILE: src/debounce.ts
// Purpose: Tiny debouncer for the filter search box — commits once the user
// pauses typing, and cancels on unmount or the next keystroke.

export interface Debounced<T> {
  (value: T): void;
  cancel: () => void;
}

export function createDebounced<T>(fn: (value: T) => void, ms: number): Debounced<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const call = (value: T) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(value), ms);
  };
  call.cancel = () => clearTimeout(timer);
  return call;
}

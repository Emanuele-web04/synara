import { Debouncer } from "@tanstack/react-pacer";

export interface StateStorage<R = unknown> {
  getItem: (name: string) => string | null | Promise<string | null>;
  setItem: (name: string, value: string) => R;
  removeItem: (name: string) => R;
}

export interface DebouncedStorage<R = unknown> extends StateStorage<R> {
  flush: () => void;
}

export function createMemoryStorage(): StateStorage {
  const store = new Map<string, string>();
  return {
    getItem: (name) => store.get(name) ?? null,
    setItem: (name, value) => {
      store.set(name, value);
    },
    removeItem: (name) => {
      store.delete(name);
    },
  };
}

function isStateStorage(value: unknown): value is StateStorage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<StateStorage>;
  return (
    typeof candidate.getItem === "function" &&
    typeof candidate.setItem === "function" &&
    typeof candidate.removeItem === "function"
  );
}

export function createBrowserStateStorage(): StateStorage {
  return isStateStorage(globalThis.localStorage) ? globalThis.localStorage : createMemoryStorage();
}

export function createDebouncedStorage(
  baseStorage: StateStorage,
  debounceMs: number = 300,
): DebouncedStorage {
  const debouncedSetItem = new Debouncer(
    (name: string, value: string) => {
      baseStorage.setItem(name, value);
    },
    { wait: debounceMs },
  );

  return {
    getItem: (name) => baseStorage.getItem(name),
    setItem: (name, value) => {
      debouncedSetItem.maybeExecute(name, value);
    },
    removeItem: (name) => {
      debouncedSetItem.cancel();
      baseStorage.removeItem(name);
    },
    flush: () => {
      debouncedSetItem.flush();
    },
  };
}

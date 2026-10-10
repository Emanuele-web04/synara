import { Debouncer } from "@tanstack/react-pacer";
import type { PersistStorage, StorageValue } from "zustand/middleware";

export interface StateStorage<R = unknown> {
  getItem: (name: string) => string | null | Promise<string | null>;
  setItem: (name: string, value: string) => R;
  removeItem: (name: string) => R;
}

export interface DeferredPersistStorage<S> extends PersistStorage<S> {
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

// defers partialize + JSON.stringify off the hot set() path — zustand's createJSONStorage serializes the whole store synchronously per keystroke (dominant cost for stores with base64 images); here setItem only captures the latest reference and serialization runs once in the debounced flush. IMPORTANT: pass partialize here, NOT in the persist config, or it runs eagerly per set() and again at flush
interface PageHideEventTarget {
  readonly addEventListener: (type: string, listener: () => void) => void;
}

interface PageVisibilityTarget extends PageHideEventTarget {
  readonly visibilityState: string;
}

export interface FlushBeforePageHideEnv {
  readonly window?: PageHideEventTarget | undefined;
  readonly document?: PageVisibilityTarget | undefined;
}

/**
 * Flush a debounced/deferred storage before the page goes away, so at most one
 * debounce window of changes can be lost. Wires `beforeunload`, `pagehide`, and
 * `visibilitychange`→hidden — the latter two fire on mobile/bfcache navigations
 * where `beforeunload` does not. No-ops when the DOM globals are unavailable
 * (SSR / non-browser test environments), and is injectable for testing.
 */
export function flushStorageBeforePageHide(
  flush: () => void,
  env: FlushBeforePageHideEnv = {
    window: typeof window !== "undefined" ? window : undefined,
    document: typeof document !== "undefined" ? document : undefined,
  },
): void {
  // guard each capability separately — test environments stub partial globals and this runs at module scope: a missing listener API must degrade to no-op, never crash evaluation
  const win = env.window;
  if (typeof win?.addEventListener === "function") {
    win.addEventListener("beforeunload", flush);
    win.addEventListener("pagehide", flush);
  }
  const doc = env.document;
  if (typeof doc?.addEventListener === "function") {
    doc.addEventListener("visibilitychange", () => {
      if (doc.visibilityState === "hidden") {
        flush();
      }
    });
  }
}

export function createDeferredPersistStorage<State, Persisted = State>(options: {
  readonly getStorage: () => StateStorage;
  readonly partialize: (state: State) => Persisted;
  readonly debounceMs?: number;
}): DeferredPersistStorage<Persisted> {
  const { getStorage, partialize, debounceMs = 300 } = options;

  // zustand calls setItem with the FULL store state as value.state — typed as Persisted per the contract but really State
  let pending: { readonly name: string; readonly value: StorageValue<Persisted> } | null = null;

  const writePending = (): void => {
    if (pending === null) {
      return;
    }
    const { name, value } = pending;
    pending = null;
    // Mirror zustand's `{ state, version }` StorageValue key order so the produced bytes stay identical to createJSONStorage for the same state.
    getStorage().setItem(
      name,
      JSON.stringify({
        state: partialize(value.state as unknown as State),
        version: value.version,
      }),
    );
  };

  const debouncedWrite = new Debouncer(() => writePending(), { wait: debounceMs });

  const parse = (value: string | null): StorageValue<Persisted> | null =>
    value === null ? null : (JSON.parse(value) as StorageValue<Persisted>);

  return {
    getItem: (name) => {
      const raw = getStorage().getItem(name);
      return raw instanceof Promise ? raw.then(parse) : parse(raw);
    },
    setItem: (name, value) => {
      pending = { name, value };
      debouncedWrite.maybeExecute();
    },
    removeItem: (name) => {
      pending = null;
      debouncedWrite.cancel();
      getStorage().removeItem(name);
    },
    flush: () => {
      debouncedWrite.cancel();
      writePending();
    },
  };
}

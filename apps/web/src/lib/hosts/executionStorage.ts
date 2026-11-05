import { executionKey, readExecutionContext } from "./executionContext";

/** A legacy origin belongs to the first verified local environment only. */
export function claimLegacyExecutionStorage(storage: Storage): boolean {
  if (readExecutionContext()?.remote !== null) return false;
  const ownerKey = "synara:legacy-execution-owner:v1";
  const prefix = executionKey("");
  if (storage.getItem(ownerKey) === null) storage.setItem(ownerKey, prefix);
  return storage.getItem(ownerKey) === prefix;
}

/** A captured storage scope; no replacement of the browser's Storage globals. */
export function createExecutionStorage(storage: Storage): Storage {
  const prefix = executionKey("");
  const local = claimLegacyExecutionStorage(storage);
  const physical = (key: string) => `${prefix}${key}`;
  const marker = (key: string) => `${prefix}migration:${key}`;
  const keys = () =>
    Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter(
      (key): key is string =>
        key !== null && key.startsWith(prefix) && !key.startsWith(`${prefix}migration:`),
    );
  return {
    get length() {
      return keys().length;
    },
    key: (index) => keys()[index]?.slice(prefix.length) ?? null,
    getItem: (key) => {
      const value = storage.getItem(physical(key));
      if (value !== null || !prefix || !local || storage.getItem(marker(key)) !== null)
        return value;
      const legacy = storage.getItem(key);
      if (legacy !== null) storage.setItem(physical(key), legacy);
      storage.setItem(marker(key), "copied");
      return legacy;
    },
    setItem: (key, value) => {
      storage.setItem(physical(key), value);
      if (prefix && local) storage.setItem(marker(key), "copied");
    },
    removeItem: (key) => {
      if (prefix && local) storage.setItem(marker(key), "copied");
      storage.removeItem(physical(key));
    },
    clear: () => {
      for (const key of keys()) {
        if (prefix && local) storage.setItem(marker(key.slice(prefix.length)), "copied");
        storage.removeItem(key);
      }
    },
  };
}
const storageAdapters = new WeakMap<Storage, Storage>();
// Resolve lazily: bootstrap must verify the environment before stores hydrate.
export const executionStorage: Storage = {
  get length() {
    return local().length;
  },
  key: (i) => local().key(i),
  getItem: (key) => local().getItem(key),
  setItem: (key, value) => local().setItem(key, value),
  removeItem: (key) => local().removeItem(key),
  clear: () => local().clear(),
};
export const executionSessionStorage: Storage = {
  get length() {
    return session().length;
  },
  key: (i) => session().key(i),
  getItem: (key) => session().getItem(key),
  setItem: (key, value) => session().setItem(key, value),
  removeItem: (key) => session().removeItem(key),
  clear: () => session().clear(),
};
function adapter(storage: Storage | undefined): Storage {
  if (!storage) throw new Error("Browser storage is unavailable");
  let scoped = storageAdapters.get(storage);
  if (!scoped) {
    scoped = createExecutionStorage(storage);
    storageAdapters.set(storage, scoped);
  }
  return scoped;
}
function local(): Storage {
  return adapter(globalThis.localStorage ?? globalThis.window?.localStorage);
}
function session(): Storage {
  return adapter(globalThis.sessionStorage ?? globalThis.window?.sessionStorage);
}

/** Resolve inside Zustand's storage factory so SSR can use its in-memory fallback. */
export function getExecutionStorage(): Storage {
  return local();
}

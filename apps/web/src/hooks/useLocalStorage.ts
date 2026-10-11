import * as Schema from "effect/Schema";
import * as Record from "effect/Record";
import { useCallback, useEffect, useRef, useState } from "react";

const isomorphicLocalStorage: Storage =
  typeof window !== "undefined"
    ? window.localStorage
    : (function () {
        const store = new Map<string, string>();
        return {
          clear: () => store.clear(),
          getItem: (_) => store.get(_) ?? null,
          key: (_) => Record.keys(store).at(_) ?? null,
          get length() {
            return store.size;
          },
          removeItem: (_) => store.delete(_),
          setItem: (_, value) => store.set(_, value),
        };
      })();

// Reuse the JSON schema (and Effect's compiled parser) across subscribers. This caches
// schema machinery only; `getLocalStorageItem` fetches and validates on every call.
const jsonSchemasByCodec = new WeakMap<Schema.Top, Schema.Codec<unknown, string>>();

function getJsonSchema<T, E>(schema: Schema.Codec<T, E>): Schema.Codec<T, string> {
  let jsonSchema = jsonSchemasByCodec.get(schema);
  if (!jsonSchema) {
    jsonSchema = Schema.fromJsonString(schema);
    jsonSchemasByCodec.set(schema, jsonSchema);
  }
  // The schema identity ties the cached decoded type to the caller's T.
  return jsonSchema as Schema.Codec<T, string>;
}

const decode = <T, E>(schema: Schema.Codec<T, E>, value: string) =>
  Schema.decodeSync(getJsonSchema(schema))(value);

const encode = <T, E>(schema: Schema.Codec<T, E>, value: T) =>
  Schema.encodeSync(getJsonSchema(schema))(value);

export const getLocalStorageItem = <T, E>(key: string, schema: Schema.Codec<T, E>): T | null => {
  const item = isomorphicLocalStorage.getItem(key);
  return item ? decode(schema, item) : null;
};

export const setLocalStorageItem = <T, E>(key: string, value: T, schema: Schema.Codec<T, E>) => {
  const valueToSet = encode(schema, value);
  isomorphicLocalStorage.setItem(key, valueToSet);
};

export const removeLocalStorageItem = (key: string) => {
  isomorphicLocalStorage.removeItem(key);
};

const LOCAL_STORAGE_CHANGE_EVENT = "synara:local_storage_change";

interface LocalStorageChangeDetail {
  key: string;
}

function dispatchLocalStorageChange(key: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<LocalStorageChangeDetail>(LOCAL_STORAGE_CHANGE_EVENT, {
      detail: { key },
    }),
  );
}

// The hook's subscribers of one key share the decode of its current raw string. A write
// notifies every subscriber, and each used to parse and schema-validate the same string
// again (app settings: a large schema, dozens of subscribers, one write per subscriber at
// startup). The raw string is still fetched on every read, so the entry can never be stale;
// an unchanged string also returns the same object, which lets React skip the re-render.
const decodedSubscriberValueByKey = new Map<
  string,
  { raw: string; schema: Schema.Top; value: unknown }
>();

function getSubscriberLocalStorageItem<T, E>(key: string, schema: Schema.Codec<T, E>): T | null {
  const raw = isomorphicLocalStorage.getItem(key);
  if (!raw) {
    return null;
  }
  const cached = decodedSubscriberValueByKey.get(key);
  if (cached && cached.raw === raw && cached.schema === schema) {
    return cached.value as T;
  }
  const value = decode(schema, raw);
  decodedSubscriberValueByKey.set(key, { raw, schema, value });
  return value;
}

/**
 * The one place that reads a key and survives a corrupt or undecodable entry.
 *
 * All three read sites below (initial state, key change, cross-tab sync) need exactly this, and it
 * lives at module scope on purpose: React Compiler cannot lower a `??` inside a `try` block, so an
 * inlined copy would make the whole hook — which most of the app calls — skip compilation.
 */
function readLocalStorageItemOrFallback<T, E>(
  key: string,
  fallback: T,
  schema: Schema.Codec<T, E>,
): T {
  try {
    const item = getSubscriberLocalStorageItem(key, schema);
    return item ?? fallback;
  } catch (error) {
    console.error("[LOCALSTORAGE] Error:", error);
    return fallback;
  }
}

/** Persists one write, mirroring `useState`'s updater-or-value contract. Module scope: see above. */
function persistLocalStorageValue<T, E>(
  key: string,
  previous: T,
  value: T | ((val: T) => T),
  schema: Schema.Codec<T, E>,
): T {
  const valueToStore = typeof value === "function" ? (value as (val: T) => T)(previous) : value;
  try {
    if (valueToStore === null) {
      removeLocalStorageItem(key);
    } else {
      const raw = encode(schema, valueToStore);
      if (isomorphicLocalStorage.getItem(key) === raw) {
        // Storage already holds exactly this (a normalization that changed nothing), so
        // there is nothing to persist. Settle on the shared decoded value, which is what
        // the notification syncs this subscriber to anyway. Still notify: a subscriber left
        // stale by a write that bypassed the hook catches up, and in-sync ones bail out.
        queueMicrotask(() => dispatchLocalStorageChange(key));
        return getSubscriberLocalStorageItem(key, schema) ?? valueToStore;
      }
      isomorphicLocalStorage.setItem(key, raw);
    }
    // Dispatch event after state update completes to avoid nested state updates
    queueMicrotask(() => dispatchLocalStorageChange(key));
  } catch (error) {
    console.error("[LOCALSTORAGE] Error:", error);
  }
  return valueToStore;
}

export function useLocalStorage<T, E>(
  key: string,
  initialValue: T,
  schema: Schema.Codec<T, E>,
): [T, (value: T | ((val: T) => T)) => void] {
  // Get the initial value from localStorage or use the provided initialValue
  const [storedValue, setStoredValue] = useState<T>(() =>
    readLocalStorageItemOrFallback(key, initialValue, schema),
  );

  // Return a wrapped version of useState's setter function that persists the new value to localStorage
  const setValue = useCallback(
    (value: T | ((val: T) => T)) => {
      setStoredValue((prev) => persistLocalStorageValue(key, prev, value, schema));
    },
    [key, schema],
  );

  const prevKeyRef = useRef(key);

  // Re-sync from localStorage when key changes. Timeout-0 keeps the state
  // write asynchronous (compiler-eligible); key changes are rare and the
  // fresh value lands within a frame.
  useEffect(() => {
    if (prevKeyRef.current === key) {
      return;
    }
    prevKeyRef.current = key;
    const timeoutId = window.setTimeout(() => {
      setStoredValue(readLocalStorageItemOrFallback(key, initialValue, schema));
    }, 0);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [key, initialValue, schema]);

  // Listen for storage events from other tabs AND custom events from the same tab
  useEffect(() => {
    const syncFromStorage = () => {
      setStoredValue(readLocalStorageItemOrFallback(key, initialValue, schema));
    };

    const handleStorageChange = (event: StorageEvent) => {
      const affectsLocalStorage =
        event.storageArea === null || event.storageArea === isomorphicLocalStorage;
      // Browsers report localStorage.clear() with key === null; every subscribed key must reset.
      if (affectsLocalStorage && (event.key === null || event.key === key)) {
        syncFromStorage();
      }
    };

    const handleLocalChange = (event: CustomEvent<LocalStorageChangeDetail>) => {
      if (event.detail.key === key) {
        syncFromStorage();
      }
    };

    window.addEventListener("storage", handleStorageChange);
    window.addEventListener(LOCAL_STORAGE_CHANGE_EVENT, handleLocalChange as EventListener);

    return () => {
      window.removeEventListener("storage", handleStorageChange);
      window.removeEventListener(LOCAL_STORAGE_CHANGE_EVENT, handleLocalChange as EventListener);
    };
  }, [key, initialValue, schema]);

  return [storedValue, setValue];
}

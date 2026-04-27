import { useSyncExternalStore } from "react";

export type FeatureFlag =
  | {
      id: "trigger-action-failed-toasts";
      kind: "action";
      label: string;
      description: string;
    }
  | {
      id: ToggleFeatureFlagId;
      kind: "toggle";
      label: string;
      description: string;
      defaultEnabled: boolean;
    };

export type ToggleFeatureFlagId =
  | "persist-action-failed-debug-toasts"
  | "show-expanded-cursor-model-variants";

type FeatureFlagState = Record<ToggleFeatureFlagId, boolean>;

const FEATURE_FLAG_STORAGE_KEY = "dpcode:feature-flags";

const DEFAULT_FEATURE_FLAG_STATE: FeatureFlagState = {
  "persist-action-failed-debug-toasts": false,
  "show-expanded-cursor-model-variants": false,
};

export const FEATURE_FLAGS: readonly FeatureFlag[] = [
  {
    id: "trigger-action-failed-toasts",
    kind: "action",
    label: "Trigger action failed toasts",
    description: "Show stacked Git action failure toasts for local UI testing.",
  },
  {
    id: "persist-action-failed-debug-toasts",
    kind: "toggle",
    label: "Keep debug error toasts open",
    description: "Disable auto-dismiss for locally triggered error toasts.",
    defaultEnabled: DEFAULT_FEATURE_FLAG_STATE["persist-action-failed-debug-toasts"],
  },
  {
    id: "show-expanded-cursor-model-variants",
    kind: "toggle",
    label: "Show Cursor model variants",
    description: "Show every Cursor CLI model variant as a separate picker row.",
    defaultEnabled: DEFAULT_FEATURE_FLAG_STATE["show-expanded-cursor-model-variants"],
  },
];

const listeners = new Set<() => void>();
let memoryState = DEFAULT_FEATURE_FLAG_STATE;
let cachedRawFeatureFlagState: string | null | undefined;
let cachedFeatureFlagState = DEFAULT_FEATURE_FLAG_STATE;

function canUseLocalStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function normalizeFeatureFlagState(value: unknown): FeatureFlagState {
  if (!value || typeof value !== "object") {
    return DEFAULT_FEATURE_FLAG_STATE;
  }

  const record = value as Partial<Record<ToggleFeatureFlagId, unknown>>;
  return {
    "persist-action-failed-debug-toasts":
      typeof record["persist-action-failed-debug-toasts"] === "boolean"
        ? record["persist-action-failed-debug-toasts"]
        : DEFAULT_FEATURE_FLAG_STATE["persist-action-failed-debug-toasts"],
    "show-expanded-cursor-model-variants":
      typeof record["show-expanded-cursor-model-variants"] === "boolean"
        ? record["show-expanded-cursor-model-variants"]
        : DEFAULT_FEATURE_FLAG_STATE["show-expanded-cursor-model-variants"],
  };
}

function readFeatureFlagState(): FeatureFlagState {
  if (!canUseLocalStorage()) {
    return memoryState;
  }

  try {
    const raw = window.localStorage.getItem(FEATURE_FLAG_STORAGE_KEY);
    if (raw === cachedRawFeatureFlagState) {
      return cachedFeatureFlagState;
    }

    cachedRawFeatureFlagState = raw;
    cachedFeatureFlagState = normalizeFeatureFlagState(raw ? JSON.parse(raw) : null);
    return cachedFeatureFlagState;
  } catch {
    return DEFAULT_FEATURE_FLAG_STATE;
  }
}

function writeFeatureFlagState(state: FeatureFlagState): void {
  memoryState = state;

  if (canUseLocalStorage()) {
    try {
      const raw = JSON.stringify(state);
      window.localStorage.setItem(FEATURE_FLAG_STORAGE_KEY, raw);
      cachedRawFeatureFlagState = raw;
      cachedFeatureFlagState = state;
    } catch {
      // Local feature flags are best-effort developer tools.
    }
  }

  for (const listener of listeners) {
    listener();
  }
}

function subscribeFeatureFlags(listener: () => void): () => void {
  listeners.add(listener);

  if (typeof window === "undefined") {
    return () => {
      listeners.delete(listener);
    };
  }

  const onStorage = (event: StorageEvent) => {
    if (event.key === FEATURE_FLAG_STORAGE_KEY) {
      listener();
    }
  };

  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function setFeatureFlagEnabled(id: ToggleFeatureFlagId, enabled: boolean): void {
  writeFeatureFlagState({
    ...readFeatureFlagState(),
    [id]: enabled,
  });
}

export function useFeatureFlags(): FeatureFlagState {
  return useSyncExternalStore(
    subscribeFeatureFlags,
    readFeatureFlagState,
    () => DEFAULT_FEATURE_FLAG_STATE,
  );
}

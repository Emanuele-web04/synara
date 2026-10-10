// Void is the one Space label a user cannot rename through orchestration commands — presentation only, resolved synchronously from local storage before any query settles; windows sync via `storage`

import { SPACE_NAME_MAX_LENGTH } from "@synara/contracts";
import { create } from "zustand";

import {
  DEFAULT_VOID_SPACE,
  isVoidSpaceIconName,
  type VoidSpacePresentation,
} from "~/lib/spaceGrouping";

const STORAGE_KEY = "synara:void-space:v1";

// accept anything and answer with a safe presentation — a non-empty name within the Space length limit and an icon the renderer actually has
export function normalizeVoidSpace(value: unknown): VoidSpacePresentation {
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const name =
    typeof record.name === "string" ? record.name.trim().slice(0, SPACE_NAME_MAX_LENGTH) : "";
  const icon =
    typeof record.icon === "string" && isVoidSpaceIconName(record.icon)
      ? record.icon
      : DEFAULT_VOID_SPACE.icon;
  return { name: name.length > 0 ? name : DEFAULT_VOID_SPACE.name, icon };
}

function readPersisted(): VoidSpacePresentation {
  if (typeof window === "undefined") return DEFAULT_VOID_SPACE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeVoidSpace(JSON.parse(raw)) : DEFAULT_VOID_SPACE;
  } catch {
    return DEFAULT_VOID_SPACE;
  }
}

function persist(voidSpace: VoidSpacePresentation): void {
  if (typeof window === "undefined") return;
  try {
    // The default is stored as an absent key, so an install that never renamed Void keeps following the product default if it ever changes.
    if (voidSpace.name === DEFAULT_VOID_SPACE.name && voidSpace.icon === DEFAULT_VOID_SPACE.icon) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(voidSpace));
  } catch {
    // A blocked storage API must not make renaming fail; the name still applies this session.
  }
}

interface VoidSpaceState {
  voidSpace: VoidSpacePresentation;
  /** Patch semantics: an icon-only edit must not clear a name set from another surface. */
  setVoidSpace: (patch: Partial<VoidSpacePresentation>) => void;
  resetVoidSpace: () => void;
}

export const useVoidSpaceStore = create<VoidSpaceState>((set, get) => ({
  voidSpace: readPersisted(),
  setVoidSpace: (patch) => {
    const next = normalizeVoidSpace({ ...get().voidSpace, ...patch });
    const current = get().voidSpace;
    if (next.name === current.name && next.icon === current.icon) return;
    set({ voidSpace: next });
    persist(next);
  },
  resetVoidSpace: () => {
    if (
      get().voidSpace.name === DEFAULT_VOID_SPACE.name &&
      get().voidSpace.icon === DEFAULT_VOID_SPACE.icon
    ) {
      return;
    }
    set({ voidSpace: DEFAULT_VOID_SPACE });
    persist(DEFAULT_VOID_SPACE);
  },
}));

if (typeof window !== "undefined") {
  // Renaming in one window has to reach the others: every window renders this label in its sidebar, and `storage` only fires in the windows that did not write.
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    useVoidSpaceStore.setState({ voidSpace: readPersisted() });
  });
}

export function useVoidSpace(): VoidSpacePresentation {
  return useVoidSpaceStore((state) => state.voidSpace);
}

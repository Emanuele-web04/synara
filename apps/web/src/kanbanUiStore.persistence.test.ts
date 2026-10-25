import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { useKanbanUiStore } from "./kanbanUiStore";

type KanbanUiStore = typeof useKanbanUiStore;

function installMemoryLocalStorage() {
  const entries = new Map<string, string>();

  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => entries.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      entries.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      entries.delete(key);
    }),
    clear: vi.fn(() => {
      entries.clear();
    }),
    key: vi.fn((index: number) => Array.from(entries.keys())[index] ?? null),
    get length() {
      return entries.size;
    },
  });
}

// Each test must import the module fresh so the resetModules in beforeEach
// rebuilds the zustand persist layer against the stubbed localStorage.
const loadStore = async () => (await import("./kanbanUiStore")).useKanbanUiStore as KanbanUiStore;

function persistApi(store: KanbanUiStore) {
  return store.persist as unknown as {
    getOptions: () => {
      partialize: (
        state: ReturnType<typeof store.getState>,
      ) => Partial<ReturnType<typeof store.getState>>;
      merge: (
        persistedState: unknown,
        currentState: ReturnType<typeof store.getState>,
      ) => ReturnType<typeof store.getState>;
    };
  };
}

describe("kanbanUiStore view-mode persistence", () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults fresh state to the v2 board with folded review", async () => {
    const state = (await loadStore()).getState();
    expect(state.kanbanViewMode).toBe("v2");
    expect(state.kanbanNeedsReviewFilter).toBe(false);
  });

  it("round-trips persisted classic mode through partialize and merge", async () => {
    const store = await loadStore();
    store.setState((state) => ({
      ...state,
      kanbanViewMode: "classic",
      kanbanNeedsReviewFilter: true,
    }));
    const options = persistApi(store).getOptions();
    const persistedState = options.partialize(store.getState());

    expect(persistedState.kanbanViewMode).toBe("classic");
    expect(persistedState.kanbanNeedsReviewFilter).toBe(true);

    const merged = options.merge(persistedState, store.getInitialState());
    expect(merged.kanbanViewMode).toBe("classic");
    expect(merged.kanbanNeedsReviewFilter).toBe(true);
  });

  it("turns the filter off with the reveal so a stale fold never persists alone (H1)", async () => {
    const store = await loadStore();
    store.setState((state) => ({
      ...state,
      kanbanNeedsReviewFilter: true,
      hasRevealedReviewFold: true,
    }));
    store.getState().setKanbanNeedsReviewFilter(false);
    const state = store.getState();
    expect(state.kanbanNeedsReviewFilter).toBe(false);
    expect(state.hasRevealedReviewFold).toBe(false);
  });
});

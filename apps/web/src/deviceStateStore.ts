// the live surface is a canvas fed by binary frames; this store keeps pane-chrome metadata so a thread switch renders instantly and a late push can't roll back a generation — deliberately not persisted (a stale "Booted" would lie)

import type { DeviceOpenPaneRequestedEvent, ThreadDeviceState, ThreadId } from "@synara/contracts";
import { create } from "zustand";

interface DeviceStateStore {
  threadStatesByThreadId: Record<string, ThreadDeviceState | undefined>;
  pendingOpenRequests: Record<string, DeviceOpenPaneRequestedEvent | undefined>;
  queueOpenRequest: (event: DeviceOpenPaneRequestedEvent) => void;
  takeOpenRequests: () => DeviceOpenPaneRequestedEvent[];
  upsertThreadState: (state: ThreadDeviceState) => void;
  removeThreadState: (threadId: ThreadId) => void;
  clear: () => void;
}

export const useDeviceStateStore = create<DeviceStateStore>()((set, get) => ({
  threadStatesByThreadId: {},
  pendingOpenRequests: {},
  queueOpenRequest: (event) =>
    set((current) => ({
      pendingOpenRequests: { ...current.pendingOpenRequests, [event.threadId]: event },
    })),
  takeOpenRequests: () => {
    const requests = Object.values(get().pendingOpenRequests).filter(
      (event) => event !== undefined,
    );
    if (requests.length > 0) set({ pendingOpenRequests: {} });
    return requests;
  },
  upsertThreadState: (state) =>
    set((current) => {
      const previousState = current.threadStatesByThreadId[state.threadId];
      // version is monotonic per thread — a slow getThreadState response at or behind it is a straggler and must not overwrite live lists
      if (previousState && previousState.version >= state.version) {
        return current;
      }
      // Detach, shutdown and thread removal cancel a deferred open. Keep this behind the version gate so a late snapshot cannot discard a new request.
      let pendingOpenRequests = current.pendingOpenRequests;
      if (state.attachedDeviceUdid === null && pendingOpenRequests[state.threadId]) {
        pendingOpenRequests = { ...pendingOpenRequests };
        delete pendingOpenRequests[state.threadId];
      }
      return {
        pendingOpenRequests,
        threadStatesByThreadId: {
          ...current.threadStatesByThreadId,
          [state.threadId]: state,
        },
      };
    }),
  removeThreadState: (threadId) =>
    set((current) => {
      if (
        !Object.hasOwn(current.threadStatesByThreadId, threadId) &&
        !Object.hasOwn(current.pendingOpenRequests, threadId)
      ) {
        return current;
      }
      const nextThreadStatesByThreadId = { ...current.threadStatesByThreadId };
      delete nextThreadStatesByThreadId[threadId];
      const pendingOpenRequests = { ...current.pendingOpenRequests };
      delete pendingOpenRequests[threadId];
      return { threadStatesByThreadId: nextThreadStatesByThreadId, pendingOpenRequests };
    }),
  clear: () => set({ threadStatesByThreadId: {}, pendingOpenRequests: {} }),
}));

// dev-only handle to drive availability/setup states directly — stripped from production builds by the import.meta.env guard
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__deviceStateStoreForTests = useDeviceStateStore;
}

export function selectThreadDeviceState(
  threadId: ThreadId,
): (store: DeviceStateStore) => ThreadDeviceState | undefined {
  return (store) => store.threadStatesByThreadId[threadId];
}

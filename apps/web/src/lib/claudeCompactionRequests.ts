import type { ClientOrchestrationCommand, CommandId, ThreadId } from "@synara/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

type CompactionCommand = Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;

// keep the original command until acceptance is observed — reusing its receipt makes a manual retry safe after a lost RPC + remount; session storage preserves it across reload
export const useClaudeCompactionRequests = create<{
  requests: Partial<Record<ThreadId, CompactionCommand>>;
  remember: (command: CompactionCommand) => void;
  forget: (threadId: ThreadId, commandId: CommandId) => void;
}>()(
  persist(
    (set) => ({
      requests: {},
      remember: (command) =>
        set((state) => ({ requests: { ...state.requests, [command.threadId]: command } })),
      forget: (threadId, commandId) =>
        set((state) => {
          if (state.requests[threadId]?.commandId !== commandId) return state;
          const requests = { ...state.requests };
          delete requests[threadId];
          return { requests };
        }),
    }),
    {
      name: "synara:claude-compaction-requests",
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({ requests: state.requests }),
    },
  ),
);

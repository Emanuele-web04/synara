// FILE: subagentRunContext.ts
// Purpose: What a transcript subagent card needs from the chat it sits in (the
// parent's child threads, task controls, navigation) without threading props
// through the timeline, plus the tiny store through which mounted cards report
// whether they are on screen, for the floating "N running" chip.
// Layer: Chat transcript state
// Exports: SubagentRunContext, useSubagentRunContext, createSubagentRunVisibilityStore

import type { ThreadId, TurnId } from "@synara/contracts";
import { createContext, useContext } from "react";

import type { SubagentTaskEnd } from "../../session-logic";
import type { ComposerSubagentStripItem } from "./ComposerSubagentStrip.logic";
import type { SubagentRunThread } from "./SubagentRunCard.logic";

/** Where a mounted card sits relative to the transcript viewport. */
export type SubagentRunCardPlacement = "visible" | "above" | "below";

export interface SubagentRunVisibilityStore {
  get: () => ReadonlyMap<string, SubagentRunCardPlacement>;
  set: (entryId: string, placement: SubagentRunCardPlacement | null) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createSubagentRunVisibilityStore(): SubagentRunVisibilityStore {
  let current: ReadonlyMap<string, SubagentRunCardPlacement> = new Map();
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (entryId, placement) => {
      if ((current.get(entryId) ?? null) === placement) {
        return;
      }
      const next = new Map(current);
      if (placement === null) {
        next.delete(entryId);
      } else {
        next.set(entryId, placement);
      }
      current = next;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export interface SubagentRunContextValue {
  /** The open thread: the subagents' parent. */
  parentThreadId: ThreadId | null;
  /** The parent's turn still in progress, if any. */
  liveTurnId: TurnId | null;
  threads: ReadonlyArray<SubagentRunThread>;
  backgroundedProviderThreadIds: ReadonlySet<string>;
  /** Parent-side task completions, keyed by launching tool call id. */
  taskEndByToolUseId: ReadonlyMap<string, SubagentTaskEnd>;
  visibility: SubagentRunVisibilityStore | null;
  onOpenThread: (threadId: ThreadId) => void;
  onStop?: ((item: ComposerSubagentStripItem) => void | Promise<void>) | undefined;
  onBackground?: ((item: ComposerSubagentStripItem) => void | Promise<void>) | undefined;
}

export const SubagentRunContext = createContext<SubagentRunContextValue | null>(null);

export function useSubagentRunContext(): SubagentRunContextValue | null {
  return useContext(SubagentRunContext);
}

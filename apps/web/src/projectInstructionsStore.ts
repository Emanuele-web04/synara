// FILE: projectInstructionsStore.ts
// Purpose: Persist per-project instructions and merge them into thread notes when requested.
// Layer: Web UI state store
// Exports: useProjectInstructionsStore, mergeProjectInstructionsIntoThreadNotes

import type { ProjectId } from "@synara/contracts";
import { clampThreadNotes } from "@synara/shared/pinnedMessages";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

const PROJECT_INSTRUCTIONS_STORAGE_KEY = "synara:project-instructions:v1";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function threadNotesContainInstructionBlock(threadNotes: string, instructions: string): boolean {
  const current = threadNotes.replace(/\r\n/g, "\n").trim();
  if (current.length === 0) {
    return false;
  }
  const normalizedInstructions = instructions.replace(/\r\n/g, "\n").trim();
  const exactBlockPattern = new RegExp(
    `(?:^|\\n\\n)${escapeRegExp(normalizedInstructions)}(?:\\n\\n|$)`,
  );
  return exactBlockPattern.test(current);
}

interface ProjectInstructionsStore {
  /** Freeform instructions keyed by orchestration project id. */
  instructionsByProjectId: Record<string, string>;
  /** Set or replace a project's instructions; empty strings clear persisted clutter. */
  setInstructions: (projectId: ProjectId, instructions: string) => void;
  /** Clear a project's instructions. */
  clearInstructions: (projectId: ProjectId) => void;
}

export const useProjectInstructionsStore = create<ProjectInstructionsStore>()(
  persist(
    (set) => ({
      instructionsByProjectId: {},
      setInstructions: (projectId, instructions) =>
        set((state) => {
          const next = { ...state.instructionsByProjectId };
          const clamped = clampThreadNotes(instructions);
          if (clamped.trim().length === 0) {
            delete next[projectId];
          } else {
            next[projectId] = clamped;
          }
          return { instructionsByProjectId: next };
        }),
      clearInstructions: (projectId) =>
        set((state) => {
          const next = { ...state.instructionsByProjectId };
          delete next[projectId];
          return { instructionsByProjectId: next };
        }),
    }),
    {
      name: PROJECT_INSTRUCTIONS_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

// Appends project instructions without clobbering thread notes a user already wrote.
export function mergeProjectInstructionsIntoThreadNotes(input: {
  readonly threadNotes: string;
  readonly projectInstructions: string;
}): string {
  const instructions = input.projectInstructions.trim();
  if (instructions.length === 0) {
    return input.threadNotes;
  }
  const current = input.threadNotes.trim();
  if (current.length === 0) {
    return clampThreadNotes(instructions);
  }
  if (threadNotesContainInstructionBlock(current, instructions)) {
    return input.threadNotes;
  }
  return clampThreadNotes(`${input.threadNotes.trimEnd()}\n\n${instructions}`);
}

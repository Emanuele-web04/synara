// FILE: useAdditionalProjectFolders.ts
// Purpose: Draft list of a project's extra source folders, validated against its primary
//          folder as they are added or removed.
// Layer: Web hook (Create project and Edit project dialogs)
// Exports: useAdditionalProjectFolders

import { findProjectFolderProblem } from "@synara/shared/projectFolders";
import { useState } from "react";

export function useAdditionalProjectFolders(input: {
  /** The primary folder the extra ones are checked against. */
  readonly primary: string;
  /** Seeds the draft on mount only. */
  readonly initial?: ReadonlyArray<string>;
  /** Why a folder cannot join the project, or null after a clean change. */
  readonly onProblem: (problem: string | null) => void;
}) {
  const [additionalFolders, setAdditionalFolders] = useState<ReadonlyArray<string>>(
    input.initial ?? [],
  );

  // Adds a folder after the others, refusing duplicates and nested folders up front.
  const addFolder = (folder: string): boolean => {
    const candidate = folder.trim();
    if (!candidate) return false;
    const problem = findProjectFolderProblem([input.primary, ...additionalFolders, candidate]);
    if (problem) {
      input.onProblem(problem);
      return false;
    }
    setAdditionalFolders((current) => [...current, candidate]);
    input.onProblem(null);
    return true;
  };

  /** Removes an extra folder by its index in `[primary, ...additionalFolders]`. */
  const removeFolder = (index: number) => {
    setAdditionalFolders((current) => current.filter((_, candidate) => candidate !== index - 1));
    input.onProblem(null);
  };

  return { additionalFolders, setAdditionalFolders, addFolder, removeFolder };
}

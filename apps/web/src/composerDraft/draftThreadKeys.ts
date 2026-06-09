// FILE: composerDraft/draftThreadKeys.ts
// Purpose: Encode and decode the per-project draft-thread mapping keys that carry an entry-point suffix.
// Layer: Web state store (pure helpers)
// Exports: projectDraftThreadMappingKey, projectDraftThreadEntryPointFromKey, projectIdFromDraftThreadMappingKey

import type { ProjectId } from "@t3tools/contracts";
import type { ThreadPrimarySurface } from "../types";

const TERMINAL_DRAFT_THREAD_MAPPING_SUFFIX = "::terminal";

export function projectDraftThreadMappingKey(
  projectId: ProjectId,
  entryPoint: ThreadPrimarySurface = "chat",
): string {
  return entryPoint === "terminal"
    ? `${projectId}${TERMINAL_DRAFT_THREAD_MAPPING_SUFFIX}`
    : projectId;
}

export function projectDraftThreadEntryPointFromKey(key: string): ThreadPrimarySurface {
  return key.endsWith(TERMINAL_DRAFT_THREAD_MAPPING_SUFFIX) ? "terminal" : "chat";
}

export function projectIdFromDraftThreadMappingKey(key: string): ProjectId {
  return (
    key.endsWith(TERMINAL_DRAFT_THREAD_MAPPING_SUFFIX)
      ? key.slice(0, -TERMINAL_DRAFT_THREAD_MAPPING_SUFFIX.length)
      : key
  ) as ProjectId;
}

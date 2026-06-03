// FILE: handoff.ts
// Purpose: Server compatibility exports for shared handoff context helpers.
// Layer: Server orchestration utilities
// Depends on: shared handoff context builders

export {
  buildForkBootstrapText,
  buildHandoffBootstrapText,
  buildPriorTranscriptBootstrapText,
  calculateAvailableHandoffBootstrapChars,
  hasNativeAssistantMessagesBefore,
  hasNativeHandoffMessages,
  listImportedForkMessages,
  listImportedHandoffMessages,
  listPriorTranscriptMessages,
} from "@t3tools/shared/handoffContext";

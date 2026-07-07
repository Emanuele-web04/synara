// FILE: messageProjectionMerge.ts
// Purpose: Shares replay-safe projected message merge rules across live and persisted projections.
// Layer: Orchestration projection helper
// Exports: mergeProjectedMessageText, mergeProjectedMessageStreaming

export function mergeProjectedMessageText(input: {
  readonly existingText?: string | undefined;
  readonly existingStreaming?: boolean | undefined;
  readonly incomingText: string;
  readonly incomingStreaming: boolean;
}): string {
  if (input.existingText === undefined) {
    return input.incomingText;
  }
  if (input.incomingStreaming) {
    if (input.existingStreaming) {
      return `${input.existingText}${input.incomingText}`;
    }
    return input.incomingText.length > 0 && !input.existingText.includes(input.incomingText)
      ? `${input.existingText}${input.incomingText}`
      : input.existingText;
  }
  return input.incomingText.length > 0 ? input.incomingText : input.existingText;
}

export function mergeProjectedMessageStreaming(input: {
  readonly existingStreaming?: boolean | undefined;
  readonly incomingStreaming: boolean;
}): boolean {
  if (input.existingStreaming === undefined) {
    return input.incomingStreaming;
  }
  return input.existingStreaming ? input.incomingStreaming : false;
}

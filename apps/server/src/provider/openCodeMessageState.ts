import { createHash } from "node:crypto";

// Keep a fixed-size fingerprint, rather than retaining a second serialized copy
// of every tool output. Original parts and emitted-text state remain intact.
export function openCodeSnapshotKey(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? String(value);
  } catch {
    serialized = String(value);
  }
  return createHash("sha256").update(serialized).digest("hex");
}

// Owns eviction of provider message state, including deltas received before a part snapshot.
export interface OpenCodeMessageState<Part extends { readonly messageID: string }> {
  readonly messageRoleById: Map<string, "user" | "assistant">;
  readonly messageSnapshotKeyById: Map<string, string>;
  readonly partById: Map<string, Part>;
  readonly partSnapshotKeyById: Map<string, string>;
  readonly emittedTextByPartId: Map<string, string>;
  readonly completedAssistantPartIds: Set<string>;
  readonly pendingTextDeltasByPartId: Map<
    string,
    {
      readonly messageId: string;
      readonly text: string;
      readonly bufferedAfterKnownSnapshot: boolean;
    }
  >;
}

export function forgetOpenCodePart<Part extends { readonly messageID: string }>(
  state: OpenCodeMessageState<Part>,
  partId: string,
): void {
  state.partById.delete(partId);
  state.partSnapshotKeyById.delete(partId);
  state.emittedTextByPartId.delete(partId);
  state.completedAssistantPartIds.delete(partId);
  state.pendingTextDeltasByPartId.delete(partId);
}

export function forgetOpenCodeMessage<Part extends { readonly messageID: string }>(
  state: OpenCodeMessageState<Part>,
  messageId: string,
): void {
  state.messageRoleById.delete(messageId);
  state.messageSnapshotKeyById.delete(messageId);
  for (const [partId, part] of state.partById) {
    if (part.messageID === messageId) forgetOpenCodePart(state, partId);
  }
  for (const [partId, pending] of state.pendingTextDeltasByPartId) {
    if (pending.messageId === messageId) forgetOpenCodePart(state, partId);
  }
}

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

/**
 * `partById` with a message-id secondary index maintained by the Map methods
 * themselves, so every existing `set`/`delete` site keeps the index in step
 * without a parallel bookkeeping call. `partById` holds every part of the whole
 * OpenCode session, so looking a message's parts up here instead of scanning
 * the map keeps per-event cost independent of session length.
 */
export class OpenCodePartIndex<Part extends { readonly messageID: string }> extends Map<
  string,
  Part
> {
  private readonly partIdsByMessageId = new Map<string, Set<string>>();

  override set(partId: string, part: Part): this {
    const previous = super.get(partId);
    if (previous !== undefined && previous.messageID !== part.messageID) {
      this.unindex(partId, previous.messageID);
    }
    super.set(partId, part);
    let partIds = this.partIdsByMessageId.get(part.messageID);
    if (partIds === undefined) {
      partIds = new Set();
      this.partIdsByMessageId.set(part.messageID, partIds);
    }
    partIds.add(partId);
    return this;
  }

  override delete(partId: string): boolean {
    const previous = super.get(partId);
    if (previous !== undefined) {
      this.unindex(partId, previous.messageID);
    }
    return super.delete(partId);
  }

  override clear(): void {
    super.clear();
    this.partIdsByMessageId.clear();
  }

  /** `[partId, part]` pairs of one message, in insertion order (as a map scan yields). */
  entriesForMessage(messageId: string): Array<[string, Part]> {
    const partIds = this.partIdsByMessageId.get(messageId);
    if (partIds === undefined) {
      return [];
    }
    const entries: Array<[string, Part]> = [];
    for (const partId of partIds) {
      const part = super.get(partId);
      if (part !== undefined) {
        entries.push([partId, part]);
      }
    }
    return entries;
  }

  /** Parts of one message, in insertion order. */
  partsForMessage(messageId: string): Part[] {
    return this.entriesForMessage(messageId).map(([, part]) => part);
  }

  private unindex(partId: string, messageId: string): void {
    const partIds = this.partIdsByMessageId.get(messageId);
    if (partIds === undefined) {
      return;
    }
    partIds.delete(partId);
    if (partIds.size === 0) {
      this.partIdsByMessageId.delete(messageId);
    }
  }
}

// Owns eviction of provider message state, including deltas received before a part snapshot.
export interface OpenCodeMessageState<Part extends { readonly messageID: string }> {
  readonly messageRoleById: Map<string, "user" | "assistant">;
  readonly messageSnapshotKeyById: Map<string, string>;
  readonly partById: OpenCodePartIndex<Part>;
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
  for (const [partId] of state.partById.entriesForMessage(messageId)) {
    forgetOpenCodePart(state, partId);
  }
  for (const [partId, pending] of state.pendingTextDeltasByPartId) {
    if (pending.messageId === messageId) forgetOpenCodePart(state, partId);
  }
}

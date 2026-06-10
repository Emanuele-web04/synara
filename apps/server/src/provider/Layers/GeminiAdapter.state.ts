// Purpose: Pure session/turn state mutators shared by the Gemini adapter factory and its extracted clusters.
// Layer: pure functions over GeminiSessionContext/GeminiTurnState — no Effect, no I/O.
// Exports: updateGeminiSession, currentGeminiTurnId, upsertGeminiTurnItem.

import type { CanonicalItemType, ProviderSession, TurnId } from "@t3tools/contracts";

import type {
  GeminiRecordedItem,
  GeminiSessionContext,
  GeminiTurnState,
} from "./GeminiAdapter.types.ts";

export function updateGeminiSession(
  context: GeminiSessionContext,
  patch: Partial<ProviderSession>,
): ProviderSession {
  context.session = {
    ...context.session,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  return context.session;
}

export function currentGeminiTurnId(context: GeminiSessionContext): TurnId | undefined {
  return context.turnState?.turnId;
}

export function upsertGeminiTurnItem(
  turnState: GeminiTurnState,
  itemId: string,
  itemType: CanonicalItemType,
  patch: Partial<GeminiRecordedItem>,
): GeminiRecordedItem {
  let item = turnState.items.find((candidate) => candidate.id === itemId);
  if (!item) {
    item = { id: itemId, itemType };
    turnState.items.push(item);
  }
  item.itemType = itemType;
  Object.assign(item, patch);
  return item;
}

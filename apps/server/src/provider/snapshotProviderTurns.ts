import type { ProviderThreadSnapshot } from "./Services/ProviderAdapter.ts";

// Own the snapshot's arrays. Appending/rolling back adapter history must not
// change a snapshot already returned to a caller. Item payloads are immutable.
export function snapshotProviderTurns(
  turns: ProviderThreadSnapshot["turns"],
): ProviderThreadSnapshot["turns"] {
  return turns.map(({ id, items }) => ({ id, items: [...items] }));
}

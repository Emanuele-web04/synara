import { Schema } from "effect";
import { ComputerSpaceInventory } from "@synara/contracts";

import { ComputerSpaceError } from "./ComputerSpaceBroker.ts";

/** Decode only the native managed-display inventory; window membership is not a substitute. */
export function cuaSpaceInventory(value: Record<string, unknown>): ComputerSpaceInventory {
  try {
    if (value.source !== "macos-managed-spaces" || !Array.isArray(value.spaces))
      throw new Error("missing native inventory");
    const inventory = Schema.decodeUnknownSync(ComputerSpaceInventory)({
      source: value.source,
      complete: value.complete,
      spaces: value.spaces.map((entry: unknown) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry))
          throw new Error("invalid native Space");
        const space = entry as Record<string, unknown>;
        return {
          id: space.space_id,
          uuid: space.space_uuid,
          displayId: space.display_id,
          kind: space.kind,
          current: space.current,
        };
      }),
    });
    const ids = new Set<number>();
    const uuids = new Set<string>();
    for (const space of inventory.spaces) {
      if (ids.has(space.id) || (space.uuid !== null && uuids.has(space.uuid)))
        throw new Error("ambiguous Space identity");
      ids.add(space.id);
      if (space.uuid !== null) uuids.add(space.uuid);
    }
    return inventory;
  } catch {
    throw new ComputerSpaceError(
      "computer_spaces_unavailable",
      "The native driver did not provide a valid managed-display Space inventory. Use exact existing windows in place; do not infer empty Spaces or Space ownership from window membership.",
    );
  }
}

import type { BridgeSceneSnapshot } from "./bridge";

const PSEUDO_TYPES = new Set(["cameraUpdate", "restoreCheckpoint", "delete"]);

export function applyElementOperations(
  scene: BridgeSceneSnapshot["scene"],
  operations: ReadonlyArray<Record<string, unknown>>,
): BridgeSceneSnapshot["scene"] {
  const additions = operations.filter(
    (operation) => !PSEUDO_TYPES.has(String(operation.type ?? "")),
  );
  const additionIds = new Set<string>();
  for (const addition of additions) {
    if (typeof addition.id !== "string" || addition.id.trim().length === 0) {
      throw new Error("Every Excalidraw element operation must have a non-empty string id.");
    }
    if (additionIds.has(addition.id)) {
      throw new Error(`Duplicate Excalidraw element id '${addition.id}'.`);
    }
    additionIds.add(addition.id);
  }
  const deleteIds = new Set<string>();
  for (const operation of operations) {
    if (operation.type !== "delete") continue;
    for (const id of String(operation.ids ?? operation.id ?? "").split(",")) {
      if (id.trim()) deleteIds.add(id.trim());
    }
  }
  const retained = scene.elements.filter(
    (element) =>
      !deleteIds.has(String(element.id ?? "")) &&
      !deleteIds.has(String(element.containerId ?? "")) &&
      !additionIds.has(String(element.id ?? "")) &&
      !additionIds.has(String(element.containerId ?? "")),
  );
  return {
    ...scene,
    elements: [...retained, ...additions],
  };
}

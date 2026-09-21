import type { ComputerTarget, ComputerUiNode } from "@synara/contracts";

// Native handles stay inside the server. Neither the provider-facing ref nor
// the public ComputerTarget schema exposes an actuator token.
const nativeIdentities = new WeakMap<ComputerUiNode, string>();
const observedRefs = new WeakMap<object, ComputerUiNode>();
const observedElement = Symbol("computerObservedElement");

type ObservedComputerTarget = ComputerTarget & {
  readonly [observedElement]?: ComputerUiNode;
};

export function registerNativeComputerElement(node: ComputerUiNode, identity: string): void {
  nativeIdentities.set(node, identity);
}

export function retainComputerElementRef<T extends object>(ref: T, node: ComputerUiNode): T {
  if (nativeIdentities.has(node)) observedRefs.set(ref, node);
  return ref;
}

export function computerElementRefIdentity(ref: object): string | undefined {
  const node = observedRefs.get(ref);
  return node ? nativeIdentities.get(node) : undefined;
}

export function bindComputerTargetRef(target: ComputerTarget, ref: object): ComputerTarget {
  const node = observedRefs.get(ref);
  // Enumerable symbols survive internal object spreads, but JSON/provider
  // serialization cannot carry or manufacture this server-owned binding.
  if (!node) return target;
  const bound: ObservedComputerTarget = { ...target, [observedElement]: node };
  return bound;
}

export function observedComputerTargetNode(target: ComputerTarget): ComputerUiNode | undefined {
  return (target as ObservedComputerTarget)[observedElement];
}

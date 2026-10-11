import { Schema } from "effect";

import { ThreadAccountBinding } from "@synara/contracts";
export { ThreadAccountBinding };

const isBinding = Schema.is(ThreadAccountBinding);

export function readAccountBindingFromRuntimePayload(
  runtimePayload: unknown,
): ThreadAccountBinding | undefined {
  if (typeof runtimePayload !== "object" || runtimePayload === null) return undefined;
  const candidate = (runtimePayload as Record<string, unknown>)["accountBinding"];
  return isBinding(candidate) ? candidate : undefined;
}

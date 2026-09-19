/**
 * The name/value rows an approval card renders for a tool call's arguments.
 *
 * Every producer of an `approval.requested` activity has to flatten its raw
 * tool input into this shape, because the card reads `toolParamsDisplay` as a
 * list of `{ name, value }` rows and nothing else: a provider runtime request
 * projected server-side and a Synara-owned computer approval used to build the
 * payload separately, and the second serialised the whole object into one
 * string the card could not read, so it showed the tool name and nothing else.
 *
 * Values are stringified here rather than passed through as nested JSON: the
 * card prints one compact line per parameter, and pre-formatting keeps the
 * persisted payload small.
 *
 * @module toolParamsDisplay
 */

/** A type alias rather than an interface, so a row is assignable to plain JSON. */
export type ToolParamDisplay = { readonly name: string; readonly value: string };

/**
 * The rows for one tool input, or `undefined` when there is nothing to show —
 * an absent input and an empty object both mean the card has no rows to draw.
 */
export function toolParamsDisplayFromToolInput(
  input: Record<string, unknown> | undefined,
): ReadonlyArray<ToolParamDisplay> | undefined {
  if (!input) return undefined;
  const entries = Object.entries(input).map(([name, value]) => ({
    name,
    value: typeof value === "string" ? value : (safeStringify(value) ?? String(value)),
  }));
  return entries.length > 0 ? entries : undefined;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

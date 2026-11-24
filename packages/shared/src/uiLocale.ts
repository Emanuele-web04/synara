import { UI_LOCALES, type UiLocale } from "@synara/contracts/uiLocale";

export { UI_LOCALES };
export type { UiLocale };

/** Only catalog identities may reach a namespace-aware translator; other strings are data. */
export function isUiMessageKey(
  message: string,
  namespaces: Readonly<Record<string, unknown>>,
): boolean {
  const match = /^([a-z][A-Za-z0-9_-]*):[A-Za-z0-9_][A-Za-z0-9_.-]*$/.exec(message);
  return match !== null && Object.hasOwn(namespaces, match[1]!);
}

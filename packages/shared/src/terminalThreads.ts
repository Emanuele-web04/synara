export const GENERIC_TERMINAL_THREAD_TITLE = "New terminal";

export function isGenericTerminalThreadTitle(title: string | null | undefined): boolean {
  return (title ?? "").trim() === GENERIC_TERMINAL_THREAD_TITLE;
}

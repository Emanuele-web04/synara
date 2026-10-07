// Registered by the mounted execution UI. Bootstrap escape has no mounted
// editor buffers and must remain available without contacting either server.
let guard: { recover: () => void | (() => void); drafts?: () => unknown[] } | undefined;
export function registerExecutionSwitchGuard(value: NonNullable<typeof guard>): void {
  guard = value;
}
export function recoverBeforeLocalEscape(): void | (() => void) {
  return guard?.recover();
}

export function readUnsavedExecutionDrafts(): unknown[] {
  return guard?.drafts?.() ?? [];
}

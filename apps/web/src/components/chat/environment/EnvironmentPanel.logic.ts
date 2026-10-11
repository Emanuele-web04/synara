// FILE: EnvironmentPanel.logic.ts
// Purpose: Pure visibility policy for Environment panel actions.
// Layer: Web UI logic

export function shouldShowGroupFolderRow(input: {
  isGroupChat: boolean;
  groupFolderPath: string | null;
  nativeShellAvailable: boolean;
}): boolean {
  return input.isGroupChat && Boolean(input.groupFolderPath) && input.nativeShellAvailable;
}

// FILE: EnvironmentPanel.logic.ts
// Purpose: Pure visibility policy for Environment panel actions.
// Layer: Web UI logic

export function shouldShowStudioFolderRow(input: {
  isStudioChat: boolean;
  studioFolderPath: string | null;
  nativeShellAvailable: boolean;
}): boolean {
  return input.isStudioChat && Boolean(input.studioFolderPath) && input.nativeShellAvailable;
}

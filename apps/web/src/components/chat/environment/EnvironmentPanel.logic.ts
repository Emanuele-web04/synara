export function shouldShowStudioFolderRow(input: {
  isStudioChat: boolean;
  studioFolderPath: string | null;
  nativeShellAvailable: boolean;
}): boolean {
  return input.isStudioChat && Boolean(input.studioFolderPath) && input.nativeShellAvailable;
}

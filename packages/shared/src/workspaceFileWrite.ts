export const WORKSPACE_FILE_WRITE_CONFLICT_MESSAGE = "File changed on disk since it was loaded.";

export function isWorkspaceFileWriteConflictMessage(message: string): boolean {
  return message.includes(WORKSPACE_FILE_WRITE_CONFLICT_MESSAGE);
}

export function isWorkspaceFileWriteConflictError(error: unknown): boolean {
  return error instanceof Error && isWorkspaceFileWriteConflictMessage(error.message);
}

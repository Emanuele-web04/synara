import { realpath } from "node:fs/promises";
import { isAbsolute, sep } from "node:path";
import { ToolInputError } from "./toolInput.ts";

/** Return only a canonical path contained by the already-canonical workspace. */
export async function boundedWorkspacePath(
  raw: unknown,
  workspaceRoot: string,
  field: string,
): Promise<string> {
  if (typeof raw !== "string" || raw.length === 0 || !isAbsolute(raw))
    throw new ToolInputError(`"${field}" must be an absolute path.`);
  const canonical = await realpath(raw).catch(() => {
    throw new ToolInputError(`"${field}" does not resolve to an existing path.`);
  });
  if (canonical !== workspaceRoot && !canonical.startsWith(workspaceRoot + sep))
    throw new ToolInputError(`"${field}" resolves outside the active workspace.`);
  return canonical;
}

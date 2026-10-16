import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Effect } from "effect";
import {
  MAX_COMPUTER_CLIPBOARD_BYTES,
  type ComputerClipboardPayload,
} from "../computer/ComputerBackend.ts";
import type { ToolContext } from "./toolRuntime.ts";
import { ToolInputError } from "./toolInput.ts";
import { boundedWorkspacePath } from "./computerWorkspacePath.ts";

export function readComputerPastePayload(args: Record<string, unknown>): ComputerClipboardPayload {
  const fields = ["text", "image_path", "file_path"].filter((field) => args[field] !== undefined);
  if (fields.length !== 1)
    throw new ToolInputError('Paste requires exactly one of "text", "image_path" or "file_path".');
  const field = fields[0]!;
  const value = args[field];
  if (typeof value !== "string") throw new ToolInputError(`"${field}" must be a string.`);
  if (field === "text") {
    if (Buffer.byteLength(value, "utf8") > MAX_COMPUTER_CLIPBOARD_BYTES)
      throw new ToolInputError(
        `Clipboard text exceeds the ${MAX_COMPUTER_CLIPBOARD_BYTES} byte limit.`,
      );
    return { text: value };
  }
  if (!isAbsolute(value)) throw new ToolInputError(`"${field}" must be an absolute path.`);
  return field === "image_path" ? { imagePath: value } : { filePath: value };
}

export async function boundComputerPastePayload(
  payload: ComputerClipboardPayload,
  context: ToolContext,
  signal: AbortSignal | undefined,
  resolveWorkspaceRoot?: (context: ToolContext) => Effect.Effect<string | null>,
): Promise<ComputerClipboardPayload> {
  signal?.throwIfAborted();
  if ("text" in payload) return payload;
  const root = resolveWorkspaceRoot
    ? await Effect.runPromise(resolveWorkspaceRoot(context), signal ? { signal } : undefined)
    : null;
  if (!root?.trim())
    throw new ToolInputError("No canonical workspace is available for native file paste.");
  const image = "imagePath" in payload;
  const path = await boundedWorkspacePath(
    image ? payload.imagePath : payload.filePath,
    await realpath(root),
    image ? "image_path" : "file_path",
  );
  if (!(await stat(path)).isFile())
    throw new ToolInputError("Paste requires an existing regular file.");
  signal?.throwIfAborted();
  return image ? { imagePath: path } : { filePath: path };
}

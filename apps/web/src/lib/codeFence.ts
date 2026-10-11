// FILE: codeFence.ts
// Purpose: Parse markdown code-fence info strings into a highlighter language plus
//          optional file-reference metadata (Cursor-style `startLine:endLine:path`).
// Layer: web chat markdown helper
// Exports: parseCodeFenceInfo, type CodeFenceInfo
// Depends on: @pierre/diffs filename→language map (shared with the diff renderer)
//             and the shared path basename helper (file-icons).

import { getFiletypeFromFileName } from "@pierre/diffs";
import { basenameOfPath } from "../file-icons";

export interface CodeFenceInfo {
  /** Highlighter language id (a valid Shiki language/alias, falling back to "text"). */
  readonly language: string;
  /** True when the fence info encodes a file reference rather than a bare language. */
  readonly isFileReference: boolean;
  /** Full file path when this fence references a file, else null. */
  readonly filePath: string | null;
  /** Basename of the referenced file for display, else null. */
  readonly fileName: string | null;
  /** Directory portion of the referenced path (no trailing slash), else null. */
  readonly directory: string | null;
  /** Line range label like "173-186" (or a single line), else null. */
  readonly lineRange: string | null;
}

function directoryFromPath(filePath: string, fileName: string): string | null {
  const dir = filePath.slice(0, Math.max(0, filePath.length - fileName.length));
  const trimmed = dir.replace(/[\\/]+$/, "");
  return trimmed.length > 0 ? trimmed : null;
}

function fileReferenceInfo(filePath: string, lineRange: string | null): CodeFenceInfo {
  const fileName = basenameOfPath(filePath);
  return {
    // Reuse the diff renderer's filename→language map so chat code references and
    // diff views resolve languages identically; unknown extensions yield "text".
    language: getFiletypeFromFileName(fileName),
    isFileReference: true,
    filePath,
    fileName,
    directory: directoryFromPath(filePath, fileName),
    lineRange,
  };
}

const LEADING_WHITESPACE_REGEX = /^[ \t]*/;

// Removes the indentation common to every non-empty line so snippets pulled from
// deeply nested code don't render pushed far to the right. Lines keep their
// relative indentation, so it is a no-op for blocks that are already flush-left.
export function dedentCode(code: string): string {
  const lines = code.split("\n");
  let minIndent = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const indent = LEADING_WHITESPACE_REGEX.exec(line)?.[0].length ?? 0;
    if (indent < minIndent) minIndent = indent;
  }
  if (!Number.isFinite(minIndent) || minIndent === 0) {
    return code;
  }
  return lines.map((line) => line.slice(minIndent)).join("\n");
}

const CODE_REFERENCE_REGEX = /^(\d+):(\d+):(.+)$/;

// Parses a fence info string. Recognizes Cursor-style file references
// (`startLine:endLine:path`) and bare file paths, deriving the highlighter
// language from the file extension. Everything else is treated as a plain
// language token (preserving the legacy `gitignore` → `ini` alias).
export function parseCodeFenceInfo(rawInfo: string): CodeFenceInfo {
  const info = rawInfo.trim();

  const referenceMatch = info.match(CODE_REFERENCE_REGEX);
  if (referenceMatch) {
    const [, start, end, filePath] = referenceMatch;
    if (start != null && end != null && filePath != null) {
      const lineRange = start === end ? start : `${start}-${end}`;
      return fileReferenceInfo(filePath, lineRange);
    }
  }

  // A bare path (contains a separator) is treated as an un-ranged file reference.
  if (info.includes("/") || info.includes("\\")) {
    return fileReferenceInfo(info, null);
  }

  // Shiki doesn't bundle a gitignore grammar; ini is a close match (#685).
  const language = info === "gitignore" ? "ini" : info.length > 0 ? info : "text";
  return {
    language,
    isFileReference: false,
    filePath: null,
    fileName: null,
    directory: null,
    lineRange: null,
  };
}

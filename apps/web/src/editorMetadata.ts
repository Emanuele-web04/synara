// FILE: editorMetadata.ts
// Purpose: Resolve the shared web-facing labels and icons for supported editors.
// Layer: Web UI metadata
// Exports: editor option builders used by the chat header and open-in picker.

import { EDITORS, type EditorId } from "@t3tools/contracts";
import type { Icon } from "./components/Icons";
import {
  AntigravityIcon,
  CursorIcon,
  OpenCodeIcon,
  VisualStudioCode,
  Zed,
} from "./components/Icons";
import { FolderClosedIcon } from "./lib/icons";
import { isMacPlatform, isWindowsPlatform } from "./lib/utils";

export interface EditorOption {
  readonly value: EditorId;
  readonly label: string;
  readonly Icon: Icon;
}

const EDITOR_ICONS: Partial<Record<EditorId, Icon>> = {
  cursor: CursorIcon,
  trae: OpenCodeIcon,
  vscode: VisualStudioCode,
  "vscode-insiders": VisualStudioCode,
  vscodium: VisualStudioCode,
  zed: Zed,
  antigravity: AntigravityIcon,
  idea: OpenCodeIcon,
  "file-manager": FolderClosedIcon,
};

// Build labels from the shared catalog so newly supported editors appear without
// duplicating the editor list across multiple UI components.
export function resolveEditorLabel(editorId: EditorId, platform: string): string {
  if (editorId === "file-manager") {
    return isMacPlatform(platform) ? "Finder" : isWindowsPlatform(platform) ? "Explorer" : "Files";
  }

  return EDITORS.find((editor) => editor.id === editorId)?.label ?? editorId;
}

// Keep the header/picker resilient even when a brand-specific icon does not exist yet.
export function resolveEditorIcon(editorId: EditorId): Icon {
  return EDITOR_ICONS[editorId] ?? OpenCodeIcon;
}

export function resolveAvailableEditorOptions(
  platform: string,
  availableEditors: ReadonlyArray<EditorId>,
): ReadonlyArray<EditorOption> {
  const availableEditorIds = new Set(availableEditors);
  return EDITORS.filter((editor) => availableEditorIds.has(editor.id)).map((editor) => ({
    value: editor.id,
    label: resolveEditorLabel(editor.id, platform),
    Icon: resolveEditorIcon(editor.id),
  }));
}

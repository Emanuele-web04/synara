// FILE: fileManagerNaming.ts
// Purpose: Single source for how the UI names the platform file manager and the
//          "open folder" / "reveal file" actions that route through
//          shell.showInFolder (Electron shell.openPath for folders,
//          shell.showItemInFolder for files). Every menu item, tooltip, and
//          error toast in that flow must read its copy from here so Windows and
//          Linux users never see "Finder" and macOS users never see "Explorer".
// Layer: Web UI helpers
// Exports: FileManagerTargetKind, FileManagerPresentation,
//          resolveFileManagerPresentation, resolveFileManagerName,
//          resolveFileManagerActionLabel, resolveFileManagerErrorTitle,
//          resolveFileManagerErrorDescription

import { getNavigatorPlatform, isMacPlatform, isWindowsPlatform } from "~/lib/utils";

/** Folders are opened in the file manager; files are selected inside it. */
export type FileManagerTargetKind = "file" | "folder";

type FileManagerPlatform = "mac" | "windows" | "generic";

interface FileManagerTargetCopy {
  actionLabel: string;
  errorTitle: string;
}

interface FileManagerPlatformCopy {
  managerName: string;
  file: FileManagerTargetCopy;
  folder: FileManagerTargetCopy;
}

export interface FileManagerPresentation extends FileManagerTargetCopy {
  managerName: string;
  fallbackDescription: string;
}

const FILE_MANAGER_COPY = {
  mac: {
    managerName: "Finder",
    folder: {
      actionLabel: "Open in Finder",
      errorTitle: "Unable to open in Finder",
    },
    file: {
      actionLabel: "Reveal in Finder",
      errorTitle: "Unable to reveal in Finder",
    },
  },
  windows: {
    managerName: "Explorer",
    folder: {
      actionLabel: "Open in Explorer",
      errorTitle: "Unable to open in Explorer",
    },
    file: {
      actionLabel: "Show in Explorer",
      errorTitle: "Unable to show in Explorer",
    },
  },
  generic: {
    managerName: "File manager",
    folder: {
      actionLabel: "Open folder",
      errorTitle: "Unable to open folder",
    },
    file: {
      actionLabel: "Show in folder",
      errorTitle: "Unable to show in folder",
    },
  },
} as const satisfies Record<FileManagerPlatform, FileManagerPlatformCopy>;

const FILE_MANAGER_FALLBACK_DESCRIPTIONS = {
  folder: "The folder could not be opened.",
  file: "The file could not be shown in its folder.",
} as const satisfies Record<FileManagerTargetKind, string>;

function classifyPlatform(platform: string): FileManagerPlatform {
  if (isWindowsPlatform(platform)) {
    return "windows";
  }
  if (isMacPlatform(platform)) {
    return "mac";
  }
  // Linux and unknown hosts: never assume a specific file manager (Files,
  // Dolphin, Thunar, ...), so the copy stays generic.
  return "generic";
}

/** Display name of the file manager as an application, e.g. for editor pickers. */
export function resolveFileManagerName(platform: string = getNavigatorPlatform()): string {
  return FILE_MANAGER_COPY[classifyPlatform(platform)].managerName;
}

export function resolveFileManagerPresentation(
  kind: FileManagerTargetKind,
  platform: string = getNavigatorPlatform(),
): FileManagerPresentation {
  const platformCopy = FILE_MANAGER_COPY[classifyPlatform(platform)];
  return {
    managerName: platformCopy.managerName,
    ...platformCopy[kind],
    fallbackDescription: FILE_MANAGER_FALLBACK_DESCRIPTIONS[kind],
  };
}

/**
 * Menu/button label for the action. Folders use "Open" because the file
 * manager navigates into them; files use "Reveal"/"Show" because they are
 * selected inside their parent folder rather than launched.
 */
export function resolveFileManagerActionLabel(
  kind: FileManagerTargetKind,
  platform: string = getNavigatorPlatform(),
): string {
  return resolveFileManagerPresentation(kind, platform).actionLabel;
}

/** Toast title when the action fails; mirrors the action label wording. */
export function resolveFileManagerErrorTitle(
  kind: FileManagerTargetKind,
  platform: string = getNavigatorPlatform(),
): string {
  return resolveFileManagerPresentation(kind, platform).errorTitle;
}

/**
 * Toast description: the shell's own message (e.g. "File or folder not found:
 * …") is the most useful detail, so it is passed through verbatim; anything
 * else gets a neutral fallback that does not name a file manager.
 */
export function resolveFileManagerErrorDescription(
  error: unknown,
  kind: FileManagerTargetKind,
): string {
  const message =
    typeof error === "string"
      ? error
      : error && typeof error === "object" && "message" in error
        ? (error as { message?: unknown }).message
        : undefined;

  return typeof message === "string" && message.trim().length > 0
    ? message
    : FILE_MANAGER_FALLBACK_DESCRIPTIONS[kind];
}

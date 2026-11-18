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

import { t } from "~/i18n";
import { getNavigatorPlatform, isMacPlatform, isWindowsPlatform } from "~/lib/utils";

/** Folders are opened in the file manager; files are selected inside it. */
export type FileManagerTargetKind = "file" | "folder";

type FileManagerPlatform = "mac" | "windows" | "generic";

interface FileManagerTargetCopy {
  actionLabelKey: string;
  errorTitleKey: string;
}

interface FileManagerPlatformCopy {
  managerNameKey: string;
  file: FileManagerTargetCopy;
  folder: FileManagerTargetCopy;
}

export interface FileManagerPresentation {
  managerName: string;
  actionLabel: string;
  errorTitle: string;
  fallbackDescription: string;
}

const FILE_MANAGER_COPY = {
  mac: {
    managerNameKey: "workspace:fileManagerFinder",
    folder: {
      actionLabelKey: "workspace:openFolderInFinder",
      errorTitleKey: "workspace:unableOpenInFinder",
    },
    file: {
      actionLabelKey: "workspace:revealFinder",
      errorTitleKey: "workspace:unableRevealInFinder",
    },
  },
  windows: {
    managerNameKey: "workspace:fileManagerExplorer",
    folder: {
      actionLabelKey: "workspace:revealExplorer",
      errorTitleKey: "workspace:unableOpenInExplorer",
    },
    file: {
      actionLabelKey: "workspace:showFileInExplorer",
      errorTitleKey: "workspace:unableShowInExplorer",
    },
  },
  generic: {
    managerNameKey: "workspace:fileManagerGeneric",
    folder: {
      actionLabelKey: "workspace:openFolderGeneric",
      errorTitleKey: "workspace:revealFolderFailed",
    },
    file: {
      actionLabelKey: "workspace:revealFolder",
      errorTitleKey: "workspace:unableShowInFolder",
    },
  },
} as const satisfies Record<FileManagerPlatform, FileManagerPlatformCopy>;

const FILE_MANAGER_FALLBACK_DESCRIPTION_KEYS = {
  folder: "workspace:folderCouldNotBeOpened",
  file: "workspace:fileCouldNotBeShown",
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
  return t(FILE_MANAGER_COPY[classifyPlatform(platform)].managerNameKey);
}

export function resolveFileManagerPresentation(
  kind: FileManagerTargetKind,
  platform: string = getNavigatorPlatform(),
): FileManagerPresentation {
  const platformCopy = FILE_MANAGER_COPY[classifyPlatform(platform)];
  const targetCopy = platformCopy[kind];
  return {
    managerName: t(platformCopy.managerNameKey),
    actionLabel: t(targetCopy.actionLabelKey),
    errorTitle: t(targetCopy.errorTitleKey),
    fallbackDescription: t(FILE_MANAGER_FALLBACK_DESCRIPTION_KEYS[kind]),
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
    : t(FILE_MANAGER_FALLBACK_DESCRIPTION_KEYS[kind]);
}

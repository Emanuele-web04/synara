// FILE: ProjectFolderList.tsx
// Purpose: The "Source folders" field of a project: its folders, primary first, with
//          per-row "Make primary" and remove actions, the shared "Add folder" row, and the
//          multi-folder hint.
// Layer: Web UI (Create project and Edit project dialogs)
// Exports: ProjectFolderList, ProjectFolderAddRow

import { deriveProjectFolderLabels } from "@synara/shared/projectFolders";
import { useId, useState, type ReactNode } from "react";

import { FolderAddIcon, FolderIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { dialogFieldLabelClassName } from "./ui/dialog";
import { IconButton } from "./ui/icon-button";
import { useTranslation } from "~/i18n";

export function ProjectFolderList(props: {
  /** Absolute paths; the first one is the primary folder. */
  readonly folders: ReadonlyArray<string>;
  readonly disabled: boolean;
  /** Omitted when the primary folder cannot change here (editing an existing project). */
  readonly onMakePrimary?: ((index: number) => void) | undefined;
  readonly onRemove: (index: number) => void;
  /** Keeps the primary row without a remove action. */
  readonly primaryLocked?: boolean | undefined;
  /** Last row: how another folder is added (native picker or a typed path). */
  readonly addRow: ReactNode;
  readonly className?: string | undefined;
}) {
  const { t } = useTranslation();
  const labelId = useId();

  const labels = deriveProjectFolderLabels(props.folders);
  return (
    <div className={cn("space-y-2", props.className)}>
      <span
        id={labelId}
        className={cn("block", dialogFieldLabelClassName, "text-ui text-foreground")}
      >
        {t("workspace:sourceFolders")}
      </span>
      <ul
        aria-labelledby={labelId}
        className="divide-y divide-foreground/10 overflow-hidden rounded-xl border border-foreground/12"
      >
        {props.folders.map((folder, index) => (
          <li key={folder} className="flex min-h-12 items-center gap-2.5 px-3.5 py-1.5">
            <FolderIcon className="size-4 shrink-0 text-muted-foreground/70" aria-hidden="true" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-ui text-foreground">{labels[index]}</span>
              <span className="truncate text-ui-xs text-muted-foreground/70" title={folder}>
                {folder}
              </span>
            </span>
            {index === 0 ? (
              <Badge variant="outline" size="sm">
                {t("common:primary")}
              </Badge>
            ) : props.onMakePrimary ? (
              <Button
                variant="ghost"
                size="chip"
                className="text-muted-foreground hover:text-foreground"
                disabled={props.disabled}
                aria-label={t("workspace:makePrimary2", { value0: labels[index] })}
                onClick={() => props.onMakePrimary?.(index)}
              >
                {t("workspace:makePrimary")}
              </Button>
            ) : null}
            {index === 0 && props.primaryLocked ? null : (
              <IconButton
                label={t("workspace:remove", { value0: labels[index] })}
                disabled={props.disabled}
                onClick={() => props.onRemove(index)}
              >
                <XIcon aria-hidden="true" />
              </IconButton>
            )}
          </li>
        ))}
        <li>{props.addRow}</li>
      </ul>
      {props.folders.length > 1 ? (
        <p className="text-ui-xs text-muted-foreground/70">
          {t("workspace:multiFolderProjectHint")}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The "Add folder" row of a folder list: a native folder picker in the desktop app, or a
 * typed path where no native picker exists (browser builds, remote computers).
 */
export function ProjectFolderAddRow(props: {
  readonly picker: boolean;
  readonly disabled: boolean;
  /** The native picker is open. */
  readonly picking?: boolean | undefined;
  /** A folder is being dragged over the window. */
  readonly highlighted?: boolean | undefined;
  readonly inputId?: string | undefined;
  readonly onBrowse: () => void;
  /** Adds a typed folder; returns false to keep the text for correction. */
  readonly onAdd: (path: string) => boolean;
  readonly onInputChange?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");

  if (props.picker) {
    return (
      <button
        type="button"
        disabled={props.disabled}
        className={cn(
          "flex min-h-12 w-full cursor-pointer items-center gap-2.5 px-3.5 text-start text-ui text-[var(--color-text-foreground)] transition-colors outline-none hover:bg-foreground/4 focus-visible:bg-foreground/6 disabled:opacity-50",
          props.highlighted && "bg-foreground/6",
        )}
        onClick={props.onBrowse}
      >
        <FolderAddIcon className="size-4.5" aria-hidden="true" />
        {props.picking ? t("workspace:openingTheFolderPicker") : t("workspace:addFolder")}
      </button>
    );
  }
  const add = () => {
    if (props.onAdd(value)) setValue("");
  };
  return (
    <div className="flex min-h-12 items-center gap-2.5 px-3.5">
      <FolderAddIcon className="size-4.5 shrink-0" aria-hidden="true" />
      <input
        id={props.inputId}
        value={value}
        aria-label={t("workspace:additionalFolderPath")}
        placeholder={t("workspace:pathToAnotherFolder")}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        disabled={props.disabled}
        className="min-w-0 flex-1 bg-transparent text-ui text-foreground outline-none placeholder:text-muted-foreground/70"
        onChange={(event) => {
          setValue(event.target.value);
          props.onInputChange?.();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          add();
        }}
      />
      <Button
        variant="ghost"
        size="chip"
        disabled={props.disabled || value.trim().length === 0}
        onClick={add}
      >
        {t("workspace:addFolder")}
      </Button>
    </div>
  );
}

// FILE: ProjectFolderList.tsx
// Purpose: Lists the source folders of a project being created, primary first, with
//          per-row "Make primary" and remove actions.
// Layer: Web UI (Create project dialog)
// Exports: ProjectFolderList

import { deriveProjectFolderLabels } from "@synara/shared/projectFolders";
import type { ReactNode } from "react";

import { FolderIcon, XIcon } from "~/lib/icons";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";

export function ProjectFolderList(props: {
  /** Absolute paths; the first one is the primary folder. */
  readonly folders: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly labelledBy: string;
  readonly onMakePrimary: (index: number) => void;
  readonly onRemove: (index: number) => void;
  /** Last row: how another folder is added (native picker or a typed path). */
  readonly addRow: ReactNode;
}) {
  const labels = deriveProjectFolderLabels(props.folders);
  return (
    <ul
      aria-labelledby={props.labelledBy}
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
              Primary
            </Badge>
          ) : (
            <Button
              variant="ghost"
              size="chip"
              className="text-muted-foreground hover:text-foreground"
              disabled={props.disabled}
              aria-label={`Make ${labels[index]} primary`}
              onClick={() => props.onMakePrimary(index)}
            >
              Make primary
            </Button>
          )}
          <IconButton
            label={`Remove ${labels[index]}`}
            disabled={props.disabled}
            onClick={() => props.onRemove(index)}
          >
            <XIcon aria-hidden="true" />
          </IconButton>
        </li>
      ))}
      <li>{props.addRow}</li>
    </ul>
  );
}

// FILE: EditedFileRow.tsx
// Purpose: Render one changed-file row; the row itself opens the review and
// compact open-in actions reveal on hover/focus.
// Layer: Chat changed-files UI

import type { EditorId, ResolvedKeybindingsConfig } from "@synara/contracts";
import type { CSSProperties } from "react";

import { useCopyPathToClipboard } from "~/hooks/useCopyToClipboard";
import { CopyIcon, EyeOpenIcon } from "~/lib/icons";
import { useWorkspaceFileOpener } from "~/lib/workspaceFileOpener";
import { cn } from "~/lib/utils";

import { MenuItem } from "../ui/menu";
import { DiffStatLabel } from "./DiffStatLabel";
import { FileEntryIcon } from "./FileEntryIcon";
import { OpenInPicker } from "./OpenInPicker";
import { resolveEditedFilePathTargets } from "./editedFilePathActions";

interface EditedFileRowProps {
  filePath: string;
  fileKind: string;
  additions: number;
  deletions: number;
  workspaceRoot: string | undefined;
  keybindings?: ResolvedKeybindingsConfig;
  availableEditors?: ReadonlyArray<EditorId>;
  resolvedTheme: "light" | "dark";
  fontSize: CSSProperties["fontSize"];
  withFirstReset: boolean;
  onReview: () => void;
}

const MENU_ICON_CLASS_NAME = "size-3.5 shrink-0 text-muted-foreground";
const EDITED_FILE_EDITOR_ORDER: ReadonlyArray<EditorId> = [
  "file-manager",
  "vscode",
  "cursor",
  "webstorm",
  "terminal",
  "iterm",
];

export function EditedFileRow(props: EditedFileRowProps) {
  const workspaceFileOpener = useWorkspaceFileOpener();
  const copyPathToClipboard = useCopyPathToClipboard();
  const { absolutePath, relativePath } = resolveEditedFilePathTargets(
    props.filePath,
    props.workspaceRoot,
  );
  const isDeleted = props.fileKind === "deleted";
  const launcherTarget = isDeleted ? null : absolutePath;
  const hasInAppTarget =
    absolutePath !== null || (props.workspaceRoot !== undefined && relativePath !== null);
  const canOpenInApp = !isDeleted && workspaceFileOpener !== null && hasInAppTarget;
  const hasDiffStat = props.additions + props.deletions > 0;

  return (
    <div
      data-edited-file-row="true"
      className={cn(
        "group/edited-file-row flex w-full min-w-0 items-center gap-1.5 overflow-hidden border-t border-[color:var(--color-border-light)] bg-transparent py-1.5 pr-2 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] dark:bg-transparent dark:hover:bg-transparent",
        props.withFirstReset && "first:border-t-0",
      )}
    >
      <button
        type="button"
        aria-label={`Review changes to ${props.filePath}`}
        className="group/file-row flex min-w-0 flex-1 items-center gap-2 self-stretch bg-transparent py-1 pl-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        onClick={props.onReview}
      >
        <FileEntryIcon
          pathValue={props.filePath}
          kind="file"
          theme={props.resolvedTheme}
          colorMode="inherit"
          className="size-4 shrink-0 text-[var(--color-text-foreground)] opacity-70 dark:opacity-80"
        />
        <span
          className="font-system-ui min-w-0 truncate font-normal text-[var(--color-text-foreground)] underline-offset-2 group-hover/file-row:underline group-focus-visible/file-row:underline"
          style={{ fontSize: props.fontSize }}
          title={props.filePath}
        >
          {props.filePath}
        </span>
        {hasDiffStat ? (
          <span
            className="font-system-ui ml-auto shrink-0 tabular-nums"
            style={{ fontSize: props.fontSize }}
          >
            <DiffStatLabel additions={props.additions} deletions={props.deletions} />
          </span>
        ) : null}
      </button>

      {/* Per-row actions stay quiet until the row is hovered/focused (or the menu is
          open) so a long file list reads as filenames + diff stats, not button chrome.
          The whole row already opens the review, so no per-row Review button. */}
      <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/edited-file-row:opacity-100 group-focus-within/edited-file-row:opacity-100 group-has-[[data-popup-open]]/edited-file-row:opacity-100 motion-reduce:transition-none">
        <OpenInPicker
          variant="compact"
          {...(props.keybindings ? { keybindings: props.keybindings } : {})}
          {...(props.availableEditors ? { availableEditors: props.availableEditors } : {})}
          openInTarget={launcherTarget}
          menuEditorOrder={EDITED_FILE_EDITOR_ORDER}
          groupLabel={`Open ${props.filePath}`}
          menuLabel={`Open ${props.filePath} options`}
          primaryAction={{
            disabled: !canOpenInApp,
            icon: <EyeOpenIcon aria-hidden="true" className="size-3.5" />,
            onClick: () => {
              workspaceFileOpener?.openFile(props.filePath);
            },
          }}
          additionalMenuItems={
            <>
              <MenuItem
                disabled={absolutePath === null}
                onClick={() => {
                  if (absolutePath) copyPathToClipboard(absolutePath);
                }}
              >
                <CopyIcon className={MENU_ICON_CLASS_NAME} />
                <span>Copy absolute path</span>
              </MenuItem>
              <MenuItem
                disabled={relativePath === null}
                onClick={() => {
                  if (relativePath) copyPathToClipboard(relativePath);
                }}
              >
                <CopyIcon className={MENU_ICON_CLASS_NAME} />
                <span>Copy relative path</span>
              </MenuItem>
            </>
          }
        />
      </div>
    </div>
  );
}

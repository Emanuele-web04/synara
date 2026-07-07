// FILE: DiffPanelFileJumpMenu.tsx
// Purpose: Searchable "jump to file" picker for the diff panel toolbar. Reuses the
//          composer picker shell and FileEntryIcon (central-icons-reversed) so file
//          rows match the command menu and git pane.
// Layer: Diff panel UI

import type { FileDiffMetadata } from "@pierre/diffs/react";
import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { SearchIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { filterRenderableFilesForSearch } from "./DiffPanel.logic";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { PickerPanelShell } from "./chat/PickerPanelShell";
import { FileEntryIcon } from "./chat/FileEntryIcon";
import { DiffStat } from "./chat/DiffStatLabel";
import { IconButton } from "./ui/icon-button";
import { Menu, MenuItem, MenuTrigger } from "./ui/menu";
import {
  resolveFileDiffPath,
  splitRepoRelativePath,
  summarizeFileDiffStats,
} from "../lib/diffRendering";

const DIFF_FILE_JUMP_ICON_SLOT_CLASS_NAME =
  "flex size-4 shrink-0 items-center justify-center text-muted-foreground/60";

const DIFF_FILE_JUMP_FILE_ICON_CLASS_NAME =
  "size-3.5 text-[var(--color-text-foreground)] opacity-70 dark:opacity-80";

const DiffFileJumpRow = memo(function DiffFileJumpRow(props: {
  fileDiff: FileDiffMetadata;
  resolvedTheme: "light" | "dark";
  isSelected: boolean;
  onSelect: (filePath: string) => void;
}) {
  const filePath = resolveFileDiffPath(props.fileDiff);
  const { dir, name } = splitRepoRelativePath(filePath);
  const stat = useMemo(() => summarizeFileDiffStats([props.fileDiff]), [props.fileDiff]);

  return (
    <MenuItem
      className={cn(
        "gap-2 px-2 py-1.5",
        props.isSelected && "bg-[var(--color-background-button-secondary)]",
      )}
      onClick={() => {
        props.onSelect(filePath);
      }}
    >
      <span className={DIFF_FILE_JUMP_ICON_SLOT_CLASS_NAME}>
        <FileEntryIcon
          pathValue={filePath}
          kind="file"
          theme={props.resolvedTheme}
          className={DIFF_FILE_JUMP_FILE_ICON_CLASS_NAME}
        />
      </span>
      <div className="min-w-0 flex flex-1 items-center gap-2 overflow-hidden">
        <div className="min-w-0 flex flex-1 items-baseline gap-1.5 overflow-hidden">
          <span className="shrink-0 text-[11.5px] font-medium text-foreground/85">{name}</span>
          {dir ? (
            <span className="truncate text-[11px] text-muted-foreground/55">{dir}</span>
          ) : null}
        </div>
        <DiffStat
          additions={stat.additions}
          deletions={stat.deletions}
          className="shrink-0 text-[10px] tabular-nums"
        />
      </div>
    </MenuItem>
  );
});

export function DiffPanelFileJumpMenu(props: {
  renderableFiles: ReadonlyArray<FileDiffMetadata>;
  selectedFilePath: string | null;
  resolvedTheme: "light" | "dark";
  onSelectFile: (filePath: string) => void;
}) {
  const { t } = useTranslation();
  const [fileSearchQuery, setFileSearchQuery] = useState("");

  const filteredFiles = useMemo(
    () => filterRenderableFilesForSearch(props.renderableFiles, fileSearchQuery),
    [fileSearchQuery, props.renderableFiles],
  );

  return (
    <Menu
      onOpenChange={(open) => {
        if (!open) {
          setFileSearchQuery("");
        }
      }}
    >
      <MenuTrigger
        render={
          <IconButton
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground"
            label={t("diff.jumpToFile")}
            title={t("diff.jumpToFile")}
          >
            <SearchIcon className="size-3.5" />
          </IconButton>
        }
      />
      <ComposerPickerMenuPopup
        align="end"
        side="bottom"
        sideOffset={6}
        className="w-[min(24rem,calc(100vw-2rem))] min-w-[18rem]"
      >
        <PickerPanelShell
          searchPlaceholder={t("diff.jumpToFile")}
          query={fileSearchQuery}
          onQueryChange={setFileSearchQuery}
          stopSearchKeyPropagation
          autoFocusSearch
          widthClassName="w-full"
          bleedParentPadding
          listMaxHeightClassName="max-h-64"
        >
          {props.renderableFiles.length === 0 ? (
            <p className="px-2.5 py-3 text-[11px] text-muted-foreground">
              {t("diff.noFilesInDiff")}
            </p>
          ) : filteredFiles.length === 0 ? (
            <p className="px-2.5 py-3 text-[11px] text-muted-foreground">
              {t("diff.noMatchingFiles")}
            </p>
          ) : (
            filteredFiles.map((fileDiff) => {
              const filePath = resolveFileDiffPath(fileDiff);
              return (
                <DiffFileJumpRow
                  key={fileDiff.cacheKey ?? filePath}
                  fileDiff={fileDiff}
                  resolvedTheme={props.resolvedTheme}
                  isSelected={props.selectedFilePath === filePath}
                  onSelect={(path) => {
                    props.onSelectFile(path);
                    setFileSearchQuery("");
                  }}
                />
              );
            })
          )}
        </PickerPanelShell>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

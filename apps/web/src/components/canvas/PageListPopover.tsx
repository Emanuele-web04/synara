// FILE: PageListPopover.tsx
// Purpose: The page list: a "Page ⌄" trigger (with the agent indicator while an agent works on
//          another page) opening the pages (with their icons and the list's dividers) with an add
//          button in the heading, inline rename (double-click, F2 or the pencil), per-row actions
//          and the shared page menu on right-click.
// Layer: Canvas UI
// Exports: PageListPopover, PageListEntry

import { useId, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useTranslation } from "~/i18n";
import { AddPlusIcon, CheckIcon, ChevronDownIcon, PencilIcon, TrashCanIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { MENU_ICON_CLASS_NAME } from "../chat/composerPickerStyles";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { CanvasAgentIconSlot, CanvasAgentIndicator } from "./editor/CanvasAgentActivity";
import { CanvasPageGlyph } from "./canvasPageIcons";
import { Menu, MenuGroup, MenuItem, MenuSeparator, MenuTrigger } from "../ui/menu";
import { TreeRowRenameInput } from "../ui/TreeRow";

/** A row of the list: a page, or a divider line between groups of pages. */
export type PageListEntry =
  | { kind: "page"; id: string; title: string; icon?: string | undefined }
  | { kind: "divider"; id: string };
type PageListItem = Extract<PageListEntry, { kind: "page" }>;

/** Row actions stay clickable without selecting the page or closing the list. */
function rowAction(run: () => void) {
  return {
    tabIndex: -1,
    onPointerDown: (event: MouseEvent) => event.stopPropagation(),
    onDoubleClick: (event: MouseEvent) => event.stopPropagation(),
    onClick: (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      run();
    },
  };
}

export function PageListPopover({
  entries,
  currentId,
  readOnly,
  canAdd,
  canDelete,
  maxTitleLength,
  onSelect,
  onAdd,
  onRename,
  onDelete,
  onEntryContextMenu,
  activePageIds,
}: {
  /** Pages an agent is working on (the activity indicator in place of the page icon). */
  activePageIds?: ReadonlySet<string> | undefined;
  entries: readonly PageListEntry[];
  currentId: string;
  readOnly: boolean;
  canAdd: boolean;
  canDelete: boolean;
  maxTitleLength: number;
  onSelect: (id: string) => void;
  /** Creates a page and resolves with its id (null on failure); the new page opens for renaming. */
  onAdd: () => Promise<string | null>;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  /** Right-click on a page or divider; `rename` starts renaming a page in this list. */
  onEntryContextMenu?:
    | ((id: string, position: { x: number; y: number }, rename: (id: string) => void) => void)
    | undefined;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const current = entries.find(
    (entry): entry is PageListItem => entry.kind === "page" && entry.id === currentId,
  );
  // The open page shows an agent's work on the canvas; another page's shows on the trigger.
  const agentElsewhere = entries.some(
    (entry) => entry.kind === "page" && entry.id !== currentId && activePageIds?.has(entry.id),
  );
  const startRename = (id: string) => {
    if (!readOnly) setRenamingId(id);
  };
  const contextMenu = (id: string) => (event: MouseEvent) => {
    if (!onEntryContextMenu) return;
    event.preventDefault();
    onEntryContextMenu(id, { x: event.clientX, y: event.clientY }, startRename);
  };
  const onRowKeyDown = (event: KeyboardEvent, page: PageListItem) => {
    if (readOnly) return;
    if (event.key === "F2") {
      event.preventDefault();
      startRename(page.id);
    } else if ((event.key === "Delete" || event.key === "Backspace") && canDelete) {
      event.preventDefault();
      onDelete(page.id);
    }
  };

  return (
    // Pointer moves would otherwise move focus out of the rename field.
    <Menu highlightItemOnHover={renamingId === null}>
      <MenuTrigger render={<Button variant="ghost" size="xs" className="min-w-0 shrink-0" />}>
        <span className="truncate">{current?.title}</span>
        <CanvasAgentIndicator active={agentElsewhere} scope="otherPage" />
        <ChevronDownIcon className="size-3" />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="start" className="w-55">
        <div className="flex items-center justify-between ps-2">
          <span id={headingId} className="text-ui-sm font-medium text-foreground">
            {t("workspace:canvasPages")}
          </span>
          {!readOnly && (
            <MenuItem
              aria-label={t("workspace:canvasAddPage")}
              title={t("workspace:canvasAddPage")}
              closeOnClick={false}
              disabled={!canAdd}
              onClick={() =>
                void onAdd().then((id) => {
                  if (id) startRename(id);
                })
              }
            >
              <AddPlusIcon className="size-3" />
            </MenuItem>
          )}
        </div>
        <MenuGroup aria-labelledby={headingId}>
          {entries.map((page) => {
            if (page.kind === "divider")
              return (
                // The padding gives the line a target for its menu.
                <div
                  key={page.id}
                  data-page-divider=""
                  className="py-1"
                  onContextMenu={readOnly ? undefined : contextMenu(page.id)}
                >
                  <MenuSeparator className="my-0" />
                </div>
              );
            const selected = page.id === currentId;
            if (renamingId === page.id)
              return (
                <div key={page.id} className="flex h-6.5 items-center gap-2 ps-2 pe-1">
                  <CanvasPageGlyph
                    icon={page.icon}
                    className={cn(MENU_ICON_CLASS_NAME, "opacity-60")}
                  />
                  <TreeRowRenameInput
                    defaultValue={page.title}
                    label={t("workspace:canvasRenamePage")}
                    maxLength={maxTitleLength}
                    onCancel={() => setRenamingId(null)}
                    onCommit={(value) => {
                      setRenamingId(null);
                      const title = value.trim();
                      if (title && title !== page.title) onRename(page.id, title);
                    }}
                  />
                </div>
              );
            return (
              <MenuItem
                key={page.id}
                aria-current={selected ? "page" : undefined}
                aria-keyshortcuts={readOnly ? undefined : "F2 Delete"}
                // The list stays open while switching, so a double-click can rename.
                closeOnClick={false}
                // The open page has a check after its name, as in the Pages list.
                className="group/page-row pe-1"
                onClick={() => onSelect(page.id)}
                onDoubleClick={() => startRename(page.id)}
                onKeyDown={(event) => onRowKeyDown(event, page)}
                onContextMenu={readOnly ? undefined : contextMenu(page.id)}
              >
                {/* A page an agent is working on shows the activity indicator instead of its
                    icon, inset like the menu's icons so the title stays put. */}
                <CanvasAgentIconSlot
                  active={activePageIds?.has(page.id) === true}
                  scope="page"
                  className="-mx-0.5"
                  icon={
                    <CanvasPageGlyph
                      icon={page.icon}
                      className={cn(MENU_ICON_CLASS_NAME, !selected && "opacity-60")}
                    />
                  }
                />
                <span className="min-w-0 flex-1 truncate">{page.title}</span>
                {selected ? (
                  <CheckIcon
                    aria-hidden
                    className="size-3.5 shrink-0 group-hover/page-row:hidden group-data-highlighted/page-row:hidden"
                  />
                ) : null}
                {!readOnly && (
                  <span className="hidden shrink-0 items-center group-hover/page-row:flex group-data-highlighted/page-row:flex">
                    <IconButton
                      size="icon-xs"
                      label={t("workspace:canvasRenamePage")}
                      {...rowAction(() => startRename(page.id))}
                    >
                      <PencilIcon className="size-3" />
                    </IconButton>
                    <IconButton
                      size="icon-xs"
                      label={t("workspace:canvasDeletePage")}
                      disabled={!canDelete}
                      {...rowAction(() => onDelete(page.id))}
                    >
                      <TrashCanIcon className="size-3" />
                    </IconButton>
                  </span>
                )}
              </MenuItem>
            );
          })}
        </MenuGroup>
        {!readOnly && (
          <p className="px-2 pt-1.5 pb-0.5 text-ui-2xs text-muted-foreground">
            {t("workspace:canvasPagesRenameHint")}
          </p>
        )}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

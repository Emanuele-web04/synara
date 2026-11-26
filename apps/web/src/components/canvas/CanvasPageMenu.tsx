import type { CanvasWork } from "@synara/contracts";
import { useTranslation } from "~/i18n";
import { useActiveAgentPages } from "./canvasStores";
import { showCanvasPageMenu } from "./canvasPageContextMenu";
import { PageListPopover } from "./PageListPopover";
import { CANVAS_PAGE_TITLE_MAX_LENGTH, useCanvasPageActions } from "./useCanvasPageActions";

/** The page switcher: pick, add, rename, delete, and the page and divider menus. */
export function CanvasPageMenu({
  work,
  pageId,
  onSelect,
}: {
  work: CanvasWork;
  pageId: string;
  onSelect: (pageId: string) => void;
}) {
  const { t } = useTranslation();
  const pages = useCanvasPageActions(work, pageId, onSelect);
  const activePageIds = useActiveAgentPages(work.id);
  return (
    <PageListPopover
      activePageIds={activePageIds}
      entries={pages.items.map((item) =>
        item.kind === "page"
          ? { kind: "page", id: item.id, title: item.page.title, icon: item.page.icon }
          : item,
      )}
      currentId={pageId}
      readOnly={pages.readOnly}
      canAdd={pages.canCreate}
      canDelete={pages.canDelete}
      maxTitleLength={CANVAS_PAGE_TITLE_MAX_LENGTH}
      onSelect={onSelect}
      onAdd={pages.create}
      onRename={(id, title) => void pages.rename(id, title)}
      onDelete={(id) => void pages.remove(id)}
      onEntryContextMenu={(id, position, rename) => {
        const item = pages.items.find((entry) => entry.id === id);
        if (item) void showCanvasPageMenu({ t, pages, item, position, onRename: rename });
      }}
    />
  );
}

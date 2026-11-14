// FILE: DockList.tsx
// Purpose: Shared shape of the right-dock run lists (Subagents, Background tasks): the
//          scroll container, "Active · 2" section headings, and a finished section that
//          folds its tail behind "Show more".
// Layer: Chat right-dock UI primitives
// Exports: DOCK_LIST_CLASS_NAME, DOCK_LIST_SECONDARY_TEXT_CLASS_NAME, DockListHeading,
//          DockListCappedSection

import { useState, type ReactNode } from "react";

import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { useTranslation } from "~/i18n";
import { cn } from "~/lib/utils";

import { EnvironmentRow } from "./environment/EnvironmentRow";

export const DOCK_LIST_CLASS_NAME =
  "flex h-full min-h-0 w-full min-w-0 flex-col gap-0.5 overflow-y-auto px-3 py-4";

export const DOCK_LIST_SECONDARY_TEXT_CLASS_NAME = "text-[var(--color-text-foreground-secondary)]";

export function DockListHeading({ label, count }: { label: string; count: number }) {
  return (
    <p className={cn("px-2 pt-3 pb-1 text-ui-sm first:pt-0", DOCK_LIST_SECONDARY_TEXT_CLASS_NAME)}>
      {label} · {count}
    </p>
  );
}

// A heading, the first `limit` rows, and the rest behind a "Show more" toggle.
export function DockListCappedSection<Item>({
  label,
  items,
  limit,
  renderItem,
}: {
  label: string;
  items: ReadonlyArray<Item>;
  limit: number;
  renderItem: (item: Item) => ReactNode;
}) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);

  if (items.length === 0) {
    return null;
  }
  const hiddenCount = showAll ? 0 : Math.max(0, items.length - limit);

  return (
    <>
      <DockListHeading label={label} count={items.length} />
      {items.slice(0, limit).map(renderItem)}
      <DisclosureRegion open={showAll}>{items.slice(limit).map(renderItem)}</DisclosureRegion>
      {items.length > limit ? (
        <EnvironmentRow
          compact
          icon={<DisclosureChevron open={showAll} className="size-5 shrink-0" />}
          label={
            <span className={DOCK_LIST_SECONDARY_TEXT_CLASS_NAME}>
              {hiddenCount > 0
                ? t("chat:showMore", { value0: hiddenCount })
                : t("workspace:timeline_showLess")}
            </span>
          }
          aria-expanded={hiddenCount === 0}
          onClick={() => setShowAll((value) => !value)}
        />
      ) : null}
    </>
  );
}

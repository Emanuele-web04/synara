// FILE: whatsNew/ChangelogAccordion.tsx
// Purpose: Collapsible release-history accordion used by both the Settings
// "Release history" surface and the `WhatsNewDialog` "Complete changelog"
// secondary view. Each row summarises a release; expanding reveals the
// FeatureSection cards for that version.
// Layer: presentational — it assumes the caller has already sorted entries
// newest-first (see `sortEntriesByVersionDesc`).

import { useState } from "react";

import { pluralize } from "~/i18n/pluralize";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { cn } from "~/lib/utils";

import { FeatureSection } from "./FeatureSection";
import type { WhatsNewEntry } from "./logic";
import { useTranslation } from "~/i18n";

export interface ChangelogAccordionProps {
  readonly entries: readonly WhatsNewEntry[];
  /**
   * The version to expand by default. When set, the matching row is open on
   * mount; all other rows start collapsed. Useful in the dialog, where we
   * want the installed build's notes front-and-center even in the changelog
   * view.
   */
  readonly defaultExpandedVersion?: string | null;
  readonly className?: string;
}

export function ChangelogAccordion({
  entries,
  defaultExpandedVersion: defaultExpandedVersionProp,
  className,
}: ChangelogAccordionProps) {
  const { t } = useTranslation();

  const defaultExpandedVersion = defaultExpandedVersionProp ?? null;
  if (entries.length === 0) {
    return (
      <p className={cn("text-ui leading-snug text-muted-foreground", className)}>
        {t("common:noReleaseNotesYetCheckBackAfterTheNext")}
      </p>
    );
  }

  return (
    <ul className={cn("flex flex-col", className)}>
      {entries.map((entry, index) => (
        <ChangelogAccordionRow
          key={entry.version}
          entry={entry}
          defaultOpen={entry.version === defaultExpandedVersion}
          isLast={index === entries.length - 1}
        />
      ))}
    </ul>
  );
}

function ChangelogAccordionRow({
  entry,
  defaultOpen,
  isLast,
}: {
  readonly entry: WhatsNewEntry;
  readonly defaultOpen: boolean;
  readonly isLast: boolean;
}) {
  const { t } = useTranslation();

  const [open, setOpen] = useState(defaultOpen);

  const featureCount = entry.features.length;
  const featureLabel = t("chat:symbol7", {
    value0: featureCount,
    value1: pluralize(featureCount, "update"),
  });

  return (
    <li className={cn(!isLast && "border-b border-border/40")}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group flex w-full items-center gap-3 py-3 text-left">
          <DisclosureChevron open={open} />
          <span className="flex flex-1 items-baseline gap-2">
            <span className="text-ui leading-snug text-muted-foreground">{entry.date}</span>
            <span className="text-ui-lg font-semibold text-foreground">
              {t("settings:advanced_version")} {entry.version}
            </span>
            <span className="text-ui leading-snug text-muted-foreground/70">({featureLabel})</span>
          </span>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="flex flex-col gap-6 pb-4 pl-6 pr-1">
            {entry.features.map((feature) => (
              <FeatureSection key={feature.id} feature={feature} />
            ))}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </li>
  );
}

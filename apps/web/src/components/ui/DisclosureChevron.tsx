// FILE: DisclosureChevron.tsx
// Purpose: Shared rotating chevron used by collapsible headers across chat and sidebar surfaces.
// Layer: UI primitive
// Exports: DisclosureChevron

import { ChevronRightIcon } from "~/lib/icons";
import { disclosureChevronClassName } from "~/lib/disclosureMotion";
import { cn } from "~/lib/utils";

export function DisclosureChevron(props: { open: boolean; className?: string | undefined }) {
  const { open, className } = props;

  return (
    <ChevronRightIcon
      aria-hidden="true"
      className={cn(disclosureChevronClassName(open), className)}
    />
  );
}

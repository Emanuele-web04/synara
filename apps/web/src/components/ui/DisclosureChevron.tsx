// FILE: DisclosureChevron.tsx
// Purpose: Shared rotating chevron used by collapsible headers across chat and sidebar surfaces.
// Layer: UI primitive
// Exports: DisclosureChevron

import { ChevronRightIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

export function DisclosureChevron(props: { open: boolean; className?: string | undefined }) {
  const { open, className } = props;

  return (
    <ChevronRightIcon
      aria-hidden="true"
      className={cn(
        "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out",
        open && "rotate-90",
        className,
      )}
    />
  );
}

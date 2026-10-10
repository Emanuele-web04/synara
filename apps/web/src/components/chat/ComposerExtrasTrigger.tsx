// FILE: ComposerExtrasTrigger.tsx
// Purpose: Composer `+` trigger. The panel it toggles renders above the composer
//   (ComposerExtrasPanel) so it shares the command-menu surface instead of a dropdown.
// Layer: Chat composer presentation
// Depends on: shared button primitive and caller-owned open state.

import { PlusIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { COMPOSER_EXTRAS_TRIGGER_ATTRIBUTE } from "./ComposerExtrasPanel";

export function ComposerExtrasTrigger(props: {
  open: boolean;
  panelId: string;
  onToggle: () => void;
}) {
  return (
    <Button
      size="icon-sm"
      variant="chrome"
      className={cn(
        "shrink-0 rounded-md",
        props.open && "bg-[var(--color-background-button-secondary)]",
      )}
      aria-label="Composer extras"
      aria-expanded={props.open}
      aria-controls={props.open ? props.panelId : undefined}
      {...{ [COMPOSER_EXTRAS_TRIGGER_ATTRIBUTE]: "" }}
      onClick={props.onToggle}
    >
      <PlusIcon aria-hidden="true" className="size-4 text-primary" />
    </Button>
  );
}

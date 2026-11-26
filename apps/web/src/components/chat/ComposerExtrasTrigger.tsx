import { useTranslation } from "~/i18n";
// FILE: ComposerExtrasTrigger.tsx
// Purpose: Composer `+` trigger. The panel it toggles renders above the composer
//   (ComposerExtrasPanel) so it shares the command-menu surface instead of a dropdown.
// Layer: Chat composer presentation
// Depends on: shared button primitive and caller-owned open state.

import { PlusIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { COMPOSER_EXTRAS_TRIGGER_ATTRIBUTE } from "./ComposerExtrasPanel";
import { COMPOSER_ACTION_CIRCLE_CLASS_NAME } from "./composerPickerStyles";

export function ComposerExtrasTrigger(props: {
  open: boolean;
  panelId: string;
  onToggle: () => void;
}) {
  const { t } = useTranslation();

  return (
    <Button
      size="icon-sm"
      variant="circle"
      className={cn(
        COMPOSER_ACTION_CIRCLE_CLASS_NAME,
        props.open && "bg-[var(--color-background-button-secondary-hover)]",
      )}
      aria-label={t("chat:composerExtras_extras")}
      aria-expanded={props.open}
      aria-controls={props.open ? props.panelId : undefined}
      {...{ [COMPOSER_EXTRAS_TRIGGER_ATTRIBUTE]: "" }}
      onClick={props.onToggle}
    >
      <PlusIcon aria-hidden="true" className="size-3.5" />
    </Button>
  );
}

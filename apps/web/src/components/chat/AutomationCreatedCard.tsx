// FILE: AutomationCreatedCard.tsx
// Purpose: Transcript card shown when an automation is created from a thread. Replaces the
//          plain "Created automation: …" tool-call line with a glanceable box that mirrors
//          the automations view: clock glyph, automation name, cadence, and an Open action.
// Layer: Chat transcript UI

import { memo } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "~/components/ui/button";
import { ClockIcon } from "~/lib/icons";

export const AutomationCreatedCard = memo(function AutomationCreatedCard({
  name,
  cadenceLabel,
  textFontSizePx,
  metaFontSizePx,
  onOpen,
}: {
  readonly name: string;
  readonly cadenceLabel: string;
  readonly textFontSizePx?: number;
  readonly metaFontSizePx?: number;
  readonly onOpen?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-primary)] px-3 py-2.5">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-secondary)] text-[var(--color-text-foreground)]">
        <ClockIcon className="size-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p
          className="truncate font-medium text-[var(--color-text-foreground)]"
          style={textFontSizePx ? { fontSize: `${textFontSizePx}px` } : undefined}
          title={name}
        >
          {name}
        </p>
        {cadenceLabel ? (
          <p
            className="truncate text-[var(--color-text-foreground-secondary)]"
            style={metaFontSizePx ? { fontSize: `${metaFontSizePx}px` } : undefined}
          >
            {cadenceLabel}
          </p>
        ) : null}
      </div>
      {onOpen ? (
        <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={onOpen}>
          {t("notification.open")}
        </Button>
      ) : null}
    </div>
  );
});

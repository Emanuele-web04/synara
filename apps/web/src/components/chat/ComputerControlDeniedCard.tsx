// FILE: ComputerControlDeniedCard.tsx
// Purpose: Transcript card shown when an agent's desktop tool call was rejected because
//          the chat has computer control switched off. Replaces the buried tool error
//          with a one-click way to switch control on and retry.
// Layer: Chat transcript UI

import { ComputerActionCard } from "./ComputerActionCard";
import { useTranslation } from "~/i18n";

export function ComputerControlDeniedCard({
  computerControlEnabled,
  textFontSizePx,
  metaFontSizePx,
  onEnable,
}: {
  // Live composer state: once the user (or this card) switches control on, the
  // card flips to a confirmation instead of offering a dead button.
  readonly computerControlEnabled?: boolean;
  readonly textFontSizePx?: number;
  readonly metaFontSizePx?: number;
  readonly onEnable?: () => void;
}) {
  const { t } = useTranslation();

  const enabled = computerControlEnabled === true;
  return (
    <ComputerActionCard
      tone={enabled ? "success" : "warning"}
      title={enabled ? t("Computer control is on for this chat") : t("Computer control is off")}
      textFontSizePx={textFontSizePx}
      metaFontSizePx={metaFontSizePx}
      action={onEnable && !enabled ? { label: t("Enable"), onClick: onEnable } : undefined}
    >
      <p>
        {enabled
          ? t("Queued desktop turns stay cancelled — send a fresh message to continue.")
          : t("Turn it on in Settings to let the agent use the desktop.")}
      </p>
    </ComputerActionCard>
  );
}

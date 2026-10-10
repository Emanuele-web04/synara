// FILE: ComputerControlDeniedCard.tsx
// Purpose: Transcript card shown when an agent's desktop tool call was rejected because
//          the chat has computer control switched off. Replaces the buried tool error
//          with a one-click way to switch control on and retry.
// Layer: Chat transcript UI

import { ComputerActionCard } from "./ComputerActionCard";

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
  const enabled = computerControlEnabled === true;
  return (
    <ComputerActionCard
      tone={enabled ? "success" : "warning"}
      title={enabled ? "Computer control is on for this chat" : "Computer control is off"}
      textFontSizePx={textFontSizePx}
      metaFontSizePx={metaFontSizePx}
      action={onEnable && !enabled ? { label: "Enable", onClick: onEnable } : undefined}
    >
      <p>
        {enabled
          ? "Queued desktop turns stay cancelled — send a fresh message to continue."
          : "Turn it on in Settings to let the agent use the desktop."}
      </p>
    </ComputerActionCard>
  );
}

// FILE: BotTemplateChip.tsx
// Purpose: One role a new bot can start from, as a chip: the role's mascot and its name, filled
//          while it is the chosen one. Shared by the bot sheet and the New bot steps.
// Layer: SynBot editor UI
// Exports: BotTemplateChip

import type { BotTemplate } from "@synara/shared/bots";

import { CapsuleButton } from "../kit/controls";
import { BotMascot } from "../kit/Mascot";

export function BotTemplateChip({
  template,
  chosen,
  size,
  onPick,
}: {
  readonly template: BotTemplate;
  readonly chosen: boolean;
  /** "small": the sheet's 24 px pill; "compact": the New bot steps' 28 px pill. */
  readonly size: "small" | "compact";
  readonly onPick: () => void;
}) {
  return (
    <CapsuleButton
      kind={chosen ? "normal" : "ghost"}
      small={size === "small"}
      compact={size === "compact"}
      chosen={chosen}
      onClick={onPick}
    >
      <BotMascot shape={template.mascot.shape} color={template.mascot.color} size={14} still />
      {template.name}
    </CapsuleButton>
  );
}

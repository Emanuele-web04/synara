// FILE: InlineAgentChip.tsx
// Purpose: Shared inline agent mention chip (robot icon + @alias + per-agent
//          color), so the composer echo and read-only prompts render agent
//          mentions identically. Mirrors InlineMentionChip / InlineLinkChip.
// Layer: Shared UI component
// Exports: InlineAgentChip

import { memo } from "react";
import { BotIcon } from "~/lib/icons";
import {
  COMPOSER_INLINE_AGENT_CHIP_CLASS_NAME,
  COMPOSER_INLINE_AGENT_CHIP_ICON_CLASS_NAME,
  resolveAgentChipColor,
} from "../composerInlineChip";
import { InlineChipContent } from "../InlineChip";

export const InlineAgentChip = memo(function InlineAgentChip(props: {
  alias: string;
  color: string;
}) {
  const colors = resolveAgentChipColor(props.color);
  return (
    <span
      className={COMPOSER_INLINE_AGENT_CHIP_CLASS_NAME}
      style={{ backgroundColor: colors.bg, color: colors.text }}
    >
      <InlineChipContent
        icon={<BotIcon className={COMPOSER_INLINE_AGENT_CHIP_ICON_CLASS_NAME} />}
        label={`@${props.alias}`}
      />
    </span>
  );
});

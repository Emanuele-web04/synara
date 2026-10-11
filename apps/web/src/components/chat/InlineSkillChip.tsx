// FILE: InlineSkillChip.tsx
// Purpose: Shared inline skill mention chip (building-blocks icon + formatted
//          label), so the composer echo and any read-only prompt render skills
//          identically. Mirrors InlineMentionChip / InlineLinkChip.
// Layer: Shared UI component
// Exports: InlineSkillChip

import { CentralIcon } from "~/lib/central-icons";
import {
  COMPOSER_INLINE_CHIP_INLINE_ICON_CLASS_NAME,
  COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME,
  COMPOSER_INLINE_SKILL_CHIP_ICON_NAME,
  formatComposerSkillChipLabel,
} from "../composerInlineChip";
import { InlineChipContent } from "../InlineChip";

export const InlineSkillChip = function InlineSkillChip(props: { skillName: string }) {
  return (
    <span className={COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME}>
      <InlineChipContent
        icon={
          <CentralIcon
            name={COMPOSER_INLINE_SKILL_CHIP_ICON_NAME}
            className={COMPOSER_INLINE_CHIP_INLINE_ICON_CLASS_NAME}
          />
        }
        label={formatComposerSkillChipLabel(props.skillName)}
      />
    </span>
  );
};

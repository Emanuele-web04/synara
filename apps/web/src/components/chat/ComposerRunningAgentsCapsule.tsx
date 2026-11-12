import { useTranslation } from "~/i18n";
// FILE: ComposerRunningAgentsCapsule.tsx
// Purpose: Compact "N agents running" capsule above the composer while any of the
// thread's subagents is still at work, during the turn and after it settles. A
// click opens the Subagents list on the right, like the Environment panel.
// Layer: Chat composer UI
// Exports: ComposerRunningAgentsCapsule

import { pluralize } from "@synara/shared/text";

import { BotIcon } from "~/lib/icons";
import { ComposerCapsule } from "./ComposerCapsule";
import { COMPOSER_STACKED_PANEL_ICON_CLASS_NAME } from "./composerStackedPanelStyles";

interface ComposerRunningAgentsCapsuleProps {
  count: number;
  /** Opens the Subagents list beside the chat. */
  onShow?: (() => void) | undefined;
}

export function ComposerRunningAgentsCapsule({ count, onShow }: ComposerRunningAgentsCapsuleProps) {
  const { t } = useTranslation();

  return (
    <ComposerCapsule
      icon={<BotIcon className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />}
      onClick={onShow}
      testId="running-agents-capsule"
    >
      {count} {pluralize(count, "agent")} {t("chat:running")}
    </ComposerCapsule>
  );
}

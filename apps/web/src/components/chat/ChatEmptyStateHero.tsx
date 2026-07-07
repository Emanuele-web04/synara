// FILE: ChatEmptyStateHero.tsx
// Purpose: Render the centered empty-state hero for blank transcripts.
// Layer: Chat presentation
// Depends on: the caller-supplied project display name.

import { memo } from "react";
import { useTranslation } from "react-i18next";
import { SynaraLogo } from "~/components/SynaraLogo";

export const ChatEmptyStateHero = memo(function ChatEmptyStateHero({
  projectName,
}: {
  projectName: string | undefined;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center gap-5 select-none">
      <SynaraLogo aria-label={t("chat.synaraLogo")} className="size-10" />

      <div className="flex flex-col items-center gap-0.5">
        <h1 className="text-2xl font-semibold text-foreground/90">
          {t("chat.emptyState.letsBuild")}
        </h1>
        {projectName && <span className="text-lg text-muted-foreground/40">{projectName}</span>}
      </div>
    </div>
  );
});

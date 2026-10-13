// FILE: ChatEmptyStateHero.tsx
// Purpose: Render the centered empty-state hero for blank transcripts.
// Layer: Chat presentation
// Depends on: the caller-supplied project display name.

import { SynaraLogo } from "~/components/SynaraLogo";
import { useTranslation } from "~/i18n";

export const ChatEmptyStateHero = function ChatEmptyStateHero({
  projectName,
}: {
  projectName: string | undefined;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center gap-5 select-none">
      <SynaraLogo aria-label={t("Synara logo")} className="size-10" />

      <div className="flex flex-col items-center gap-0.5">
        <h1 className="text-2xl font-semibold text-foreground/90">{t("Let's build")}</h1>
        {projectName && <span className="text-lg text-muted-foreground/40">{projectName}</span>}
      </div>
    </div>
  );
};

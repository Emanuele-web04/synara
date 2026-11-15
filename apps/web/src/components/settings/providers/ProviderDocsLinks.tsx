// FILE: ProviderDocsLinks.tsx
// Purpose: Links out of Settings for one agent: its setup guide button, and the CLI docs
//          strip that leads with that guide in an expanded Agents row.
// Layer: Settings UI
// Exports: ProviderSetupGuideButton, ProviderDocsLinks

import { useTranslation } from "~/i18n";
import { ExternalLinkIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { SETTINGS_OUTLINED_SURFACE_CLASS_NAME } from "~/settingsPanelStyles";

import { Button } from "../../ui/button";
import type { ProviderInstallSettings } from "./providerInstallSettings";

/** Opens an agent's setup guide; the link's name says which agent it is for. */
export function ProviderSetupGuideButton(props: {
  title: string;
  href: string;
  size: "sm" | "xs";
}) {
  const { t } = useTranslation();

  return (
    <Button
      variant="outline"
      size={props.size}
      render={<a href={props.href} target="_blank" rel="noreferrer" />}
      aria-label={t("settings:setupGuide2", { value0: props.title })}
    >
      <span>{t("settings:setupGuide")}</span>
      <ExternalLinkIcon className="size-3" />
    </Button>
  );
}

export function ProviderDocsLinks({
  docs,
  setupGuide,
}: {
  docs: ProviderInstallSettings["docs"];
  /** The provider's setup guide, shown first beside the CLI docs. */
  setupGuide?: { readonly title: string; readonly href: string };
}) {
  const { t } = useTranslation();

  return (
    <div className={cn(SETTINGS_OUTLINED_SURFACE_CLASS_NAME, "px-3 py-2.5")}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-ui leading-snug font-medium text-foreground">
          {t("settings:providers_cliDocs")}
        </span>
        <div className="flex flex-wrap gap-2">
          {setupGuide ? (
            <ProviderSetupGuideButton title={setupGuide.title} href={setupGuide.href} size="sm" />
          ) : null}
          {docs.map((doc) => (
            <Button
              key={`${doc.label}:${doc.href}`}
              variant="outline"
              size="sm"
              render={<a href={doc.href} target="_blank" rel="noreferrer" />}
            >
              <span>{t(doc.label)}</span>
              <ExternalLinkIcon className="size-3" />
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

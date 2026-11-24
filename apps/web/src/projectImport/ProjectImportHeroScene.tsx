// FILE: ProjectImportHeroScene.tsx
// Purpose: The import announcement's hero scene: Claude Code and Codex projects travelling
//          into Synara's project list. Decorative (the band is aria-hidden).
// Layer: Web project-import UI
// Exports: ProjectImportHeroScene

import { DIALOG_HERO_ITEM_SHADOW_CLASS_NAME, DialogHeroLink } from "~/components/DialogHeroBand";
import { ProviderIcon } from "~/components/ProviderIcon";
import { CheckIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { VISIBLE_PROVIDER_DESCRIPTORS } from "../betaFeatures";

const SOURCES = ["claudeAgent", "codex"] as const;

/** Sample folder names shown inside the illustration: data, not copy, so untranslated. */
const SAMPLE_PROJECTS = ["synara-web", "api-gateway", "ios-app"] as const;

const CARD_CLASS_NAME = cn(
  "rounded-xl border border-border bg-popover",
  DIALOG_HERO_ITEM_SHADOW_CLASS_NAME,
);

function providerName(kind: (typeof SOURCES)[number]): string {
  return (
    VISIBLE_PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.kind === kind)?.displayName ?? kind
  );
}

export function ProjectImportHeroScene() {
  return (
    <div className="flex items-center gap-2">
      <div className="flex flex-col gap-2">
        {SOURCES.map((source, index) => (
          <span
            key={source}
            className={cn(
              "scene-float flex items-center gap-2 px-2.5 py-1.5 text-ui-xs font-medium text-foreground",
              CARD_CLASS_NAME,
            )}
            style={{ animationDelay: `${index * -2.5}s` }}
          >
            <ProviderIcon provider={source} className="size-4 shrink-0" />
            {providerName(source)}
          </span>
        ))}
      </div>
      <DialogHeroLink delayMs={400} />
      <div className={cn("flex w-40 flex-col gap-0.5 p-1.5", CARD_CLASS_NAME)}>
        {SAMPLE_PROJECTS.map((project, index) => (
          <span
            key={project}
            className={cn(
              "scene-rise flex items-center gap-2 rounded-md px-1.5 py-1 text-ui-timestamp",
              index === 0
                ? "bg-sky-500/10 font-medium text-foreground dark:bg-sky-400/12"
                : "text-muted-foreground",
            )}
            style={{ animationDelay: `${250 + index * 120}ms` }}
          >
            <span
              className={cn(
                "size-3 shrink-0 rounded-[3px]",
                index === 0 ? "bg-sky-500 dark:bg-sky-400" : "bg-foreground/15",
              )}
            />
            <span className="min-w-0 truncate">{project}</span>
            {index === 0 ? (
              <CheckIcon className="ms-auto size-3 shrink-0 text-sky-500 dark:text-sky-400" />
            ) : null}
          </span>
        ))}
      </div>
    </div>
  );
}

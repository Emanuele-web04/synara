// FILE: ProjectImportLandingBanner.tsx
// Purpose: Dismissible empty-landing promo that opens the Codex/Claude Code project import dialog.
// Layer: Web project-import UI
// Exports: ProjectImportLandingBanner

import { Schema } from "effect";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ProjectImportGlyph } from "./ProjectImportGlyph";
import { useProjectImportDialogStore } from "./projectImportDialogStore";

const DISMISSED_STORAGE_KEY = "synara:project-import-landing-banner:dismissed:v1";

export function ProjectImportLandingBanner(props: { className?: string }) {
  const [dismissed, setDismissed] = useLocalStorage(DISMISSED_STORAGE_KEY, false, Schema.Boolean);
  if (dismissed) return null;
  return (
    <div className={cn("group/import-banner relative", props.className)}>
      <button
        type="button"
        data-testid="project-import-landing-banner"
        className="flex w-full cursor-pointer items-center gap-4 rounded-2xl px-4 py-3 text-left transition-colors duration-150 ease-out hover:bg-foreground/[0.04] focus-visible:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none"
        onClick={() => useProjectImportDialogStore.getState().openDialog()}
      >
        <ProjectImportGlyph />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-[length:var(--app-font-size-ui,12px)] font-medium text-foreground">
            Import your Claude Code and Codex projects
          </span>
          <span className="truncate text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">
            Bring your chats and continue them in Synara
          </span>
        </span>
      </button>
      <button
        type="button"
        aria-label="Dismiss project import banner"
        className="absolute -right-1.5 -top-1.5 flex size-[22px] items-center justify-center rounded-full border border-border/70 bg-background text-muted-foreground opacity-0 shadow-xs transition-opacity duration-150 ease-out hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 group-hover/import-banner:opacity-100 motion-reduce:transition-none"
        onClick={() => setDismissed(true)}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}

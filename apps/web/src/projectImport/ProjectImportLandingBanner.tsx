// FILE: ProjectImportLandingBanner.tsx
// Purpose: Dismissible empty-landing promo that opens the Codex/Claude Code project import dialog.
// Layer: Web project-import UI
// Exports: ProjectImportLandingBanner

import { Schema } from "effect";
import type { ReactNode } from "react";

import { ProviderIcon } from "~/components/ProviderIcon";
import { SynaraLogo } from "~/components/SynaraLogo";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useProjectImportDialogStore } from "./projectImportDialogStore";

const DISMISSED_STORAGE_KEY = "synara:project-import-landing-banner:dismissed:v1";

// Tile chrome: a 1px border that is brightest on the edge facing the connector dots and
// fades out across the tile, drawn as a gradient ring around an opaque fill.
function IconTile(props: {
  children: ReactNode;
  // Edge that carries the highlight; the ring fades toward the opposite edge.
  glow: "left" | "right";
  glowColor: string;
  className?: string;
}) {
  return (
    <span
      className={cn("flex size-10 shrink-0 rounded-[12px] p-px shadow-sm", props.className)}
      style={{
        backgroundImage: `linear-gradient(to ${props.glow === "right" ? "left" : "right"}, ${props.glowColor}, color-mix(in srgb, var(--foreground) 7%, transparent) 75%)`,
      }}
    >
      <span className="flex size-full items-center justify-center rounded-[11px] bg-[color-mix(in_srgb,var(--background)_94%,var(--foreground))]">
        {props.children}
      </span>
    </span>
  );
}

const CLAUDE_GLOW = "color-mix(in srgb, #d97757 60%, transparent)";
const NEUTRAL_GLOW = "color-mix(in srgb, var(--foreground) 38%, transparent)";

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
        <span className="flex shrink-0 items-center gap-2" aria-hidden="true">
          <span className="flex items-center">
            <IconTile glow="right" glowColor={CLAUDE_GLOW} className="relative z-10 -rotate-6">
              <ProviderIcon provider="claudeAgent" className="size-5" />
            </IconTile>
            <IconTile glow="right" glowColor={NEUTRAL_GLOW} className="-ml-2.5 rotate-3">
              <ProviderIcon provider="codex" className="size-5" />
            </IconTile>
          </span>
          <span className="flex items-center gap-[3px]">
            <span className="size-[3px] rounded-full bg-[#d97757]/45" />
            <span className="size-[3px] rounded-full bg-[#d97757]/70" />
            <span className="size-[3px] rounded-full bg-[#d97757]" />
          </span>
          <IconTile glow="left" glowColor={NEUTRAL_GLOW} className="rotate-6">
            <SynaraLogo className="size-5" />
          </IconTile>
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm font-medium text-foreground">
            Import your Claude Code and Codex projects
          </span>
          <span className="truncate text-sm text-muted-foreground">
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

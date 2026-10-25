// FILE: ProjectImportGlyph.tsx
// Purpose: Claude Code + Codex → Synara tile illustration shared by the project import promos.
// Layer: Web project-import UI
// Exports: ProjectImportGlyph

import { APP_ICON_TILE_SIZE_CLASSES, AppIconTile, ConnectorDots } from "~/components/AppIconTile";
import { ProviderIcon } from "~/components/ProviderIcon";
import { SynaraLogo } from "@synara/profile-ui/logo";
import { cn } from "~/lib/utils";

type GlyphSize = "md" | "lg";

const CLAUDE_GLOW = "color-mix(in srgb, #d97757 60%, transparent)";
const NEUTRAL_GLOW = "color-mix(in srgb, var(--foreground) 38%, transparent)";

export function ProjectImportGlyph(props: { size?: GlyphSize; className?: string }) {
  const size = props.size ?? "md";
  const classes = APP_ICON_TILE_SIZE_CLASSES[size];
  return (
    <span
      className={cn("flex shrink-0 items-center", classes.gap, props.className)}
      aria-hidden="true"
    >
      <span className="flex items-center">
        <AppIconTile
          size={size}
          glow="right"
          glowColor={CLAUDE_GLOW}
          className="relative z-10 -rotate-6"
        >
          <ProviderIcon provider="claudeAgent" className={classes.icon} />
        </AppIconTile>
        <AppIconTile
          size={size}
          glow="right"
          glowColor={NEUTRAL_GLOW}
          className={cn("rotate-3", classes.overlap)}
        >
          <ProviderIcon provider="codex" className={classes.icon} />
        </AppIconTile>
      </span>
      <ConnectorDots
        size={size}
        dotClassNames={["bg-[#d97757]/45", "bg-[#d97757]/70", "bg-[#d97757]"]}
      />
      <AppIconTile size={size} glow="left" glowColor={NEUTRAL_GLOW} className="rotate-6">
        <SynaraLogo className={classes.icon} />
      </AppIconTile>
    </span>
  );
}

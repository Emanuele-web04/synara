// FILE: ChatEmptyStateHero.tsx
// Purpose: Render the shared hero for chat landings and blank transcripts.
// Layer: Chat presentation
// Depends on: caller-supplied heading, description, and optional composer prefill action.

import type { ReactNode } from "react";
import { SynaraLogo } from "~/components/SynaraLogo";
import { Button } from "~/components/ui/button";
import { Kbd } from "~/components/ui/kbd";
import { cn } from "~/lib/utils";

export const ChatEmptyStateHero = function ChatEmptyStateHero({
  heading,
  description,
  className,
  onSelectPrompt,
}: {
  heading: ReactNode;
  description?: ReactNode;
  className?: string;
  onSelectPrompt?: (prompt: string) => void;
}) {
  return (
    <div className={cn("flex flex-col items-center gap-4 text-center select-none", className)}>
      <SynaraLogo aria-label="Synara logo" className="size-10" />

      <div className="flex flex-col items-center gap-0.5">
        {heading}
        {description && <span className="text-ui-lg text-muted-foreground/40">{description}</span>}
      </div>
      <p className="flex flex-wrap items-center justify-center gap-x-1 gap-y-1 text-ui-sm text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Kbd className="text-ui-sm">@</Kbd> to tag files
        </span>
        <span aria-hidden="true">·</span>
        <span className="inline-flex items-center gap-1">
          <Kbd className="text-ui-sm">/</Kbd> for commands
        </span>
      </p>
      {onSelectPrompt && (
        <div className="flex flex-wrap justify-center gap-2">
          <Button
            variant="outline"
            size="xs"
            shape="capsule"
            onClick={() => onSelectPrompt("Help me plan a new feature.")}
          >
            Plan a feature
          </Button>
          <Button
            variant="outline"
            size="xs"
            shape="capsule"
            onClick={() => onSelectPrompt("Help me investigate and fix a bug.")}
          >
            Fix a bug
          </Button>
        </div>
      )}
    </div>
  );
};

// FILE: TerminalIdentityIcon.tsx
// Purpose: Renders a terminal/provider icon without extra activity chrome.
// Layer: Terminal presentation primitive
// Depends on: shared terminal icon keys plus local provider/icon components.

import type { TerminalIconKey } from "@t3tools/shared/terminalThreads";

import { TerminalSquare } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { ClaudeAI, OpenAI } from "../Icons";

interface TerminalIdentityIconProps {
  iconKey: TerminalIconKey;
  className?: string;
}

// Keep provider branding reusable across every terminal surface.
export default function TerminalIdentityIcon({ iconKey, className }: TerminalIdentityIconProps) {
  const IconComponent =
    iconKey === "openai" ? OpenAI : iconKey === "claude" ? ClaudeAI : TerminalSquare;

  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center", className)}>
      <IconComponent
        className={cn(
          "size-full",
          iconKey === "claude"
            ? "text-[#d97757]"
            : iconKey === "openai"
              ? "text-foreground/80"
              : "",
        )}
      />
    </span>
  );
}

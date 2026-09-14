// FILE: ComputerControlDeniedCard.tsx
// Purpose: Transcript card shown when an agent's desktop tool call was rejected because
//          the chat has computer control switched off. Replaces the buried tool error
//          with a one-click way to switch control on and retry.
// Layer: Chat transcript UI

import { Button } from "~/components/ui/button";
import { MonitorIcon } from "~/lib/icons";

export function ComputerControlDeniedCard({
  computerControlEnabled,
  textFontSizePx,
  metaFontSizePx,
  onEnable,
}: {
  // Live composer state: once the user (or this card) switches control on, the
  // card flips to a confirmation instead of offering a dead button.
  readonly computerControlEnabled?: boolean;
  readonly textFontSizePx?: number;
  readonly metaFontSizePx?: number;
  readonly onEnable?: () => void;
}) {
  const enabled = computerControlEnabled === true;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-primary)] px-3 py-2.5">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-secondary)] text-amber-500">
        <MonitorIcon className="size-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p
          className="truncate font-medium text-[var(--color-text-foreground)]"
          style={textFontSizePx ? { fontSize: `${textFontSizePx}px` } : undefined}
        >
          {enabled
            ? "Computer control is on for this chat"
            : "Computer control is off. Turn it on in Settings to let the agent use the desktop."}
        </p>
        {enabled ? (
          <p
            className="text-[var(--color-text-foreground-secondary)]"
            style={metaFontSizePx ? { fontSize: `${metaFontSizePx}px` } : undefined}
          >
            Queued desktop turns stay cancelled — send a fresh message to continue.
          </p>
        ) : null}
      </div>
      {onEnable && !enabled ? (
        <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={onEnable}>
          Enable
        </Button>
      ) : null}
    </div>
  );
}

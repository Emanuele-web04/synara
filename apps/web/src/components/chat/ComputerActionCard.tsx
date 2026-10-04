// FILE: ComputerActionCard.tsx
// Purpose: Shared transcript card shell for Computer control notices (setup required,
//          control denied): status tile, title, description, and one action button.
// Layer: Chat transcript UI

import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { MonitorIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

export function ComputerActionCard({
  tone,
  title,
  textFontSizePx,
  metaFontSizePx,
  action,
  children,
}: {
  readonly tone: "warning" | "success" | "error";
  readonly title: string;
  readonly textFontSizePx?: number | undefined;
  readonly metaFontSizePx?: number | undefined;
  readonly action?:
    | { readonly label: string; readonly disabled?: boolean; readonly onClick: () => void }
    | undefined;
  /** Description paragraphs; each inherits the card's secondary text style. */
  readonly children?: ReactNode;
}) {
  const metaStyle = metaFontSizePx ? { fontSize: `${metaFontSizePx}px` } : undefined;
  return (
    <div className="flex items-start gap-3 rounded-xl border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-primary)] p-3">
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg",
          tone === "success"
            ? "bg-success/8 text-success dark:bg-success/16"
            : tone === "error"
              ? "bg-destructive/8 text-destructive dark:bg-destructive/16"
              : "bg-warning/8 text-warning dark:bg-warning/16",
        )}
      >
        <MonitorIcon className="size-4.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p
          className="font-medium text-[var(--color-text-foreground)]"
          style={textFontSizePx ? { fontSize: `${textFontSizePx}px` } : undefined}
        >
          {title}
        </p>
        <div
          className="space-y-1 leading-relaxed text-[var(--color-text-foreground-secondary)]"
          style={metaStyle}
        >
          {children}
        </div>
      </div>
      {action ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 self-center"
          // Match the card's transcript-scaled copy instead of the UI scale, so
          // the label does not read as a different typeface beside it.
          style={metaStyle}
          disabled={action.disabled}
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

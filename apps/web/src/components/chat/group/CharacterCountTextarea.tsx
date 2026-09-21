import type { ComponentProps } from "react";

import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";

import { formatCharacterCount } from "./groupSettingsDialog.logic";

export function CharacterCountTextarea({
  maxChars,
  helper,
  className,
  ...props
}: ComponentProps<typeof Textarea> & {
  readonly maxChars: number;
  readonly helper?: string;
}) {
  const value = typeof props.value === "string" ? props.value : "";
  const overLimit = value.length > maxChars;
  return (
    <div className="space-y-1">
      <Textarea
        aria-invalid={overLimit || undefined}
        maxLength={maxChars}
        className={cn("w-full", className)}
        {...props}
      />
      <div className="flex items-start justify-between gap-3">
        {helper ? <p className="text-[11px] text-muted-foreground">{helper}</p> : <span />}
        <p
          className={cn(
            "shrink-0 text-[11px] tabular-nums",
            overLimit ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {formatCharacterCount(value, maxChars)}
        </p>
      </div>
    </div>
  );
}

import type { FastModeNotice } from "~/lib/fastModeState";
import { FastModeIcon, FastModeOutlineIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

// The fast-mode bolt every read-only model summary shows. A notice means fast mode
// was requested but is not serving, so the bolt turns into a muted outline that
// carries the reason.
export function FastModeBadgeIcon(props: {
  notice?: FastModeNotice | null | undefined;
  className?: string | undefined;
}) {
  if (props.notice) {
    return (
      <span className="inline-flex shrink-0" title={props.notice.detail}>
        <FastModeOutlineIcon
          aria-label={props.notice.label}
          className={cn(props.className, "text-muted-foreground opacity-70")}
        />
      </span>
    );
  }
  return <FastModeIcon aria-label="Fast mode" className={props.className} />;
}

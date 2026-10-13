// Compact text-only work labels. Disclosure motion belongs to the existing
// Collapsible trigger/panel; the live clock stays isolated in its leaf component.
import type { CSSProperties, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "~/surfaceStyles";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import {
  formatTurnHeaderLabel,
  formatTurnResumedBy,
  type TurnHeader,
  type TurnResumedBy,
} from "./MessagesTimeline.logic";
import { LiveElapsedTimer } from "./LiveElapsedTimer";
import { useTranslation } from "~/i18n";

export function TurnHeaderLine(
  props: {
    fontSize: CSSProperties["fontSize"];
  } & (
    | {
        kind: "settled";
        header: TurnHeader;
        disclosure?: {
          open: boolean;
          renderTrigger: (content: ReactNode) => ReactNode;
        };
      }
    | {
        kind: "live";
        startedAt: string;
        nowLabel?: string | null;
        resumedBy?: ReadonlyArray<TurnResumedBy> | null;
      }
  ),
) {
  const { t } = useTranslation();

  if (props.kind === "live") {
    const resumedBy = props.resumedBy && props.resumedBy.length > 0 ? props.resumedBy : null;
    return (
      <div data-turn-header="live">
        <div
          className={cn("-ml-0.5 pb-2", MUTED_LABEL_TEXT_CLASS_NAME)}
          style={{ fontSize: props.fontSize }}
        >
          {resumedBy
            ? t("Resumed: {{value0}} · ", { value0: formatTurnResumedBy(resumedBy) })
            : t("Working for ")}
          <span className="tabular-nums">
            {props.nowLabel ?? <LiveElapsedTimer startedAt={props.startedAt} />}
          </span>
        </div>
        <div aria-hidden className="h-px w-full bg-border" />
      </div>
    );
  }

  const { header, disclosure } = props;
  const content = (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span>{formatTurnHeaderLabel(header)}</span>
      {disclosure ? (
        <DisclosureChevron open={disclosure.open} className="text-muted-foreground/70" />
      ) : null}
    </span>
  );
  return (
    <div
      className={cn("-ml-0.5 pb-2", MUTED_LABEL_TEXT_CLASS_NAME)}
      style={{ fontSize: props.fontSize }}
      data-turn-header={header.outcome}
    >
      {disclosure ? disclosure.renderTrigger(content) : content}
    </div>
  );
}

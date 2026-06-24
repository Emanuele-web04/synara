import type { ReviewFinding } from "@t3tools/contracts";
import type { CSSProperties, ReactElement } from "react";

import { MessageCircleIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ReviewPill, severityPill } from "../reviewPrimitives";

export function JudgmentCallout(props: { question: string }): ReactElement {
  return (
    <div className="rounded-[0.625rem] border border-border/70 bg-card px-3.5 py-3">
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          aria-hidden="true"
          className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-info/12 text-info-foreground"
        >
          <MessageCircleIcon className="size-3.5" />
        </span>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-foreground">Judgment call</div>
          <p className="mt-1 text-pretty text-[13px] leading-5 text-foreground">{props.question}</p>
        </div>
      </div>
    </div>
  );
}

export function ChapterFindingCard(props: {
  finding: ReviewFinding;
  className?: string;
  style?: CSSProperties;
}): ReactElement {
  const { finding } = props;
  const severity = severityPill(finding.severity);
  return (
    <article
      style={props.style}
      className={cn(
        "overflow-hidden rounded-[0.625rem] border border-border/70 bg-card px-3.5 py-3 transition-[border-color,transform] duration-150 ease-out hover:-translate-y-px hover:border-border motion-reduce:transition-none motion-reduce:hover:translate-y-0",
        props.className,
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <ReviewPill tone={severity.tone}>{severity.label}</ReviewPill>
        <span className="flex w-full min-w-0">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {finding.path}
          </span>
          {Number.isFinite(finding.line) ? (
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
              :{finding.line}
            </span>
          ) : null}
        </span>
      </div>
      {finding.title ? (
        <h4 className="mt-2 break-words text-[13px] font-semibold leading-5 text-foreground">
          {finding.title}
        </h4>
      ) : null}
      {finding.message ? (
        <p className="mt-1 break-words text-[12px] leading-5 text-foreground">{finding.message}</p>
      ) : null}
    </article>
  );
}

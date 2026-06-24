import type { ReviewCheck } from "@t3tools/contracts";

import { CircleCheckIcon } from "~/lib/icons";
import { CheckStateIcon, checkStateLabel } from "./reviewPrPrimitives";
import { EmptyState } from "./reviewPrimitives";

export function ReviewChecks(props: { checks: ReadonlyArray<ReviewCheck> }) {
  if (props.checks.length === 0) {
    return (
      <EmptyState icon={<CircleCheckIcon />} title="No checks">
        No CI checks reported for this pull request.
      </EmptyState>
    );
  }

  return (
    <ul className="my-4 flex w-full flex-col divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/70 bg-card/88 shadow-sm">
      {props.checks.map((check, index) => (
        <li
          key={`${check.name}:${index}`}
          className="flex min-w-0 items-center gap-2 px-4 py-2.5 text-[13px]"
        >
          <CheckStateIcon state={check.state} />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="min-w-0 truncate text-foreground" title={check.name}>
              {check.name}
            </span>
            {check.workflow ? (
              <span className="truncate text-[11px] text-muted-foreground">{check.workflow}</span>
            ) : null}
          </div>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {checkStateLabel(check.state)}
          </span>
          {check.url ? (
            <a
              href={check.url}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 rounded-full px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Details
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

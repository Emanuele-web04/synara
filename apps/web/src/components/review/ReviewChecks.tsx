import type { ReviewCheck } from "@t3tools/contracts";

import { CircleCheckIcon } from "~/lib/icons";
import { CheckRow } from "./ReviewPrSidebarChecksPanel";
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
    <ul className="my-4 flex w-full flex-col gap-1 overflow-hidden rounded-lg border border-border/40 bg-card p-1">
      {props.checks.map((check, index) => (
        <li key={`${check.name}:${index}`} className="min-w-0">
          <CheckRow check={check} variant="card" />
        </li>
      ))}
    </ul>
  );
}

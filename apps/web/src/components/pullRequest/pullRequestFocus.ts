import type { PullRequestDetailInput } from "@synara/contracts";

/** Whether a dock-triggered close should return keyboard focus to the selected list row. */
export function isFocusInsideRightDock(activeElement: Element | null): boolean {
  return activeElement?.closest("[data-right-dock-content]") != null;
}

/** Find the row without embedding repository/project identities in a CSS selector. */
export function focusPullRequestRow(
  root: ParentNode,
  input: Pick<PullRequestDetailInput, "projectId" | "repository" | "number">,
): boolean {
  const repository = input.repository.toLowerCase();
  const row = Array.from(
    root.querySelectorAll<HTMLButtonElement>("button[data-pull-request-row]"),
  ).find(
    (candidate) =>
      candidate.dataset.projectId === input.projectId &&
      candidate.dataset.repository?.toLowerCase() === repository &&
      candidate.dataset.pullRequestNumber === String(input.number),
  );
  if (!row) return false;
  row.focus({ preventScroll: true });
  return true;
}

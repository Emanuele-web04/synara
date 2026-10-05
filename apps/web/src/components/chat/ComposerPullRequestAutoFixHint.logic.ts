// FILE: composerPullRequestAutoFixHint.ts
// Purpose: Visibility rule and copy for the composer tip that offers Auto-fix CI
//   on the chat's open pull request.
// Layer: Chat composer state helpers
// Exports: shouldShowPullRequestAutoFixHint + hint constants

import type { PullRequestAutoFixState } from "@synara/contracts";

export const PULL_REQUEST_AUTO_FIX_HINT_MESSAGE = "Want to turn on auto-fix for this PR?";
export const PULL_REQUEST_AUTO_FIX_HINT_ACTION_LABEL = "Turn on";

export interface PullRequestAutoFixHintInput {
  readonly featureOn: boolean;
  /** Only a chat the server knows can be watched; an unsent draft cannot. */
  readonly isServerThread: boolean;
  /** The PR git status reports for the chat's checked-out branch. */
  readonly pullRequestState: "open" | "closed" | "merged" | null;
  /** `dismissedPullRequestAutoFixHint`: set by the X and by turning Auto-fix CI on. */
  readonly dismissed: boolean;
  readonly isWorking: boolean;
  /** `undefined` while the state is loading; `null` while auto-fix is off. */
  readonly autoFixState: PullRequestAutoFixState | null | undefined;
}

/** Shows once per user, only beside an open PR, while the chat is idle and auto-fix is off. */
export function shouldShowPullRequestAutoFixHint(input: PullRequestAutoFixHintInput): boolean {
  return (
    input.featureOn &&
    input.isServerThread &&
    input.pullRequestState === "open" &&
    !input.dismissed &&
    !input.isWorking &&
    input.autoFixState === null
  );
}

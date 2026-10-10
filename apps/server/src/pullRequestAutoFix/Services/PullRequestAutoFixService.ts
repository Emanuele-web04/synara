import type {
  PullRequestAutoFixGetInput,
  PullRequestAutoFixListResult,
  PullRequestAutoFixResult,
  PullRequestAutoFixSetInput,
} from "@synara/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

export class PullRequestAutoFixError extends Schema.TaggedErrorClass<PullRequestAutoFixError>()(
  "PullRequestAutoFixError",
  { message: Schema.String },
) {}

/**
 * Auto-fix CI (Stable and Beta): the per-PR switches behind the Environment panel's pull request
 * rows. The live layer also runs the watcher that polls each watched PR's checks and starts a
 * fix turn in the chat when one fails.
 */
export interface PullRequestAutoFixServiceShape {
  readonly get: (
    input: PullRequestAutoFixGetInput,
  ) => Effect.Effect<PullRequestAutoFixListResult, PullRequestAutoFixError>;
  readonly set: (
    input: PullRequestAutoFixSetInput,
  ) => Effect.Effect<PullRequestAutoFixResult, PullRequestAutoFixError>;
}

export class PullRequestAutoFixService extends ServiceMap.Service<
  PullRequestAutoFixService,
  PullRequestAutoFixServiceShape
>()("synara/pullRequestAutoFix/Services/PullRequestAutoFixService/PullRequestAutoFixService") {}

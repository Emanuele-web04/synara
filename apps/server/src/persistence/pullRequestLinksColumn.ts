// FILE: pullRequestLinksColumn.ts
// Purpose: SQLite column codec for `projection_threads.pull_requests_json`.
// Layer: Server persistence
// Exports: PullRequestLinksJsonColumn, resolveStoredPullRequestLinks

import {
  OrchestrationThreadPullRequestLink,
  type OrchestrationThreadPullRequest,
} from "@synara/contracts";
import { legacyPullRequestLinks } from "@synara/shared/threadPullRequestLinks";
import { Option, Schema } from "effect";
import * as SchemaGetter from "effect/SchemaGetter";

const decodePullRequestLink = Schema.decodeUnknownOption(OrchestrationThreadPullRequestLink);

// A value this build cannot fully decode (hand-edited database, a link shape from a newer build)
// must neither fail the whole thread row, which would hide the thread from every snapshot, nor be
// partially decoded: a partial list would be written back on the thread's next update and erase
// the entries this build did not understand. It decodes as `null`, so readers fall back to the
// legacy `lastKnownPr` slot and whole-row upserts keep the stored JSON untouched.
function parseStoredPullRequestLinks(value: string): OrchestrationThreadPullRequestLink[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const links: OrchestrationThreadPullRequestLink[] = [];
  for (const entry of parsed) {
    const decoded = decodePullRequestLink(entry);
    if (Option.isNone(decoded)) return null;
    links.push(decoded.value);
  }
  return links;
}

export const PullRequestLinksJsonColumn = Schema.NullOr(Schema.String).pipe(
  Schema.decodeTo(Schema.NullOr(Schema.Array(OrchestrationThreadPullRequestLink)), {
    decode: SchemaGetter.transform((value) =>
      value === null ? null : parseStoredPullRequestLinks(value),
    ),
    encode: SchemaGetter.transform((links) => (links === null ? null : JSON.stringify(links))),
  }),
);

/**
 * Links for a stored thread row. Rows the backfill never reached (or whose column could not be
 * parsed) fall back to the legacy single `lastKnownPr` slot, so readers never lose that PR.
 */
export function resolveStoredPullRequestLinks(row: {
  readonly pullRequests?: ReadonlyArray<OrchestrationThreadPullRequestLink> | null | undefined;
  readonly lastKnownPr: OrchestrationThreadPullRequest | null;
  readonly updatedAt: string;
}): OrchestrationThreadPullRequestLink[] {
  return row.pullRequests != null
    ? [...row.pullRequests]
    : legacyPullRequestLinks(row.lastKnownPr, row.updatedAt);
}

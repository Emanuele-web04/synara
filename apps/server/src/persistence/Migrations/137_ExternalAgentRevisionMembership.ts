import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS external_agent_profile_revision_memberships (
    profile_id TEXT NOT NULL REFERENCES external_agent_profiles(profile_id),
    revision_id TEXT NOT NULL REFERENCES external_agent_profile_revisions(revision_id),
    PRIMARY KEY (profile_id, revision_id)
  )`;
  // Legacy content-addressed revisions can share parent links across profiles.
  // Only the current pointer proves ownership; never grant another profile's
  // credentials to an ambiguous historical revision during backfill.
  yield* sql`INSERT OR IGNORE INTO external_agent_profile_revision_memberships
    SELECT profiles.profile_id, profiles.current_revision_id FROM external_agent_profiles profiles
    JOIN external_agent_profile_revisions revisions ON revisions.revision_id = profiles.current_revision_id`;
});

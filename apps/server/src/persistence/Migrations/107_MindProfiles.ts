import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS mind_profiles (
    project_id TEXT PRIMARY KEY REFERENCES projection_projects(project_id) ON DELETE CASCADE,
    text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
    opted_in INTEGER NOT NULL DEFAULT 0 CHECK (opted_in IN (0, 1)),
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS mind_profile_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_mind_profile_revisions_project ON mind_profile_revisions(project_id)`;
});

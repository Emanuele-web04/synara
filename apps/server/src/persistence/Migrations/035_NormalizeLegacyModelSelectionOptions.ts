// FILE: 035_NormalizeLegacyModelSelectionOptions.ts
// Purpose: Repairs persisted modelSelection JSON whose legacy options are stored as option rows.
// Layer: Persistence migration

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { normalizePersistedModelSelection } from "../modelSelectionCompatibility.ts";

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeModelSelection(input: unknown): {
  readonly changed: boolean;
  readonly value: unknown;
} {
  const value = normalizePersistedModelSelection(input);
  return { changed: JSON.stringify(value) !== JSON.stringify(input), value };
}

function normalizeModelSelectionJson(json: string | null): {
  readonly changed: boolean;
  readonly value: string | null;
} {
  if (json === null) {
    return { changed: false, value: json };
  }

  const parsed = JSON.parse(json) as unknown;
  const normalized = normalizeModelSelection(parsed);
  return {
    changed: normalized.changed,
    value: normalized.changed ? JSON.stringify(normalized.value) : json,
  };
}

function normalizeEventPayloadJson(json: string): {
  readonly changed: boolean;
  readonly value: string;
} {
  const payload = JSON.parse(json) as unknown;
  if (!isRecord(payload)) {
    return { changed: false, value: json };
  }

  let nextPayload: JsonObject | undefined;
  const mutablePayload = () => {
    nextPayload ??= { ...payload };
    return nextPayload;
  };

  const defaultModelSelection = normalizeModelSelection(payload.defaultModelSelection);
  if (defaultModelSelection.changed) {
    mutablePayload().defaultModelSelection = defaultModelSelection.value;
  }

  const modelSelection = normalizeModelSelection(payload.modelSelection);
  if (modelSelection.changed) {
    mutablePayload().modelSelection = modelSelection.value;
  }

  return nextPayload === undefined
    ? { changed: false, value: json }
    : { changed: true, value: JSON.stringify(nextPayload) };
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const projectRows = yield* sql<{
    readonly projectId: string;
    readonly defaultModelSelection: string | null;
  }>`
    SELECT
      project_id AS "projectId",
      default_model_selection_json AS "defaultModelSelection"
    FROM projection_projects
    WHERE default_model_selection_json IS NOT NULL
  `;

  for (const row of projectRows) {
    const normalized = normalizeModelSelectionJson(row.defaultModelSelection);
    if (!normalized.changed) {
      continue;
    }
    yield* sql`
      UPDATE projection_projects
      SET default_model_selection_json = ${normalized.value}
      WHERE project_id = ${row.projectId}
    `;
  }

  const threadRows = yield* sql<{
    readonly threadId: string;
    readonly modelSelection: string;
  }>`
    SELECT
      thread_id AS "threadId",
      model_selection_json AS "modelSelection"
    FROM projection_threads
  `;

  for (const row of threadRows) {
    const normalized = normalizeModelSelectionJson(row.modelSelection);
    if (!normalized.changed) {
      continue;
    }
    yield* sql`
      UPDATE projection_threads
      SET model_selection_json = ${normalized.value}
      WHERE thread_id = ${row.threadId}
    `;
  }

  const eventRows = yield* sql<{
    readonly sequence: number;
    readonly payloadJson: string;
  }>`
    SELECT
      sequence,
      payload_json AS "payloadJson"
    FROM orchestration_events
  `;

  for (const row of eventRows) {
    const normalized = normalizeEventPayloadJson(row.payloadJson);
    if (!normalized.changed) {
      continue;
    }
    yield* sql`
      UPDATE orchestration_events
      SET payload_json = ${normalized.value}
      WHERE sequence = ${row.sequence}
    `;
  }
});

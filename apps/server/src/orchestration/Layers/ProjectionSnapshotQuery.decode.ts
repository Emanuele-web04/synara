// Purpose: Pure decode helpers for projection snapshot DB rows. Each returns an
// Effect but depends only on Schema and the persistence error mappers — no
// SqlClient, Ref, or service context.
// Exports: per-row/option model-selection decoders and the combined
// sql-or-decode error mapper used by the snapshot query factory.
import { Effect, Option, Schema } from "effect";

import {
  type ProjectionRepositoryError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
} from "../../persistence/Errors.ts";
import { normalizePersistedModelSelection } from "../../persistence/modelSelectionCompatibility.ts";
import {
  decodeModelSelection,
  type ProjectionProjectDbRow,
  type ProjectionProjectDbRowRaw,
  type ProjectionThreadDbRow,
  type ProjectionThreadDbRowRaw,
} from "./ProjectionSnapshotQuery.schemas.ts";

export function decodeProjectionProjectRow(
  row: ProjectionProjectDbRowRaw,
): Effect.Effect<ProjectionProjectDbRow, Schema.SchemaError> {
  if (row.defaultModelSelection === null) {
    return Effect.succeed({ ...row, defaultModelSelection: null });
  }
  return decodeModelSelection(normalizePersistedModelSelection(row.defaultModelSelection)).pipe(
    Effect.map((defaultModelSelection) => ({ ...row, defaultModelSelection })),
  );
}

export function decodeProjectionThreadRow(
  row: ProjectionThreadDbRowRaw,
): Effect.Effect<ProjectionThreadDbRow, Schema.SchemaError> {
  return decodeModelSelection(normalizePersistedModelSelection(row.modelSelection)).pipe(
    Effect.map((modelSelection) => ({ ...row, modelSelection })),
  );
}

export function decodeProjectionProjectRows(
  rows: ReadonlyArray<ProjectionProjectDbRowRaw>,
  operation: string,
): Effect.Effect<ReadonlyArray<ProjectionProjectDbRow>, ProjectionRepositoryError> {
  return Effect.forEach(rows, decodeProjectionProjectRow).pipe(
    Effect.mapError(toPersistenceDecodeError(operation)),
  );
}

export function decodeProjectionThreadRows(
  rows: ReadonlyArray<ProjectionThreadDbRowRaw>,
  operation: string,
): Effect.Effect<ReadonlyArray<ProjectionThreadDbRow>, ProjectionRepositoryError> {
  return Effect.forEach(rows, decodeProjectionThreadRow).pipe(
    Effect.mapError(toPersistenceDecodeError(operation)),
  );
}

export function decodeProjectionProjectOption(
  option: Option.Option<ProjectionProjectDbRowRaw>,
  operation: string,
): Effect.Effect<Option.Option<ProjectionProjectDbRow>, ProjectionRepositoryError> {
  if (Option.isNone(option)) {
    return Effect.succeed(Option.none());
  }
  return decodeProjectionProjectRow(option.value).pipe(
    Effect.map(Option.some),
    Effect.mapError(toPersistenceDecodeError(operation)),
  );
}

export function decodeProjectionThreadOption(
  option: Option.Option<ProjectionThreadDbRowRaw>,
  operation: string,
): Effect.Effect<Option.Option<ProjectionThreadDbRow>, ProjectionRepositoryError> {
  if (Option.isNone(option)) {
    return Effect.succeed(Option.none());
  }
  return decodeProjectionThreadRow(option.value).pipe(
    Effect.map(Option.some),
    Effect.mapError(toPersistenceDecodeError(operation)),
  );
}

export function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

import { describe, expect, it } from "vitest";
import { Effect, Result, Schema } from "effect";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  toPersistenceSqlOrDecodeError,
} from "./Errors.ts";

function captureSchemaError(): Schema.SchemaError {
  const result = Effect.runSync(Schema.decodeUnknownEffect(Schema.String)(42).pipe(Effect.result));
  if (Result.isFailure(result) && Schema.isSchemaError(result.failure)) {
    return result.failure;
  }
  throw new Error("Expected schema decoding to fail.");
}

describe("toPersistenceSqlOrDecodeError", () => {
  it("maps schema failures to the decode operation", () => {
    const cause = captureSchemaError();
    const error = toPersistenceSqlOrDecodeError("repository.query", "repository.decode")(cause);

    expect(error).toBeInstanceOf(PersistenceDecodeError);
    expect(error.operation).toBe("repository.decode");
    expect(error.cause).toBe(cause);
  });

  it("maps non-schema failures to the SQL operation", () => {
    const cause = new Error("database unavailable");
    const error = toPersistenceSqlOrDecodeError("repository.query", "repository.decode")(cause);

    expect(error).toBeInstanceOf(PersistenceSqlError);
    expect(error.operation).toBe("repository.query");
    expect(error.cause).toBe(cause);
  });
});

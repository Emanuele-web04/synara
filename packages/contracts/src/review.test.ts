import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { ReviewChangesetResult } from "./review";

const decodeChangeset = Schema.decodeUnknownEffect(ReviewChangesetResult);

it.effect("accepts legacy changeset payloads without patch signatures", () =>
  Effect.gen(function* () {
    const changeset = yield* decodeChangeset({
      target: {
        _tag: "pullRequest",
        repositoryId: "repo",
        number: 42,
      },
      patch: "diff --git a/a.ts b/a.ts\n",
      files: [],
    });

    assert.equal(changeset.patch, "diff --git a/a.ts b/a.ts\n");
    assert.equal(changeset.patchSignature, undefined);
  }),
);

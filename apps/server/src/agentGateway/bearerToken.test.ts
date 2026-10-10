import { assert, describe, it } from "@effect/vitest";

import { extractBearerToken } from "./bearerToken.ts";

describe("agent gateway bearer credentials", () => {
  it("extracts bearer tokens case-insensitively", () => {
    assert.equal(extractBearerToken("Bearer abc"), "abc");
    assert.equal(extractBearerToken("bearer abc"), "abc");
    assert.isNull(extractBearerToken(undefined));
    assert.isNull(extractBearerToken("Basic abc"));
    assert.isNull(extractBearerToken("Bearer "));
  });
});

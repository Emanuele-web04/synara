import { assert, describe, it } from "@effect/vitest";

import { MODEL_SELECTION_INPUT_SCHEMA, readModelSelectionArg } from "./toolInput.ts";

describe("agent gateway target input", () => {
  it("advertises and preserves an explicit provider instance", () => {
    assert.equal(MODEL_SELECTION_INPUT_SCHEMA.properties.instanceId?.type, "string");
    assert.equal(
      readModelSelectionArg(
        {
          target: {
            provider: "codex",
            instanceId: "codex_work",
            model: "gpt-5.5",
          },
        },
        "target",
      )?.instanceId,
      "codex_work",
    );
  });

  it("rejects a blank provider instance", () => {
    assert.throws(() =>
      readModelSelectionArg(
        {
          target: {
            provider: "codex",
            instanceId: " ",
            model: "gpt-5.5",
          },
        },
        "target",
      ),
    );
  });
});

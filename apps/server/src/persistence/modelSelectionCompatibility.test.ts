import { assert, it } from "@effect/vitest";

import { normalizePersistedModelSelection } from "./modelSelectionCompatibility.ts";

it("preserves canonical Pi model selections", () => {
  assert.deepEqual(normalizePersistedModelSelection({ provider: "pi", model: "openai/gpt-5.5" }), {
    provider: "pi",
    model: "openai/gpt-5.5",
  });
});

it("infers Pi from persisted instance labels", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({
      instanceId: "local-pi-runtime-instance",
      model: "openai/gpt-5.5",
    }),
    {
      provider: "pi",
      model: "openai/gpt-5.5",
    },
  );
});

it("preserves canonical Kimi model selections", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({ provider: "kimi", model: "kimi-for-coding" }),
    {
      provider: "kimi",
      model: "kimi-for-coding",
    },
  );
});

it("infers Kimi from persisted instance labels", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({
      instanceId: "local-kimi-runtime-instance",
      model: "kimi-for-coding",
    }),
    {
      provider: "kimi",
      model: "kimi-for-coding",
    },
  );
});

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

it("preserves canonical Hermes model selections", () => {
  assert.deepEqual(normalizePersistedModelSelection({ provider: "hermes", model: "minimax/m2" }), {
    provider: "hermes",
    model: "minimax/m2",
  });
});

it("infers Hermes from persisted instance labels", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({
      instanceId: "local-hermes-runtime",
      model: "minimax/m2",
    }),
    {
      provider: "hermes",
      model: "minimax/m2",
    },
  );
});

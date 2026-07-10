import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@synara/contracts";

import { normalizePersistedModelSelection } from "./modelSelectionCompatibility.ts";

it("preserves canonical Pi model selections", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({ instanceId: "pi", model: "openai/gpt-5.5" }),
    {
      instanceId: "pi",
      model: "openai/gpt-5.5",
    },
  );
});

it("infers Pi from persisted instance labels", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({
      instanceId: "local-pi-runtime-instance",
      model: "openai/gpt-5.5",
    }),
    {
      instanceId: "local-pi-runtime-instance",
      model: "openai/gpt-5.5",
    },
  );
});

it("preserves provider instance ids from providerless persisted selections", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({
      instanceId: "claude_work",
      model: "claude-sonnet-4-6",
    }),
    {
      instanceId: "claude_work",
      model: "claude-sonnet-4-6",
    },
  );
});

it("infers Claude from providerless Sonnet instance selections", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({
      instanceId: "work",
      model: "sonnet-4",
    }),
    {
      instanceId: "work",
      model: "sonnet-4",
    },
  );
});

it("infers OpenCode from providerless OpenCode model selections", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({
      instanceId: "work",
      model: "opencode/minimax-m2.5-free",
    }),
    {
      instanceId: "work",
      model: "opencode/minimax-m2.5-free",
    },
  );
});

it("leaves ambiguous providerless instance selections untouched without settings", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({
      instanceId: "work",
      model: "custom-model",
    }),
    {
      instanceId: "work",
      model: "custom-model",
    },
  );
});

it("resolves ambiguous providerless instance selections from settings", () => {
  assert.deepEqual(
    normalizePersistedModelSelection(
      {
        instanceId: "work",
        model: "custom-model",
      },
      {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          work: {
            driver: "claudeAgent",
            enabled: true,
            config: { homePath: "/tmp/claude-work" },
          },
        },
      },
    ),
    {
      instanceId: "work",
      model: "custom-model",
    },
  );
});

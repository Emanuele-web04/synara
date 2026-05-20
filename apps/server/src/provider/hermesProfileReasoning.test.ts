import { assert, it } from "@effect/vitest";

import {
  hermesReasoningEffortDescriptors,
  normalizeHermesReasoningEffort,
  parseHermesProfileReasoningEffortFromConfig,
} from "./hermesProfileReasoning.ts";

it("parses agent.reasoning_effort from profile config yaml", () => {
  assert.equal(
    parseHermesProfileReasoningEffortFromConfig(`
model:
  default: deepseek-v4-flash
agent:
  reasoning_effort: xhigh
  max_turns: 1000
`),
    "xhigh",
  );
});

it("normalizes supported Hermes reasoning effort values", () => {
  assert.equal(normalizeHermesReasoningEffort("HIGH"), "high");
  assert.equal(normalizeHermesReasoningEffort("invalid"), undefined);
});

it("marks the profile default in reasoning descriptors", () => {
  const descriptors = hermesReasoningEffortDescriptors("high");
  assert.equal(descriptors.find((entry) => entry.value === "high")?.isDefault, true);
  assert.equal(descriptors.find((entry) => entry.value === "medium")?.isDefault, undefined);
});

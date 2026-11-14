import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import type { McpToolCallResult } from "./protocol.ts";
import type { ToolContext } from "./toolRuntime.ts";
import {
  makeAgentGatewayTurnPlanTools,
  parseTurnPlanSteps,
  SYNARA_UPDATE_PLAN_TOOL_NAME,
  TURN_PLAN_MAX_STEPS,
} from "./turnPlanTools.ts";

const [updatePlan] = makeAgentGatewayTurnPlanTools();

const context = {} as ToolContext;
const text = (result: McpToolCallResult) =>
  result.content[0]?.type === "text" ? result.content[0].text : "";

describe("synara_update_plan", () => {
  it("is a Claude-only tool whose schema stays out of tool search", () => {
    assert.equal(updatePlan?.definition.name, SYNARA_UPDATE_PLAN_TOOL_NAME);
    assert.equal(updatePlan?.requiredCapability, "turn:plan");
    assert.equal(updatePlan?.requiresActiveTurn, true);
    assert.equal(updatePlan?.definition._meta?.["anthropic/alwaysLoad"], true);
  });

  it.effect("acknowledges a whole plan and nudges a missing in_progress step", () =>
    Effect.gen(function* () {
      const shown = yield* updatePlan!.handler(
        {
          items: [
            { content: "Find the cause", status: "completed" },
            { content: "Fix it", status: "in_progress" },
          ],
        },
        context,
      );
      assert.equal(shown.isError, undefined);
      assert.equal(text(shown), "Plan shown (2 steps, 1 open).");

      const idle = yield* updatePlan!.handler(
        { items: [{ content: "Fix it", status: "pending" }] },
        context,
      );
      assert.equal(
        text(idle),
        "Plan shown (1 step, 1 open). No step is in_progress; mark the one you are on.",
      );
    }),
  );

  it.effect("refuses a plan it could not show", () =>
    Effect.gen(function* () {
      const refused = yield* updatePlan!.handler(
        { items: [{ content: "Fix it", status: "done" }] },
        context,
      );
      assert.equal(refused.isError, true);
      assert.include(text(refused), "items[0].status");
    }),
  );

  it("reads only well-formed plans within the step limit", () => {
    assert.deepEqual(
      parseTurnPlanSteps({ items: [{ content: "  Fix it  ", status: "pending" }] }),
      {
        steps: [{ content: "Fix it", status: "pending" }],
      },
    );
    assert.property(parseTurnPlanSteps({}), "error");
    assert.property(parseTurnPlanSteps({ items: [] }), "error");
    assert.property(parseTurnPlanSteps({ items: [{ content: " ", status: "pending" }] }), "error");
    assert.property(
      parseTurnPlanSteps({
        items: Array.from({ length: TURN_PLAN_MAX_STEPS + 1 }, (_, index) => ({
          content: `Step ${index}`,
          status: "pending",
        })),
      }),
      "error",
    );
  });
});

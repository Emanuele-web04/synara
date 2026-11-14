// FILE: turnPlanTools.ts
// Purpose: The `synara_update_plan` gateway tool: a Claude session reports its step-by-step plan
//          for the running turn. Claude Code no longer offers its own task-list tools to current
//          models, so this is how the turn plan reaches Synara. The gateway validates and
//          acknowledges; the Claude adapter reads the same input and shows it as the turn's tasks.
// Layer: Agent Gateway tool (Claude sessions only, through the `turn:plan` capability)
// Exports: makeAgentGatewayTurnPlanTools, parseTurnPlanSteps, SYNARA_UPDATE_PLAN_TOOL_NAME

import { Effect } from "effect";

import { mcpToolResultError, type McpToolCallResult } from "./protocol.ts";
import { WRITE_TOOL_ANNOTATIONS, type ToolEntry } from "./toolRuntime.ts";

export const SYNARA_UPDATE_PLAN_TOOL_NAME = "synara_update_plan";
export const TURN_PLAN_CAPABILITY = "turn:plan" as const;
export const TURN_PLAN_MAX_STEPS = 12;

const TURN_PLAN_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TurnPlanStepStatus = (typeof TURN_PLAN_STATUSES)[number];

export interface TurnPlanStep {
  readonly content: string;
  readonly status: TurnPlanStepStatus;
}

// The model weighs every extra round trip, so the description carries the
// whole contract: when a turn gets a plan, and that each call rides along with
// real work instead of costing a message of its own.
const DESCRIPTION = [
  "Keep the checklist Synara pins under your latest message while you work.",
  "Any request that edits files or takes more than one command gets one: implement and test, investigate then fix, a list the user gave. Only a single-command answer or plain conversation goes without.",
  "Never send this call on its own: put it in the same message as another tool call, in parallel, so it adds no round trip.",
  "- Start: alongside the very first tool call of the turn, even one that only reads: the whole plan in order, short imperative phrases without numbering, the step you are starting in_progress and the rest pending. If you must look around first, make that the first step and replace the list once you know more.",
  "- Progress: alongside the call that begins the next step, send the whole list again with finished steps completed and exactly one in_progress.",
  "- Changed plan, or a new instruction mid-task: send the new whole list so the pinned plan never shows abandoned steps.",
  "- Finish: leave the last step in_progress; Synara checks it off when your turn ends normally.",
  `Write steps in the user's language; at most ${TURN_PLAN_MAX_STEPS}. Do not also write the plan as a list in your reply: the checklist is the plan.`,
].join("\n");

function isTurnPlanStatus(value: unknown): value is TurnPlanStepStatus {
  return (TURN_PLAN_STATUSES as ReadonlyArray<unknown>).includes(value);
}

/**
 * The one reading of a `synara_update_plan` input, shared by the gateway (which
 * refuses what it cannot show) and the Claude adapter (which shows it), so the
 * two never disagree about what the user sees.
 */
export function parseTurnPlanSteps(
  input: Record<string, unknown>,
): { readonly steps: ReadonlyArray<TurnPlanStep> } | { readonly error: string } {
  const items = input.items;
  if (!Array.isArray(items) || items.length === 0) {
    return { error: "items needs at least one step: [{content, status}]." };
  }
  if (items.length > TURN_PLAN_MAX_STEPS) {
    return { error: `items has ${items.length} steps; keep the plan to ${TURN_PLAN_MAX_STEPS}.` };
  }
  const steps: TurnPlanStep[] = [];
  for (const [index, item] of items.entries()) {
    const record =
      item && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : undefined;
    const content = typeof record?.content === "string" ? record.content.trim() : "";
    if (content.length === 0) {
      return { error: `items[${index}].content must be a non-empty string.` };
    }
    if (!isTurnPlanStatus(record?.status)) {
      return {
        error: `items[${index}].status must be one of ${TURN_PLAN_STATUSES.join(", ")}.`,
      };
    }
    steps.push({ content, status: record.status });
  }
  return { steps };
}

function acknowledge(steps: ReadonlyArray<TurnPlanStep>): McpToolCallResult {
  const inProgress = steps.filter((step) => step.status === "in_progress").length;
  const remaining = steps.filter((step) => step.status !== "completed").length;
  const notes = [
    inProgress > 1 ? "Keep only one step in_progress." : undefined,
    inProgress === 0 && remaining > 0
      ? "No step is in_progress; mark the one you are on."
      : undefined,
  ].filter((note): note is string => note !== undefined);
  return {
    content: [
      {
        type: "text",
        text: [
          `Plan shown (${steps.length} ${steps.length === 1 ? "step" : "steps"}, ${remaining} open).`,
          ...notes,
        ].join(" "),
      },
    ],
  };
}

export function makeAgentGatewayTurnPlanTools(): ReadonlyArray<ToolEntry> {
  const updatePlan: ToolEntry = {
    requiredCapability: TURN_PLAN_CAPABILITY,
    requiresActiveTurn: true,
    definition: {
      name: SYNARA_UPDATE_PLAN_TOOL_NAME,
      description: DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            description: "The whole plan, in order.",
            maxItems: TURN_PLAN_MAX_STEPS,
            items: {
              type: "object",
              properties: {
                content: { type: "string", description: "The step, as a short imperative phrase." },
                status: { type: "string", enum: [...TURN_PLAN_STATUSES] },
              },
              required: ["content", "status"],
              additionalProperties: false,
            },
          },
        },
        required: ["items"],
        additionalProperties: false,
      },
      annotations: {
        title: "Update the turn plan",
        ...WRITE_TOOL_ANNOTATIONS,
        destructiveHint: false,
      },
      // A deferred tool is one the model never reaches for: keep the schema in
      // the prompt so the plan shows without a tool-search round trip first.
      _meta: { "anthropic/alwaysLoad": true },
    },
    handler: (args) =>
      Effect.sync(() => {
        const parsed = parseTurnPlanSteps(args);
        return "error" in parsed ? mcpToolResultError(parsed.error) : acknowledge(parsed.steps);
      }),
  };
  return [updatePlan];
}

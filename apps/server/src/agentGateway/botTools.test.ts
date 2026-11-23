import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { BotServiceError, type BotServiceShape } from "../bots/Services/BotService.ts";
import { makeBotTools } from "./botTools.ts";
import type { McpToolCallResult } from "./protocol.ts";
import type { ToolContext } from "./toolRuntime.ts";

const context = {
  callerThreadId: "thread-bot",
  callerTurnId: "turn-1",
  jsonRpcRequestId: 1,
} as unknown as ToolContext;

const toolsWith = (resolveCaller: BotServiceShape["resolveCaller"]) =>
  makeBotTools({ bots: { resolveCaller } as unknown as BotServiceShape });

const textOf = (result: McpToolCallResult) =>
  result.content.map((entry) => (entry.type === "text" ? entry.text : "")).join("");

describe("SynBot gateway tools", () => {
  it.effect("a bot chat locked by the Alto gate is told SUBSCRIPTION_REQUIRED", () =>
    Effect.gen(function* () {
      const tools = toolsWith(() =>
        Effect.fail(
          new BotServiceError({
            message: "SynBot requires an active Synara Alto (Pro) subscription.",
            code: "subscription-required",
          }),
        ),
      );
      for (const tool of tools) {
        const result = yield* tool.handler({}, context);
        expect(result.isError, tool.definition.name).toBe(true);
        expect(textOf(result), tool.definition.name).toContain("SUBSCRIPTION_REQUIRED");
        expect(yield* tool.advertisedTo!(context), tool.definition.name).toBe(false);
      }
    }),
  );

  it.effect("any other chat is told the tools are for bot chats only", () =>
    Effect.gen(function* () {
      const tools = toolsWith(() => Effect.succeed(null));
      for (const tool of tools) {
        const result = yield* tool.handler({}, context);
        expect(textOf(result), tool.definition.name).toBe(
          "Only SynBot bot chats can use this tool.",
        );
        expect(yield* tool.advertisedTo!(context), tool.definition.name).toBe(false);
      }
    }),
  );
});

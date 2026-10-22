import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { computerApprovalGate } from "../computer/ComputerApprovalGate.ts";
import { makeNotionApproval } from "./notionApproval.ts";
import type { ToolContext } from "./toolRuntime.ts";
import type { NotionWriteInput, OrchestrationCommand } from "@synara/contracts";

const input: NotionWriteInput = {
  requestId: "11111111-1111-4111-8111-111111111111",
  createdAt: "2026-10-15T12:00:00Z",
  connectionId: "workspace:bot",
  kind: "updatePage",
  id: "22222222-2222-4222-8222-222222222222",
  base: { s: { status: { id: "todo" } } },
  changes: { s: { status: { id: "done" } } },
};
const context: ToolContext = {
  principal: {
    kind: "provider-session",
    sessionKey: "notion-test",
    threadId: "notion-approval",
    provider: "claudeAgent",
    turnId: "turn",
  },
  callerThreadId: "notion-approval",
  callerThreadLabel: "Notion approval",
  callerSessionKey: "notion-test",
  callerProvider: "claudeAgent",
  callerCapabilities: new Set(["thread:read", "thread:write"]),
  callerTurnId: "turn",
  assertCallerTurnActive: () => Effect.void,
  jsonRpcRequestId: 1,
};
describe("Notion per-call consent", () => {
  it.each(["accept", "decline", "acceptForSession", "cancel"] as const)(
    "handles %s without broadening consent",
    async (decision) => {
      const events: OrchestrationCommand[] = [];
      const approve = makeNotionApproval((command) =>
        Effect.sync(() => {
          events.push(command);
          if (
            command.type === "thread.activity.append" &&
            command.activity.kind === "approval.requested"
          ) {
            const payload = command.activity.payload as {
              requestId: string;
              sessionApprovalAvailable: boolean;
              toolName: string;
            };
            expect(payload.sessionApprovalAvailable).toBe(false);
            expect(payload.toolName).toBe("synara_notion_write");
            expect(command.activity.payload).toMatchObject({
              toolParamsDisplay: [
                { name: "source", value: "Engineering" },
                { name: "operation", value: "updatePage" },
                { name: "resourceId", value: input.id },
                { name: "original", value: input.base },
                { name: "proposed", value: input.changes },
              ],
            });
            expect(
              computerApprovalGate.respond(context.callerThreadId, payload.requestId, decision),
            ).toBe(true);
          }
        }),
      );
      expect(
        await approve({ mappingName: "Engineering", input }, context, new AbortController().signal),
      ).toBe(decision === "accept");
      expect(
        events.some(
          (command) =>
            command.type === "thread.activity.append" &&
            command.activity.kind === "approval.requested",
        ),
      ).toBe(true);
    },
  );
  it("does not publish consent for an inactive caller", async () => {
    let calls = 0;
    const approve = makeNotionApproval(() =>
      Effect.sync(() => {
        calls++;
      }),
    );
    const inactive = {
      ...context,
      assertCallerTurnActive: () => Effect.fail(new Error("stale turn")),
    } as unknown as ToolContext;
    await expect(
      approve({ mappingName: "Engineering", input }, inactive, new AbortController().signal),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });
});

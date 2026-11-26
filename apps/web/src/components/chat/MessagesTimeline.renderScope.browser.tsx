// FILE: MessagesTimeline.renderScope.browser.tsx
// Purpose: Guards the streaming render budget: a text-only flush re-renders the
//          streaming row, not every row LegendList keeps mounted.
// Layer: Web chat component browser tests
// Depends on: the real LegendList, wrapped to count renderItem calls and expose extraData.

import "../../index.css";

import { MessageId, ThreadId, TurnId } from "@synara/contracts";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { ChatMessage } from "../../types";
import type { SubagentThreadPresentation } from "./SubagentThreadIntro";
import { MessagesTimeline } from "./MessagesTimeline";

const listProbe = vi.hoisted(() => ({
  renderedRowIds: [] as string[],
  extraData: [] as unknown[],
}));

vi.mock("@legendapp/list/react", async (importOriginal) => {
  const React = await import("react");
  const actual = await importOriginal<typeof import("@legendapp/list/react")>();
  type ListProps = ComponentProps<typeof actual.LegendList<{ id: string }>>;
  const LegendList = React.forwardRef(function ProbedLegendList(
    props: ListProps,
    ref: React.ForwardedRef<unknown>,
  ) {
    listProbe.extraData.push(props.extraData);
    const renderItem = props.renderItem;
    return (
      <actual.LegendList
        {...(props as object)}
        ref={ref as never}
        renderItem={(info: Parameters<NonNullable<ListProps["renderItem"]>>[0]) => {
          listProbe.renderedRowIds.push(info.item.id);
          return renderItem?.(info) ?? null;
        }}
      />
    );
  });
  return { ...actual, LegendList };
});

const CREATED_AT = "2026-10-01T12:00:00.000Z";
const TURN_COUNT = 12;
const NOOP = () => {};
const EMPTY_TURN_DIFFS = new Map();
const EMPTY_REVERT_COUNTS = new Map();
const EMPTY_WORK_GROUPS: Record<string, boolean> = {};

function messageEntry(message: ChatMessage) {
  return { id: `entry:${message.id}`, kind: "message" as const, createdAt: CREATED_AT, message };
}

function buildConversation(options: { agentBriefs?: boolean } = {}) {
  const entries = [];
  for (let turn = 0; turn < TURN_COUNT; turn += 1) {
    const turnId = TurnId.makeUnsafe(`turn-${turn}`);
    entries.push(
      messageEntry({
        id: MessageId.makeUnsafe(`user-${turn}`),
        role: "user",
        text: `Question ${turn}`,
        createdAt: CREATED_AT,
        streaming: false,
        ...(options.agentBriefs ? { dispatchOrigin: "agent" as const } : {}),
      }),
      messageEntry({
        id: MessageId.makeUnsafe(`assistant-${turn}`),
        role: "assistant",
        text: `Answer ${turn}`,
        turnId,
        createdAt: CREATED_AT,
        streaming: false,
      }),
    );
  }
  const liveTurnId = TurnId.makeUnsafe(`turn-${TURN_COUNT}`);
  const streamingMessage = (text: string): ChatMessage => ({
    id: MessageId.makeUnsafe("assistant-live"),
    role: "assistant",
    text,
    turnId: liveTurnId,
    createdAt: CREATED_AT,
    streaming: true,
  });
  return { entries, liveTurnId, streamingMessage };
}

function timeline(
  timelineEntries: ReturnType<typeof messageEntry>[],
  liveTurnId: TurnId,
  subagentThread: SubagentThreadPresentation | null = null,
) {
  return (
    <div style={{ display: "flex", height: 4_000 }}>
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnId={liveTurnId}
        activeTurnStartedAt={CREATED_AT}
        subagentThread={subagentThread}
        timelineEntries={timelineEntries}
        turnDiffSummaryByAssistantMessageId={EMPTY_TURN_DIFFS}
        expandedWorkGroups={EMPTY_WORK_GROUPS}
        onToggleWorkGroup={NOOP}
        onOpenTurnDiff={NOOP}
        revertTurnCountByUserMessageId={EMPTY_REVERT_COUNTS}
        // ChatView rebuilds these from the streaming thread on every flush.
        onRevertUserMessage={() => {}}
        onEditUserMessage={() => true}
        onForkFromMessage={() => {}}
        onUndoTurnFiles={() => {}}
        onChangeRecoveryModel={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={NOOP}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />
    </div>
  );
}

async function settleLayout(): Promise<void> {
  for (let frame = 0; frame < 4; frame += 1) {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  }
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  listProbe.renderedRowIds.length = 0;
  listProbe.extraData.length = 0;
});

describe("MessagesTimeline streaming render scope", () => {
  it.each([
    { name: "a main thread", subagentThread: null },
    {
      name: "a subagent thread",
      subagentThread: {
        parentThreadId: ThreadId.makeUnsafe("parent-thread"),
        parentTitle: "Parent",
        role: "Explorer",
        modelLabel: null,
        provider: null,
        statusKind: null,
        startedAt: null,
        endedAt: null,
      } satisfies SubagentThreadPresentation,
    },
  ])(
    "re-renders only the streaming row on a text-only flush in $name",
    async ({ subagentThread }) => {
      const { entries, liveTurnId, streamingMessage } = buildConversation({
        agentBriefs: subagentThread !== null,
      });
      const screen = await render(
        timeline(
          [...entries, messageEntry(streamingMessage("Working"))],
          liveTurnId,
          subagentThread,
        ),
      );
      cleanup = screen.unmount;
      await expect
        .poll(() => document.querySelectorAll("[data-message-role]").length)
        .toBeGreaterThan(TURN_COUNT);
      await settleLayout();
      const mountedRows = document.querySelectorAll("[data-timeline-row-kind]").length;
      const extraDataBefore = listProbe.extraData.at(-1);
      listProbe.renderedRowIds.length = 0;

      // A streamed delta replaces only the live message; every other entry keeps
      // its identity, exactly as the store's text-only flush delivers it.
      await screen.rerender(
        timeline(
          [...entries, messageEntry(streamingMessage("Working on it"))],
          liveTurnId,
          subagentThread,
        ),
      );
      await expect.poll(() => document.body.textContent).toContain("Working on it");
      await settleLayout();

      expect(mountedRows).toBeGreaterThan(TURN_COUNT);
      expect(listProbe.extraData.at(-1)).toBe(extraDataBefore);
      // The streaming row, plus at most one neighbour whose tail-row flags moved.
      expect(new Set(listProbe.renderedRowIds).size).toBeLessThanOrEqual(2);
      expect(listProbe.renderedRowIds.some((id) => id.includes("assistant-live"))).toBe(true);
    },
  );
});

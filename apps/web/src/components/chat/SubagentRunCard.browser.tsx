import "../../index.css";

import { MessageId, ThreadId, TurnId } from "@synara/contracts";
import { useRef, useSyncExternalStore, type ComponentProps } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import { makeActivity, makeThread } from "../../storeTestFixtures";
import { deriveSubagentTaskEnds, type WorkLogEntry } from "../../session-logic";
import { SubagentRunCard } from "./SubagentRunCard";
import { SubagentRunningChip } from "./SubagentRunningChip";
import { SubagentThreadIntro } from "./SubagentThreadIntro";
import { MessagesTimeline, type MessagesTimelineController } from "./MessagesTimeline";
import {
  createSubagentRunVisibilityStore,
  SubagentRunContext,
  type SubagentRunContextValue,
} from "./subagentRunContext";

const parent = ThreadId.makeUnsafe("parent");
const outer = ThreadId.makeUnsafe("subagent:parent:outer");
const inner = ThreadId.makeUnsafe("subagent:parent:inner");
const launchedAt = "2026-10-10T00:00:00.000Z";
const entry: WorkLogEntry = {
  id: "subagent-run:launch",
  createdAt: launchedAt,
  turnId: TurnId.makeUnsafe("turn"),
  label: "Subagents",
  tone: "info",
  subagents: [
    {
      threadId: "outer",
      resolvedThreadId: outer,
      nickname: "Survey calc.py",
      rawStatus: "running",
    },
  ],
  subagentRun: {
    members: [
      { key: "outer", launchedAt, latestStep: null, outcome: null, failure: null, settledAt: null },
    ],
  },
};

function context(overrides: Partial<SubagentRunContextValue> = {}): SubagentRunContextValue {
  return {
    parentThreadId: parent,
    liveTurnId: entry.turnId ?? null,
    threads: [
      makeThread({
        id: outer,
        parentThreadId: parent,
        sourceThreadId: parent,
        createdAt: launchedAt,
      }),
      makeThread({
        id: inner,
        parentThreadId: parent,
        sourceThreadId: outer,
        subagentNickname: "Inner count",
        createdAt: launchedAt,
        session: { status: "running" } as SubagentRunContextValue["threads"][number]["session"],
      }),
    ],
    backgroundedProviderThreadIds: new Set(),
    taskEndByToolUseId: new Map(),
    visibility: null,
    onOpenThread: vi.fn(),
    onStop: vi.fn(),
    ...overrides,
  };
}

beforeEach(async () => {
  await page.viewport(1000, 700);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T00:00:12.000Z"));
});

afterEach(async () => {
  await cleanup();
  vi.useRealTimers();
});

it("keeps Stop visible, Message keyboard reachable, and nested controls collapsed until expanded", async () => {
  const value = context();
  const screen = await render(
    <div style={{ width: 850 }}>
      <SubagentRunContext.Provider value={value}>
        <SubagentRunCard workEntry={entry} />
      </SubagentRunContext.Provider>
    </div>,
  );
  const disclosure = screen.getByTestId("subagent-run-card").element().querySelector("button")!;
  expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await expect.element(screen.getByRole("button", { name: "Stop all", exact: true })).toBeVisible();
  await userEvent.click(disclosure);
  await expect.element(screen.getByText("+1 nested")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Stop Survey calc.py" })).toBeVisible();
  expect(
    screen
      .getByText("Inner count", { exact: true })
      .element()
      .closest('[aria-hidden="true"][inert]'),
  ).not.toBeNull();
  const message = screen.getByRole("button", { name: "Message", exact: true });
  expect(getComputedStyle(message.element()).opacity).toBe("0");
  screen.getByRole("button", { name: "Open Survey calc.py" }).element().focus();
  await userEvent.tab();
  await userEvent.tab();
  expect(document.activeElement).toBe(message.element());
  await vi.waitFor(() => expect(getComputedStyle(message.element()).opacity).toBe("1"));
  await userEvent.keyboard("{Enter}");
  expect(value.onOpenThread).toHaveBeenCalledWith(outer);
  await screen.getByRole("button", { name: "launched 1 subagent" }).click();
  await expect.element(screen.getByText("Inner count", { exact: true })).toBeVisible();
  expect(
    screen
      .getByText("Inner count", { exact: true })
      .element()
      .closest('[aria-hidden="true"][inert]'),
  ).toBeNull();
  await screen.getByRole("button", { name: "Stop Inner count" }).click();
  expect(value.onStop).toHaveBeenCalledWith(expect.objectContaining({ providerThreadId: "inner" }));
  await screen.getByRole("button", { name: "Stop all", exact: true }).click();
  expect(value.onStop).toHaveBeenCalledWith(expect.objectContaining({ providerThreadId: "outer" }));
});

it("settles background cards across parent turns and rebuilds their state after reload", async () => {
  const work: WorkLogEntry = {
    ...entry,
    subagents: [
      { ...entry.subagents![0]!, model: "claude-sonnet-4-6", effort: "medium" },
      { threadId: "second", nickname: "APM runtime flow research", rawStatus: "running" },
    ],
    subagentRun: {
      members: [
        ...entry.subagentRun!.members,
        {
          key: "second",
          launchedAt,
          latestStep: null,
          outcome: null,
          failure: null,
          settledAt: null,
        },
      ],
    },
  };
  const starts = ["outer", "second"].map((toolUseId, index) =>
    makeActivity({
      id: `start-${toolUseId}`,
      kind: "task.started",
      sequence: index + 1,
      turnId: "turn",
      createdAt: launchedAt,
      payload: { taskId: `task-${toolUseId}`, toolUseId, taskType: "subagent" },
    }),
  );
  const ends = ["outer", "second"].map((toolUseId, index) =>
    makeActivity({
      id: `done-${toolUseId}`,
      kind: index === 0 ? "task.updated" : "task.completed",
      sequence: index + 3,
      ...(index === 0 ? {} : { turnId: "another-turn" }),
      createdAt: "2026-10-10T00:00:36.000Z",
      payload: { taskId: `task-${toolUseId}`, status: "completed" },
    }),
  );
  const view = (activities: typeof starts, liveTurnId: SubagentRunContextValue["liveTurnId"]) => {
    const value = context({
      liveTurnId,
      threads: [],
      backgroundedProviderThreadIds: new Set(["outer", "second"]),
      taskEndByToolUseId: deriveSubagentTaskEnds(activities),
    });
    return (
      <div style={{ width: 650 }}>
        <SubagentRunContext.Provider value={value}>
          <SubagentRunCard workEntry={work} />
        </SubagentRunContext.Provider>
      </div>
    );
  };
  let screen = await render(view(starts, entry.turnId ?? null));
  await userEvent.click(screen.getByTestId("subagent-run-card").element().querySelector("button")!);
  expect(screen.container.querySelectorAll('[data-phase="running"]')).toHaveLength(2);
  await screen.rerender(view(starts, null)); // interrupting the parent does not finish background work
  await expect.element(screen.getByRole("button", { name: "Stop all", exact: true })).toBeVisible();
  await screen.rerender(view([...starts, ends[0]!], null));
  expect(screen.container.querySelectorAll('[data-phase="running"]')).toHaveLength(1);
  expect(screen.container.querySelectorAll('[data-phase="done"]')).toHaveLength(1);
  await screen.rerender(view([...starts, ...ends], null));
  expect(screen.container.querySelectorAll('[data-phase="done"]')).toHaveLength(2);
  expect(screen.container.querySelectorAll(".animate-spin-stepped")).toHaveLength(0);
  expect(screen.container.querySelector('[aria-label^="Stop"]')).toBeNull();
  expect(screen.container.textContent).not.toContain("running");
  expect(screen.container.textContent).toContain("36s");
  await screen.unmount();
  // A cold mount reconstructs from serialized persisted events, with no child detail loaded.
  vi.setSystemTime(new Date("2026-10-13T08:00:00.000Z"));
  screen = await render(view(JSON.parse(JSON.stringify([...starts, ...ends])), null));
  expect(screen.container.querySelectorAll(".animate-spin-stepped")).toHaveLength(0);
  expect(screen.container.querySelector('[aria-label^="Stop"]')).toBeNull();
  expect(screen.container.textContent).not.toContain("running");
  expect(screen.container.textContent).toContain("36s");
});

it.each([620, 360])(
  "keeps identity, background state and a long command from overlapping at %ipx",
  async (width) => {
    const command =
      'cd /Users/usuario/projects/manager-components-front; git show origin/master:src/pages/integrationConfigPage/MultiValueInput.tsx | grep -n -E "allowed_values|Select|Popover|Checkbox|kind|group|pair" | head -20';
    const work: WorkLogEntry = {
      ...entry,
      subagents: [
        {
          ...entry.subagents![0]!,
          nickname: "Integration config panel research",
          model: "claude-sonnet-4-6",
          effort: "medium",
        },
      ],
    };
    const value = context({
      backgroundedProviderThreadIds: new Set(["outer"]),
      threads: [
        makeThread({
          id: outer,
          createdAt: launchedAt,
          activities: [
            makeActivity({
              kind: "tool.completed",
              createdAt: launchedAt,
              payload: { itemType: "command_execution", data: { toolCallId: "cmd", command } },
            }),
          ],
        }),
      ],
    });
    const screen = await render(
      <div style={{ width }}>
        <SubagentRunContext.Provider value={value}>
          <SubagentRunCard workEntry={work} />
        </SubagentRunContext.Provider>
      </div>,
    );
    await userEvent.click(
      screen.getByTestId("subagent-run-card").element().querySelector("button")!,
    );
    const background = screen.getByText("background", { exact: true }).element();
    const running = screen.getByText("Running", { exact: true }).element();
    const code = screen.container.querySelector("code")!;
    expect(code.textContent).toBe(command);
    const backgroundBox = background.getBoundingClientRect();
    const runningBox = running.getBoundingClientRect();
    const rowBox = screen.getByTestId("subagent-run-row").element().getBoundingClientRect();
    expect(backgroundBox.right <= runningBox.left || backgroundBox.bottom <= runningBox.top).toBe(
      true,
    );
    expect(code.getBoundingClientRect().width).toBeGreaterThan(80);
    expect(runningBox.right).toBeLessThanOrEqual(rowBox.right);
    expect(screen.getByTestId("subagent-run-row").element().scrollWidth).toBeLessThanOrEqual(
      rowBox.width + 1,
    );
    await vi.waitFor(() =>
      expect(
        screen.getByTestId("subagent-run-card").element().getBoundingClientRect().bottom,
      ).toBeGreaterThanOrEqual(rowBox.bottom),
    );
    await page.screenshot({ path: `__screenshots__/subagent-row-layout-${width}.png` });
  },
);

it("reports card visibility in its scroll viewport and lets the running chip bring it back", async () => {
  const visibility = createSubagentRunVisibilityStore();
  const value = context({ visibility });
  function Harness() {
    const placements = useSyncExternalStore(visibility.subscribe, visibility.get, visibility.get);
    const placement = placements.get(entry.id);
    return (
      <div>
        <div
          data-chat-scroll-container="true"
          style={{ width: 850, height: 190, overflow: "auto" }}
        >
          <SubagentRunContext.Provider value={value}>
            <SubagentRunCard workEntry={entry} />
          </SubagentRunContext.Provider>
          <div style={{ height: 500 }} />
        </div>
        <SubagentRunningChip
          runningCount={2}
          direction={placement === "below" ? "below" : "above"}
          visible={placement === "above" || placement === "below"}
          onClick={() =>
            document.querySelector("[data-subagent-run-card]")?.scrollIntoView({ block: "nearest" })
          }
        />
      </div>
    );
  }
  const screen = await render(<Harness />);
  await vi.waitFor(() => expect(visibility.get().get(entry.id)).toBe("visible"));
  const viewport = screen.container.querySelector("[data-chat-scroll-container]")!;
  viewport.scrollTop = 400;
  await vi.waitFor(() => expect(visibility.get().get(entry.id)).toBe("above"));
  await screen.getByRole("button", { name: "2 subagents running, show them" }).click();
  await vi.waitFor(() => expect(visibility.get().get(entry.id)).toBe("visible"));
  expect(screen.container.querySelector('[data-testid="subagent-running-chip"]')).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await screen.unmount();
  expect(visibility.get().size).toBe(0);
});

it("does not invent a completed duration when the child's completion time is missing", async () => {
  const screen = await render(
    <SubagentThreadIntro
      subagent={{
        parentThreadId: parent,
        parentTitle: "Parallel checks",
        role: "general-purpose",
        modelLabel: "Haiku",
        provider: "claudeAgent",
        statusKind: "completed",
        startedAt: launchedAt,
        endedAt: null,
      }}
    />,
  );
  await expect.element(screen.getByText("Done", { exact: true })).toBeVisible();
  expect(screen.container.textContent).not.toContain("Done in");
});

function Timeline(props: Partial<ComponentProps<typeof MessagesTimeline>>) {
  return (
    <MessagesTimeline
      hasMessages
      isWorking={false}
      activeTurnInProgress={false}
      activeTurnStartedAt={null}
      timelineEntries={[]}
      turnDiffSummaryByAssistantMessageId={new Map()}
      onOpenTurnDiff={() => {}}
      onOpenThread={() => {}}
      revertTurnCountByUserMessageId={new Map()}
      onRevertUserMessage={() => {}}
      isRevertingCheckpoint={false}
      onImageExpand={() => {}}
      markdownCwd={undefined}
      resolvedTheme="light"
      timestampFormat="locale"
      workspaceRoot={undefined}
      {...props}
    />
  );
}

const brief = {
  id: MessageId.makeUnsafe("brief"),
  role: "user" as const,
  dispatchOrigin: "agent" as const,
  text: "Count the lines in calc.py.",
  createdAt: launchedAt,
  streaming: false,
};
const answer = {
  id: MessageId.makeUnsafe("answer"),
  role: "assistant" as const,
  text: "calc.py has 5 lines.",
  createdAt: "2026-10-10T00:00:08.000Z",
  completedAt: "2026-10-10T00:00:08.000Z",
  turnId: entry.turnId!,
  streaming: false,
};

it("groups adjacent launches in one compact card while preserving each controller target after parent completion", async () => {
  const second: WorkLogEntry = {
    ...entry,
    id: "subagent-run:second",
    subagents: [{ threadId: "second", nickname: "Second child", rawStatus: "running" }],
    subagentRun: {
      members: [
        {
          key: "second",
          launchedAt,
          latestStep: null,
          outcome: null,
          failure: null,
          settledAt: null,
        },
      ],
    },
  };
  const onNavigate = vi.fn();
  function Harness() {
    const controller = useRef<MessagesTimelineController | null>(null);
    return (
      <>
        <button onClick={() => controller.current?.scrollToWorkEntry(second.id)}>
          Show subagents
        </button>
        <div style={{ width: 850, height: 450 }}>
          <SubagentRunContext.Provider
            value={context({
              liveTurnId: null,
              backgroundedProviderThreadIds: new Set(["outer", "second"]),
            })}
          >
            <Timeline
              controllerRef={controller}
              onNavigate={onNavigate}
              timelineEntries={[
                { id: "brief", kind: "message", createdAt: brief.createdAt, message: brief },
                { id: entry.id, kind: "work", createdAt: "2026-10-10T00:00:01.000Z", entry },
                {
                  id: second.id,
                  kind: "work",
                  createdAt: "2026-10-10T00:00:02.000Z",
                  entry: second,
                },
                { id: "answer", kind: "message", createdAt: answer.createdAt, message: answer },
              ]}
            />
          </SubagentRunContext.Provider>
        </div>
      </>
    );
  }
  const screen = await render(<Harness />);
  await expect.element(screen.getByText(answer.text, { exact: true })).toBeVisible();
  expect(screen.container.querySelectorAll("[data-subagent-run-card]")).toHaveLength(1);
  const header = screen.getByTestId("subagent-run-card").element().querySelector("button")!;
  expect(header).toHaveAttribute("aria-expanded", "false");
  expect(header.textContent).toContain("2 subagents");
  const cardTarget = screen.getByTestId("subagent-run-card").element();
  const scroll = vi.spyOn(cardTarget, "scrollIntoView");
  await screen.getByRole("button", { name: "Show subagents" }).click();
  expect(scroll).toHaveBeenCalledWith({ block: "center", inline: "nearest", behavior: "smooth" });
  scroll.mockRestore();
  await vi.waitFor(() => {
    const card = screen.container.querySelector("[data-subagent-run-card]");
    expect(card).not.toBeNull();
    expect(card?.closest('[aria-hidden="true"]')).toBeNull();
  });
  expect(onNavigate).toHaveBeenCalled();
});

it("renders the child brief, parent link and delivery note together in the transcript", async () => {
  const onOpenThread = vi.fn();
  const subagent = {
    parentThreadId: parent,
    parentTitle: "Parallel checks",
    role: "general-purpose",
    modelLabel: "GPT-6-Luna",
    provider: "codex" as const,
    statusKind: "completed" as const,
    startedAt: launchedAt,
    endedAt: answer.completedAt,
  };
  const screen = await render(
    <div style={{ width: 850, height: 500 }}>
      <Timeline
        subagentThread={subagent}
        historyHeader={<SubagentThreadIntro subagent={subagent} onOpenThread={onOpenThread} />}
        timelineEntries={[
          { id: "brief", kind: "message", createdAt: brief.createdAt, message: brief },
          { id: "answer", kind: "message", createdAt: answer.createdAt, message: answer },
        ]}
      />
    </div>,
  );
  await expect.element(screen.getByText("Brief from", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByText("Delivered to Parallel checks", { exact: true }))
    .toBeVisible();
  await screen.getByRole("button", { name: "Open parent thread Parallel checks" }).click();
  expect(onOpenThread).toHaveBeenCalledWith(parent);
});

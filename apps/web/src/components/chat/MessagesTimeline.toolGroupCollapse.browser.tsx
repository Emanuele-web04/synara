// FILE: MessagesTimeline.toolGroupCollapse.browser.tsx
// Purpose: Browser regressions for collapsing tool-call runs into summary rows
//          ("Ran 4 commands") and for the working indicator claiming the live
//          run: it wears the running call, a failed call or a Codex status in
//          place of "Thinking", at one fixed height, until text settles the run.
// Layer: Vitest browser tests

import "../../index.css";

import { EventId, MessageId, TurnId, type OrchestrationThreadActivity } from "@synara/contracts";
import { useState, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { MessagesTimeline } from "./MessagesTimeline";
import type { TimelineEntry } from "../../session-logic";
import { deriveTimelineEntries, deriveWorkLogEntries } from "../../workLog";
import { AgentActivityDetailView } from "./AgentActivityDetailView";
import { deriveAgentActivityTimelineState } from "./agentActivity.logic";

function assistantEntry(id: string, text: string, streaming: boolean): TimelineEntry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: "2026-03-17T19:12:28.000Z",
    message: {
      id: MessageId.makeUnsafe(id),
      role: "assistant",
      text,
      createdAt: "2026-03-17T19:12:28.000Z",
      streaming,
    },
  };
}

function commandEntry(
  id: string,
  command: string,
  toolStatus: "running" | "completed" | "failed" = "completed",
): Extract<TimelineEntry, { kind: "work" }> {
  return {
    id: `entry-${id}`,
    kind: "work",
    createdAt: "2026-03-17T19:12:28.000Z",
    entry: {
      id,
      createdAt: "2026-03-17T19:12:28.000Z",
      label: "Ran command",
      tone: "tool",
      itemType: "command_execution",
      toolStatus,
      command,
    },
  };
}

function thinkingEntry(id: string, label: string): TimelineEntry {
  return {
    id: `entry-${id}`,
    kind: "work",
    createdAt: "2026-03-17T19:12:28.000Z",
    entry: {
      id,
      createdAt: "2026-03-17T19:12:28.000Z",
      label,
      tone: "thinking",
    },
  };
}

const SETTLED_COMMANDS = [
  "bun run lint",
  "bun run typecheck",
  "bun run build",
  "node scripts/check.mjs",
];
// Commands whose display text passes through verbatim (no humanized rewrite).
const LIVE_COMMANDS = ["git status", "node scripts/tail.mjs"];

function ToolGroupCollapseTimeline(props: {
  timelineEntries: TimelineEntry[];
  onOpenAgentActivity?: (id: string) => void;
  settled?: boolean;
  isWorking?: boolean;
  workingLabel?: ComponentProps<typeof MessagesTimeline>["workingLabel"];
}) {
  return (
    <MessagesTimeline
      hasMessages
      isWorking={props.isWorking ?? false}
      activeTurnInProgress={!props.settled}
      activeTurnStartedAt="2026-03-17T19:12:20.000Z"
      timelineEntries={props.timelineEntries}
      turnDiffSummaryByAssistantMessageId={new Map()}
      nowIso="2026-03-17T19:12:30.000Z"
      expandedWorkGroups={{}}
      onToggleWorkGroup={() => {}}
      onOpenTurnDiff={() => {}}
      revertTurnCountByUserMessageId={new Map()}
      onRevertUserMessage={() => {}}
      isRevertingCheckpoint={false}
      onImageExpand={() => {}}
      markdownCwd={undefined}
      resolvedTheme="dark"
      timestampFormat="locale"
      workspaceRoot={undefined}
      {...(props.onOpenAgentActivity ? { onOpenAgentActivity: props.onOpenAgentActivity } : {})}
      {...(props.workingLabel ? { workingLabel: props.workingLabel } : {})}
    />
  );
}

function createTimelineHost(): HTMLDivElement {
  const host = document.createElement("div");
  host.style.cssText =
    "display:flex;flex-direction:column;width:600px;height:520px;overflow:hidden;";
  document.body.append(host);
  return host;
}

function findSummaryTrigger(label: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((button) =>
      (button.textContent ?? "").includes(label),
    ) ?? null
  );
}

function copyButtonOpacity(messageId: string): string | null {
  const button = document.querySelector(
    `[data-message-id='${messageId}'] [aria-label='Copy message']`,
  );
  return button ? getComputedStyle(button).opacity : null;
}

function isVisibleOutsideClosedDisclosure(text: string): boolean {
  // The innermost element containing the text (command labels may span nested
  // spans, so a leaf-only check would miss them).
  const match = [...document.querySelectorAll<HTMLElement>("*")].findLast((element) =>
    (element.textContent ?? "").includes(text),
  );
  return match !== undefined && match.closest("[aria-hidden='true']") === null;
}

function workingIndicator(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-working-indicator='true']");
}

function workingToolCallText(): string | null | undefined {
  return workingIndicator()?.querySelector("[data-working-tool-call='true']")?.textContent;
}

// With the indicator showing, the live run leaves the transcript: the indicator
// wears its running call, and the earlier calls wait until the run settles.
async function expectIndicatorWearingNewestCall(): Promise<void> {
  const [earlierCommand, newestCommand] = LIVE_COMMANDS as [string, string];
  await expect.poll(workingToolCallText).toContain(newestCommand);
  expect(workingIndicator()?.dataset.workingState).toBe("tool-call");
  expect(document.body.textContent?.split(newestCommand)).toHaveLength(2);
  expect(document.body.textContent ?? "").not.toContain(earlierCommand);
}

// Without a working row nothing is live: the tail run folds to its summary like
// any other run, and its calls stay unmounted until the summary is opened.
async function expectTailRunSettled(label = "Ran 2 commands"): Promise<HTMLButtonElement> {
  await expect.poll(() => findSummaryTrigger(label) !== null).toBe(true);
  const trigger = findSummaryTrigger(label)!;
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  for (const command of LIVE_COMMANDS) {
    expect(document.body.textContent ?? "").not.toContain(command);
  }
  return trigger;
}

describe("MessagesTimeline tool group collapse", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps one Codex tool summary across reasoning updates while a command runs", async () => {
    const reasoning = (id: string): Extract<TimelineEntry, { kind: "work" }>["entry"] => ({
      id,
      createdAt: "2026-03-17T19:12:28.000Z",
      activityKind: "task.progress",
      label: "Reasoning trace",
      detail: "Checking the provider boundary.",
      tone: "tool",
      toolCallId: id,
    });
    const workEntries = deriveAgentActivityTimelineState(
      [
        commandEntry("first", "bun run lint").entry,
        commandEntry("second", "bun run typecheck").entry,
        reasoning("reasoned"),
        commandEntry("third", "node scripts/check.mjs").entry,
        commandEntry("fourth", "node scripts/tail.mjs", "running").entry,
        reasoning("latest-reasoning"),
      ],
      "codex",
    ).timelineWorkEntries;
    const screen = await render(
      <ToolGroupCollapseTimeline
        isWorking
        timelineEntries={[
          assistantEntry("preamble", "I’ll check the provider boundary.", false),
          ...workEntries.map((entry) => ({
            kind: "work" as const,
            id: entry.id,
            createdAt: entry.createdAt,
            entry,
          })),
        ]}
      />,
      { container: createTimelineHost() },
    );
    try {
      const summary = screen.getByRole("button", { name: "Ran 3 commands", exact: true });
      await expect.element(summary).toBeVisible();
      await expect.poll(workingToolCallText).toContain("node scripts/tail.mjs");
      await summary.click();
      await expect.element(screen.getByText("bun run lint", { exact: true })).toBeVisible();
      await expect
        .element(screen.getByText("node scripts/check.mjs", { exact: true }))
        .toBeVisible();
      expect(document.body.textContent?.split("node scripts/tail.mjs")).toHaveLength(2);
    } finally {
      await screen.unmount();
    }
  });

  it("folds background work with its turn, preserves both answers and reveals the command on demand", async () => {
    const startedAt = "2026-03-17T19:12:00.000Z";
    const completedAt = "2026-03-17T19:12:21.000Z";
    const entries = (settled: boolean): TimelineEntry[] => [
      {
        id: "request",
        kind: "message",
        createdAt: startedAt,
        message: {
          id: MessageId.makeUnsafe("request"),
          role: "user",
          text: "Build the app",
          createdAt: startedAt,
          streaming: false,
        },
      },
      {
        id: "launch",
        kind: "work",
        createdAt: startedAt,
        entry: {
          id: "launch",
          createdAt: startedAt,
          label: "Background build",
          tone: "tool",
          backgroundTask: {
            taskId: "build-task",
            taskType: "local_bash",
            description: "Build app",
            command: "node scripts/rebuild.mjs",
            status: "finished",
            startedAt,
            completedAt,
            completionActivityId: "wake",
            exitCode: 0,
          },
        },
      },
      {
        id: "launched",
        kind: "message",
        createdAt: "2026-03-17T19:12:04.000Z",
        message: {
          id: MessageId.makeUnsafe("launched"),
          role: "assistant",
          text: "The build is running.",
          createdAt: "2026-03-17T19:12:04.000Z",
          completedAt: "2026-03-17T19:12:04.000Z",
          streaming: false,
        },
      },
      {
        id: "wake",
        kind: "work",
        createdAt: completedAt,
        entry: {
          id: "wake",
          createdAt: completedAt,
          label: "Background task finished: Build app",
          tone: "info",
          backgroundTaskCompletion: {
            taskId: "build-task",
            taskType: "local_bash",
            description: "Build app",
            outcome: "finished",
          },
        },
      },
      {
        id: "report",
        kind: "message",
        createdAt: "2026-03-17T19:12:22.000Z",
        message: {
          id: MessageId.makeUnsafe("report"),
          role: "assistant",
          text: "The new app is ready.",
          createdAt: "2026-03-17T19:12:22.000Z",
          streaming: !settled,
          ...(settled ? { completedAt: "2026-03-17T19:12:24.000Z" } : {}),
        },
      },
    ];
    const screen = await render(<ToolGroupCollapseTimeline timelineEntries={entries(false)} />, {
      container: createTimelineHost(),
    });
    try {
      // No row stays pinned under the launching turn while the follow-up streams;
      // live task state lives in the Environment panel.
      await expect.poll(() => findSummaryTrigger("Worked for") !== null).toBe(true);
      expect(isVisibleOutsideClosedDisclosure("node scripts/rebuild.mjs")).toBe(false);
      await screen.rerender(<ToolGroupCollapseTimeline timelineEntries={entries(true)} settled />);
      await expect
        .element(screen.getByText("The build is running.", { exact: true }))
        .toBeVisible();
      await expect
        .element(screen.getByText("The new app is ready.", { exact: true }))
        .toBeVisible();
      await expect
        .poll(() => isVisibleOutsideClosedDisclosure("node scripts/rebuild.mjs"))
        .toBe(false);
      await expect.poll(() => findSummaryTrigger("Worked for") !== null).toBe(true);
      // Only "Worked for" closes with a hairline; the wake's "Resumed" line stands alone.
      const hairlineAfter = (label: string) =>
        findSummaryTrigger(label)
          ?.closest(".group\\/collapsed-work")
          ?.querySelector(":scope > .h-px") ?? null;
      expect(hairlineAfter("Worked for")).not.toBeNull();
      expect(findSummaryTrigger("Resumed")).not.toBeNull();
      expect(hairlineAfter("Resumed")).toBeNull();
      findSummaryTrigger("Worked for")!.click();
      await expect
        .element(screen.getByText("node scripts/rebuild.mjs", { exact: true }))
        .toBeVisible();
      findSummaryTrigger("Worked for")!.click();
      await expect
        .poll(() => isVisibleOutsideClosedDisclosure("node scripts/rebuild.mjs"))
        .toBe(false);
      await expect
        .element(screen.getByText("The new app is ready.", { exact: true }))
        .toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("ends a reply a background task carried on once, with a Resumed line between", async () => {
    const message = (id: string, role: "user" | "assistant", text: string, at: string) => ({
      id,
      kind: "message" as const,
      createdAt: at,
      message: {
        id: MessageId.makeUnsafe(id),
        role,
        text,
        createdAt: at,
        streaming: false,
        ...(role === "assistant" ? { completedAt: at } : {}),
      },
    });
    const wakeAt = "2026-03-17T19:12:10.000Z";
    const entries: TimelineEntry[] = [
      message("request", "user", "Run the suite", "2026-03-17T19:12:00.000Z"),
      message("first-answer", "assistant", "The suite is running.", "2026-03-17T19:12:04.000Z"),
      {
        id: "wake",
        kind: "work",
        createdAt: wakeAt,
        entry: {
          id: "wake",
          createdAt: wakeAt,
          label: "Background task finished: Full suite",
          tone: "info",
          backgroundTaskCompletion: {
            taskId: "suite-task",
            taskType: "local_bash",
            description: "Full suite",
            outcome: "finished",
          },
        },
      },
      message("follow-up", "assistant", "The suite passed.", "2026-03-17T19:12:12.000Z"),
    ];
    const screen = await render(<ToolGroupCollapseTimeline timelineEntries={entries} settled />, {
      container: createTimelineHost(),
    });
    try {
      await expect.element(screen.getByText("The suite passed.", { exact: true })).toBeVisible();
      await expect
        .element(screen.getByText("The suite is running.", { exact: true }))
        .toBeVisible();
      await expect.element(screen.getByText(/^Resumed: “Full suite” finished/)).toBeVisible();
      // Only the reply's last answer shows its actions at rest; the earlier
      // answer keeps them in place, revealed on hover.
      await expect.poll(() => copyButtonOpacity("follow-up")).toBe("1");
      await expect.poll(() => copyButtonOpacity("first-answer")).toBe("0");
      await screen.getByText("The suite is running.", { exact: true }).hover();
      await expect.poll(() => copyButtonOpacity("first-answer")).toBe("1");
    } finally {
      await screen.unmount();
    }
  });

  it("renders submitted questions and answers as separate transcript bubbles", async () => {
    const entries = [
      assistantEntry("before-question", "I need your preference.", false),
      commandEntry("earlier-command", "git status"),
      {
        id: "entry-answer",
        kind: "work" as const,
        createdAt: "2026-03-17T19:12:28.000Z",
        entry: {
          id: "answered",
          createdAt: "2026-03-17T19:12:28.000Z",
          label: "User input submitted",
          tone: "info" as const,
          activityKind: "user-input.resolved",
          userInputExchange: [
            {
              id: "q",
              header: "Color",
              question: "Which accent color?",
              options: ["Amber", "Blue"],
              answer: "Amber",
            },
          ],
        },
      },
      assistantEntry("after-question", "I applied your preference.", false),
    ];
    const screen = await render(<ToolGroupCollapseTimeline timelineEntries={entries} />, {
      container: createTimelineHost(),
    });
    await expect.element(screen.getByText("Which accent color?", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Amber", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Amber · Blue", { exact: true })).toBeVisible();
    expect(isVisibleOutsideClosedDisclosure("Which accent color?")).toBe(true);
    expect(isVisibleOutsideClosedDisclosure("Amber")).toBe(true);
  });

  it("keeps the original updates reachable from a compacted legacy reasoning row", async () => {
    const state = deriveAgentActivityTimelineState([
      {
        id: "legacy-first",
        createdAt: "2026-03-17T19:12:21.000Z",
        label: "Reasoning update",
        tone: "thinking",
        detail: "First preview.\n\nOriginal detail from the first update.",
      },
      {
        id: "legacy-last",
        createdAt: "2026-03-17T19:12:22.000Z",
        label: "Reasoning update",
        tone: "thinking",
        detail: "Latest preview.\n\nOriginal detail from the last update.",
      },
    ]);
    function LegacyReasoningTimeline() {
      const [detailId, setDetailId] = useState<string | null>(null);
      const detail = detailId ? state.detailById.get(detailId) : undefined;
      return detail ? (
        <AgentActivityDetailView
          detail={detail}
          chatFontSizePx={14}
          markdownCwd={undefined}
          onBack={() => setDetailId(null)}
          onImageExpand={() => {}}
          timestampFormat="locale"
        />
      ) : (
        <ToolGroupCollapseTimeline
          timelineEntries={deriveTimelineEntries([], [], state.timelineWorkEntries)}
          onOpenAgentActivity={setDetailId}
        />
      );
    }
    const screen = await render(<LegacyReasoningTimeline />, { container: createTimelineHost() });
    try {
      await screen.getByRole("button", { name: /2 updates/ }).click();
      await expect
        .element(screen.getByText("Original detail from the first update.", { exact: true }))
        .toBeVisible();
      await expect
        .element(screen.getByText("Original detail from the last update.", { exact: true }).last())
        .toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it.each(["reasoning", "tool summary"] as const)(
    "keeps %s between tool runs as full Markdown transcript text",
    async (kind) => {
      const host = createTimelineHost();
      const onOpenAgentActivity = vi.fn();
      const reasoning: TimelineEntry = {
        id: "reasoning-row",
        kind: "work",
        createdAt: "2026-03-17T19:12:28.000Z",
        entry: {
          id: "reasoning-row",
          createdAt: "2026-03-17T19:12:28.000Z",
          label: kind === "reasoning" ? "Reasoning trace" : "Tool summary",
          tone: kind === "reasoning" ? "tool" : "info",
          ...(kind === "reasoning"
            ? { toolCallId: "reasoning-item", toolStatus: "running" as const }
            : { activityKind: "tool.summary" }),
          detail: "First inspect the `provider` boundary.\n\nThen verify cancellation.",
        },
      };
      const screen = await render(
        <ToolGroupCollapseTimeline
          timelineEntries={[
            ...SETTLED_COMMANDS.map((command, index) => commandEntry(`before-${index}`, command)),
            reasoning,
            ...LIVE_COMMANDS.map((command, index) => commandEntry(`after-${index}`, command)),
          ]}
          onOpenAgentActivity={onOpenAgentActivity}
        />,
        { container: host },
      );

      try {
        await expect.poll(() => findSummaryTrigger("Ran 4 commands") !== null).toBe(true);
        await expectTailRunSettled();
        expect(isVisibleOutsideClosedDisclosure("First inspect the")).toBe(true);
        expect(isVisibleOutsideClosedDisclosure("Then verify cancellation.")).toBe(true);
        const prose = host.querySelector<HTMLElement>("[data-work-entry-prose='true']");
        expect(prose).not.toBeNull();
        expect(prose!.querySelectorAll("p")).toHaveLength(2);
        expect(prose!.querySelector("code")?.textContent).toBe("provider");
        expect(prose!.textContent).not.toContain("`");
        expect(prose!.closest("button")).toBeNull();
        expect(prose!.querySelector("[data-work-entry-icon='true']")).toBeNull();
        expect(onOpenAgentActivity).not.toHaveBeenCalled();
      } finally {
        await screen.unmount();
        host.remove();
      }
    },
  );

  it("wears a Codex status only while it is the newest entry, and a running call over it", async () => {
    const host = createTimelineHost();
    const statusEntry = (id: string, preview: string): TimelineEntry => ({
      id,
      kind: "work",
      createdAt: "2026-03-17T19:12:28.000Z",
      entry: {
        id,
        createdAt: "2026-03-17T19:12:28.000Z",
        label: "Reasoning summary",
        tone: "tool",
        preview,
      },
    });
    const [firstCommand, lastCommand] = LIVE_COMMANDS as [string, string];
    const entries = [
      assistantEntry("narration", "Checking the integrations.", true),
      commandEntry("first-command", firstCommand),
      statusEntry("first-status", "Inspecting integrations"),
    ];
    const screen = await render(<ToolGroupCollapseTimeline timelineEntries={entries} isWorking />, {
      container: host,
    });

    try {
      await expect.poll(workingToolCallText).toContain("Inspecting integrations");
      expect(workingIndicator()?.className).toContain("shimmer-group");

      // A finished call after the status: the agent is between calls.
      entries.push(commandEntry("last-command", lastCommand));
      await screen.rerender(<ToolGroupCollapseTimeline timelineEntries={[...entries]} isWorking />);
      await expect.poll(() => workingIndicator()?.textContent).toBe("Thinking");

      // A running call beats a newer status.
      entries.push(commandEntry("running-command", "node scripts/running.mjs", "running"));
      entries.push(statusEntry("last-status", "Verifying the adapter"));
      await screen.rerender(<ToolGroupCollapseTimeline timelineEntries={[...entries]} isWorking />);
      await expect.poll(workingToolCallText).toContain("node scripts/running.mjs");
      for (const text of [...LIVE_COMMANDS, "Inspecting integrations", "Verifying the adapter"]) {
        expect(document.body.textContent).not.toContain(text);
      }

      // Text settles the run: its summary reveals every entry on expansion.
      entries.push(assistantEntry("answer", "The adapter checks out.", true));
      await screen.rerender(<ToolGroupCollapseTimeline timelineEntries={[...entries]} isWorking />);
      await expect.poll(() => workingIndicator()?.textContent).toBe("Thinking");
      const trigger = findSummaryTrigger("1 running")!;
      expect(trigger).not.toBeNull();
      trigger.click();
      for (const text of [...LIVE_COMMANDS, "Inspecting integrations", "Verifying the adapter"]) {
        await expect.poll(() => isVisibleOutsideClosedDisclosure(text)).toBe(true);
      }
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps calls made after steering reachable from the run's summary", async () => {
    const host = createTimelineHost();
    const turnId = TurnId.makeUnsafe("steered-turn");
    const timelineEntries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("request"),
          role: "user",
          text: "Investigate usage",
          createdAt: "2026-03-17T19:12:20.000Z",
          streaming: false,
        },
        {
          id: MessageId.makeUnsafe("preamble"),
          role: "assistant",
          turnId,
          text: "Checking usage records.",
          createdAt: "2026-03-17T19:12:21.000Z",
          streaming: false,
        },
        {
          id: MessageId.makeUnsafe("steering"),
          role: "user",
          dispatchMode: "steer",
          text: "Only Codex",
          createdAt: "2026-03-17T19:12:22.000Z",
          streaming: false,
        },
        {
          id: MessageId.makeUnsafe("continued"),
          role: "assistant",
          turnId,
          text: "Continuing with Codex.",
          createdAt: "2026-03-17T19:12:23.000Z",
          streaming: true,
        },
      ],
      [],
      LIVE_COMMANDS.map((command, index) => ({
        id: `steered-tool-${index}`,
        turnId,
        createdAt: `2026-03-17T19:12:2${4 + index}.000Z`,
        label: "Running command",
        tone: "tool",
        itemType: "command_execution",
        toolStatus: "running",
        activityKind: "tool.started",
        command,
      })),
    );
    const screen = await render(<ToolGroupCollapseTimeline timelineEntries={timelineEntries} />, {
      container: host,
    });

    try {
      // No working row: the running run folds to a summary that counts it.
      const trigger = await expectTailRunSettled("Ran 2 commands, 2 running");

      trigger.click();

      await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
      await expect.poll(() => isVisibleOutsideClosedDisclosure(LIVE_COMMANDS[0]!)).toBe(true);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("collapses every run behind a summary when no working row claims the tail", async () => {
    const host = createTimelineHost();
    const screen = await render(
      <ToolGroupCollapseTimeline
        timelineEntries={[
          assistantEntry("narration-1", "Looking at the failing checks first.", false),
          ...SETTLED_COMMANDS.map((command, index) => commandEntry(`settled-${index}`, command)),
          assistantEntry("narration-2", "Now inspecting the working tree.", true),
          ...LIVE_COMMANDS.map((command, index) => commandEntry(`live-${index}`, command)),
        ]}
      />,
      { container: host },
    );

    try {
      await expect.poll(() => findSummaryTrigger("Ran 4 commands") !== null).toBe(true);
      const trigger = findSummaryTrigger("Ran 4 commands")!;
      expect(trigger.getAttribute("aria-expanded")).toBe("false");

      // Closed groups do not mount every tool row; this keeps large settled
      // transcripts cheap until the user asks to inspect the details.
      for (const command of SETTLED_COMMANDS) {
        expect(document.body.textContent ?? "").not.toContain(command);
      }

      await expectTailRunSettled();

      trigger.click();

      await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
      for (const command of SETTLED_COMMANDS) {
        await expect.poll(() => isVisibleOutsideClosedDisclosure(command)).toBe(true);
      }

      trigger.click();

      await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");
      // Rows remain mounted only long enough for the shared 220ms close motion.
      await expect
        .poll(() => (document.body.textContent ?? "").includes(SETTLED_COMMANDS[0]!))
        .toBe(false);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("collapses mid-turn as soon as a thinking block splits the live group", async () => {
    const host = createTimelineHost();
    // One live inline group: settled commands, then a thinking boundary, then
    // the live tail. The run before the boundary must collapse while the turn
    // is still in progress — not only once it finishes.
    const screen = await render(
      <ToolGroupCollapseTimeline
        timelineEntries={[
          assistantEntry("narration-1", "Looking at the failing checks first.", true),
          ...SETTLED_COMMANDS.map((command, index) => commandEntry(`settled-${index}`, command)),
          thinkingEntry("think-1", "Weighing the next verification step"),
          ...LIVE_COMMANDS.map((command, index) =>
            commandEntry(`live-${index}`, command, "running"),
          ),
        ]}
        isWorking
      />,
      { container: host },
    );

    try {
      await expect.poll(() => findSummaryTrigger("Ran 4 commands") !== null).toBe(true);
      expect(findSummaryTrigger("Ran 4 commands")!.getAttribute("aria-expanded")).toBe("false");
      for (const command of SETTLED_COMMANDS) {
        expect(document.body.textContent ?? "").not.toContain(command);
      }

      // The run after the thinking boundary is the live tail the indicator claims.
      await expectIndicatorWearingNewestCall();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
  it("wears the live run's newest call in the working indicator, then settles it into history", async () => {
    const host = createTimelineHost();
    const entries = (liveStatus: "running" | "completed") => [
      assistantEntry("narration-1", "Looking at the failing checks first.", false),
      ...SETTLED_COMMANDS.map((command, index) => commandEntry(`settled-${index}`, command)),
      assistantEntry("narration-2", "Now inspecting the working tree.", true),
      ...LIVE_COMMANDS.map((command, index) => commandEntry(`live-${index}`, command, liveStatus)),
    ];
    const screen = await render(
      <ToolGroupCollapseTimeline timelineEntries={entries("running")} isWorking />,
      { container: host },
    );

    try {
      await expect.poll(() => findSummaryTrigger("Ran 4 commands") !== null).toBe(true);
      await expectIndicatorWearingNewestCall();
      const toolLineHeight = workingIndicator()!.getBoundingClientRect().height;

      // Finished calls stay claimed: no row pops into history between calls.
      await screen.rerender(
        <ToolGroupCollapseTimeline timelineEntries={entries("completed")} isWorking />,
      );
      await expect.poll(() => workingIndicator()?.textContent).toBe("Thinking");
      expect(findSummaryTrigger("Ran 2 commands")).toBeNull();

      // New text settles the run behind its summary; the indicator keeps reading
      // a plain "Thinking", without an icon.
      await screen.rerender(
        <ToolGroupCollapseTimeline
          timelineEntries={[
            ...entries("completed"),
            assistantEntry("narration-3", "Both checks pass now.", true),
          ]}
          isWorking
        />,
      );
      await expect.poll(() => findSummaryTrigger("Ran 2 commands") !== null).toBe(true);
      await expect.poll(() => workingIndicator()?.textContent).toBe("Thinking");
      expect(workingIndicator()!.querySelector("svg")).toBeNull();
      expect(workingIndicator()!.getBoundingClientRect().height).toBe(toolLineHeight);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("wears a lone call in the working indicator and returns it as a plain row", async () => {
    const host = createTimelineHost();
    const [command] = LIVE_COMMANDS as [string];
    const entries = [
      assistantEntry("narration-1", "Checking the tree.", true),
      commandEntry("lone", command, "running"),
    ];
    const screen = await render(<ToolGroupCollapseTimeline timelineEntries={entries} isWorking />, {
      container: host,
    });

    try {
      await expect.poll(workingToolCallText).toContain(command);
      expect(document.body.textContent?.split(command)).toHaveLength(2);

      await screen.rerender(
        <ToolGroupCollapseTimeline
          timelineEntries={[
            assistantEntry("narration-1", "Checking the tree.", true),
            commandEntry("lone", command),
            assistantEntry("narration-2", "Clean.", true),
          ]}
          isWorking
        />,
      );
      await expect.poll(() => workingIndicator()?.textContent).toBe("Thinking");
      expect(isVisibleOutsideClosedDisclosure(command)).toBe(true);
      expect(findSummaryTrigger(command)).toBeNull();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("shows the same command running after Codex approval and preserves the request in history", async () => {
    const host = createTimelineHost();
    const turnId = TurnId.makeUnsafe("approval-turn");
    const createdAt = "2026-03-17T19:12:28.000Z";
    const command = 'python3 -c "import time; time.sleep(8)"';
    const rawCommand = `/bin/zsh -lc ${JSON.stringify(command)}`;
    const request = { requestId: "command-approval", requestType: "command_execution_approval" };
    const activities: OrchestrationThreadActivity[] = [
      {
        id: EventId.makeUnsafe("cmd-start"),
        turnId,
        createdAt,
        sequence: 1,
        kind: "tool.started",
        tone: "tool",
        summary: "Ran command started",
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          detail: rawCommand,
          data: {
            item: {
              id: "cmd",
              command: rawCommand,
              commandActions: [{ type: "unknown", command }],
            },
          },
        },
      },
      {
        id: EventId.makeUnsafe("cmd-approval"),
        turnId,
        createdAt,
        sequence: 2,
        kind: "approval.requested",
        tone: "approval",
        summary: "Command approval requested",
        payload: { ...request, detail: rawCommand },
      },
    ];
    const timeline = (decision?: "accept" | "acceptForSession" | "decline") =>
      deriveTimelineEntries(
        [],
        [],
        deriveWorkLogEntries(
          decision
            ? [
                ...activities,
                {
                  id: EventId.makeUnsafe("cmd-approved"),
                  turnId,
                  createdAt,
                  sequence: 3,
                  kind: "approval.resolved",
                  tone: "approval",
                  summary: "Approval resolved",
                  payload: { ...request, decision },
                },
              ]
            : activities,
          turnId,
          { activeTurnId: turnId },
        ),
      );
    const screen = await render(
      <ToolGroupCollapseTimeline
        timelineEntries={timeline()}
        isWorking
        workingLabel="Waiting for approval"
      />,
      { container: host },
    );

    try {
      await expect.poll(() => workingIndicator()?.textContent).toBe("Waiting for approval");
      for (const decision of ["accept", "acceptForSession"] as const) {
        await screen.rerender(
          <ToolGroupCollapseTimeline timelineEntries={timeline(decision)} isWorking />,
        );
        await expect.poll(() => workingToolCallText() ?? "").toContain("time.sleep(8)");
        expect(isVisibleOutsideClosedDisclosure("Running python script")).toBe(true);
        expect(host.textContent?.split("time.sleep(8)")).toHaveLength(2);
      }

      await screen.rerender(
        <ToolGroupCollapseTimeline timelineEntries={timeline("decline")} isWorking />,
      );
      await expect.poll(() => workingIndicator()?.textContent).toBe("Thinking");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps one height whichever line the working indicator wears", async () => {
    const host = createTimelineHost();
    const [command] = LIVE_COMMANDS as [string];
    const entriesWith = (toolStatus: "running" | "completed" | "failed") => [
      assistantEntry("narration-1", "Checking the tree.", true),
      commandEntry("lone", command, toolStatus),
    ];
    const screen = await render(
      <ToolGroupCollapseTimeline timelineEntries={entriesWith("running")} isWorking />,
      { container: host },
    );
    const heightAndState = () => ({
      height: workingIndicator()!.getBoundingClientRect().height,
      state: workingIndicator()!.dataset.workingState,
      shimmers: workingIndicator()!.classList.contains("shimmer-group"),
    });

    try {
      await expect.poll(workingToolCallText).toContain(command);
      const toolLine = heightAndState();
      expect(toolLine).toMatchObject({ state: "tool-call", shimmers: true });

      await screen.rerender(
        <ToolGroupCollapseTimeline timelineEntries={entriesWith("failed")} isWorking />,
      );
      await expect.poll(() => workingIndicator()?.dataset.workingState).toBe("tool-call-failed");
      expect(heightAndState()).toEqual({ ...toolLine, state: "tool-call-failed", shimmers: false });
      // The line stays muted; only the failure word is red.
      expect(workingIndicator()!.classList.contains("text-destructive")).toBe(false);
      expect(
        workingIndicator()!
          .querySelector("[data-tool-failure-meta='true']")
          ?.classList.contains("text-destructive"),
      ).toBe(true);
      expect(
        workingIndicator()!.querySelector("[data-tool-failure-meta='true']")?.textContent,
      ).toBe("Failed");

      await screen.rerender(
        <ToolGroupCollapseTimeline timelineEntries={entriesWith("completed")} isWorking />,
      );
      await expect.poll(() => workingIndicator()?.textContent).toBe("Thinking");
      expect(heightAndState()).toEqual({ ...toolLine, state: "thinking" });

      for (const workingLabel of ["Waiting for approval", "Waiting for your answer"] as const) {
        await screen.rerender(
          <ToolGroupCollapseTimeline
            timelineEntries={entriesWith("running")}
            isWorking
            workingLabel={workingLabel}
          />,
        );
        await expect.poll(() => workingIndicator()?.textContent).toBe(workingLabel);
        expect(heightAndState()).toEqual({ ...toolLine, state: "waiting", shimmers: false });
        expect(workingIndicator()!.querySelector("svg")).toBeNull();
        // Waiting claims nothing: the call is back in history as a plain row.
        expect(isVisibleOutsideClosedDisclosure(command)).toBe(true);
      }
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});

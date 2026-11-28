import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { type TranscriptDetail } from "~/appSettings";
import { MessagesTimeline } from "./MessagesTimeline";
import {
  assistantEntry,
  commandEntry,
  createTimelineHost,
  isVisibleOutsideClosedDisclosure,
  reasoningEntry,
  STARTED_AT,
  userEntry,
} from "./MessagesTimeline.testHost";
import type { TimelineEntry } from "../../session-logic";

function Timeline(props: {
  timelineEntries: TimelineEntry[];
  isWorking?: boolean;
  activeTurnInProgress?: boolean;
  transcriptDetail?: TranscriptDetail;
  onEnableComputerControl?: () => void;
}) {
  return (
    <MessagesTimeline
      hasMessages
      isWorking={props.isWorking ?? false}
      activeTurnInProgress={props.activeTurnInProgress ?? false}
      activeTurnStartedAt={STARTED_AT}
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
      {...(props.transcriptDetail ? { transcriptDetail: props.transcriptDetail } : {})}
      {...(props.onEnableComputerControl
        ? { onEnableComputerControl: props.onEnableComputerControl }
        : {})}
    />
  );
}

function reasoningRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-work-entry-reasoning='true']")];
}

function reasoningTrigger(): HTMLButtonElement | null {
  const row = reasoningRows()[0];
  return row?.querySelector<HTMLButtonElement>("button[aria-expanded]") ?? null;
}

function workedForTrigger(): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((button) =>
      (button.textContent ?? "").includes("Worked for"),
    ) ?? null
  );
}

describe("MessagesTimeline reasoning", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("grows one reasoning row as the provider streams it, outside the assistant text", async () => {
    const entries = (detail: string): TimelineEntry[] => [
      userEntry("request", "Fix the adapter"),
      reasoningEntry("trace", detail, "inProgress"),
      assistantEntry("answer", "", { streaming: true }),
    ];
    const screen = await render(
      <Timeline isWorking activeTurnInProgress timelineEntries={entries("Reading the adapter.")} />,
      { container: createTimelineHost() },
    );
    try {
      expect(reasoningRows()).toHaveLength(1);
      await expect.element(screen.getByText("Reading the adapter.", { exact: true })).toBeVisible();

      await screen.rerender(
        <Timeline
          isWorking
          activeTurnInProgress
          timelineEntries={entries("Reading the adapter. Now the mapping.")}
        />,
      );
      await expect.element(reasoningRows()[0]!).toBeVisible();
      await expect
        .element(screen.getByText("Reading the adapter. Now the mapping.", { exact: true }))
        .toBeVisible();
      // The growing trace lives only on the reasoning surface: no rendered text
      // outside it carries the answer's words.
      const renderedOutsideReasoning = [...document.querySelectorAll<HTMLElement>("*")].filter(
        (element) =>
          element.children.length === 0 &&
          (element.textContent ?? "").includes("Now the mapping.") &&
          element.closest("[data-work-entry-reasoning]") === null,
      );
      expect(renderedOutsideReasoning).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });

  it("closes a finished trace and opens the whole of it on click", async () => {
    const detail = "Reading the adapter.\n\nThen the mapping.";
    const screen = await render(
      <Timeline
        isWorking
        activeTurnInProgress
        transcriptDetail="standard"
        timelineEntries={[
          userEntry("request", "Fix the adapter"),
          reasoningEntry("trace", detail, "completed"),
          assistantEntry("answer", "", { streaming: true }),
        ]}
      />,
      { container: createTimelineHost() },
    );
    try {
      expect(reasoningRows()).toHaveLength(1);
      expect(reasoningTrigger()?.getAttribute("aria-expanded")).toBe("false");
      expect(isVisibleOutsideClosedDisclosure("Then the mapping.")).toBe(false);
      await reasoningTrigger()!.click();
      expect(reasoningTrigger()?.getAttribute("aria-expanded")).toBe("true");
      await expect.element(screen.getByText("Then the mapping.", { exact: true })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the conversation alone at the messages level", async () => {
    const entries: TimelineEntry[] = [
      userEntry("request", "Fix the adapter"),
      commandEntry("lint", "bun run lint"),
      reasoningEntry("trace", "Reading the adapter.", "completed"),
      assistantEntry("answer", "Done.", { completedAt: "2026-03-17T19:12:26.000Z" }),
    ];
    const screen = await render(
      <Timeline transcriptDetail="messages" timelineEntries={entries} />,
      { container: createTimelineHost() },
    );
    try {
      await expect.element(screen.getByText("Done.", { exact: true })).toBeVisible();
      expect(reasoningRows()).toHaveLength(0);
      expect(workedForTrigger()).toBeNull();
      expect(isVisibleOutsideClosedDisclosure("bun run lint")).toBe(false);
      expect(isVisibleOutsideClosedDisclosure("Reading the adapter.")).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the enable action visible at the messages level", async () => {
    const enable = vi.fn();
    const entries: TimelineEntry[] = [
      userEntry("request", "Check my desktop"),
      commandEntry("lint", "bun run lint"),
      {
        id: "denied",
        kind: "work",
        createdAt: STARTED_AT,
        entry: {
          id: "denied",
          createdAt: STARTED_AT,
          tone: "error",
          label: "Computer control is off",
          computerControlDenied: { toolName: "computer_click" },
        },
      },
      assistantEntry("answer", "Computer control is off.", {
        completedAt: "2026-03-17T19:12:26.000Z",
      }),
    ];
    const screen = await render(
      <Timeline
        transcriptDetail="messages"
        timelineEntries={entries}
        onEnableComputerControl={enable}
      />,
      { container: createTimelineHost() },
    );
    try {
      await screen.getByRole("button", { name: "Enable", exact: true }).click();
      expect(enable).toHaveBeenCalledOnce();
      expect(isVisibleOutsideClosedDisclosure("bun run lint")).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the trace one click away from the turn at the standard level", async () => {
    const entries: TimelineEntry[] = [
      userEntry("request", "Fix the adapter"),
      commandEntry("lint", "bun run lint"),
      reasoningEntry("trace", "Reading the adapter.\n\nThen the mapping.", "completed"),
      assistantEntry("answer", "Done.", { completedAt: "2026-03-17T19:12:26.000Z" }),
    ];
    const screen = await render(
      <Timeline transcriptDetail="standard" timelineEntries={entries} />,
      { container: createTimelineHost() },
    );
    try {
      await expect.element(screen.getByText("Done.", { exact: true })).toBeVisible();
      expect(isVisibleOutsideClosedDisclosure("Then the mapping.")).toBe(false);
      await expect.poll(() => workedForTrigger() !== null).toBe(true);
      await workedForTrigger()!.click();
      await expect.poll(() => reasoningRows().length).toBe(1);
      await reasoningTrigger()!.click();
      await expect.element(screen.getByText("Then the mapping.", { exact: true })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("closes a trace that settles with the text it last previewed", async () => {
    const trace = "Reading the adapter.";
    const entries = (reasoningStatus: "inProgress" | "completed"): TimelineEntry[] => [
      userEntry("request", "Fix the adapter"),
      reasoningEntry("trace", trace, reasoningStatus),
      assistantEntry("answer", "", { streaming: true }),
    ];
    const screen = await render(
      <Timeline isWorking activeTurnInProgress timelineEntries={entries("inProgress")} />,
      { container: createTimelineHost() },
    );
    try {
      expect(reasoningTrigger()?.getAttribute("aria-expanded")).toBe("true");
      await screen.rerender(
        <Timeline isWorking activeTurnInProgress timelineEntries={entries("completed")} />,
      );
      // A settled trace that repeats its last preview word for word still has to
      // settle in the transcript, not stay open on a memoised preview.
      await expect.poll(() => reasoningTrigger()?.getAttribute("aria-expanded")).toBe("false");
    } finally {
      await screen.unmount();
    }
  });

  it("shows every step of a finished turn at the full level", async () => {
    const entries: TimelineEntry[] = [
      userEntry("request", "Fix the adapter"),
      ...Array.from({ length: 7 }, (_, index) =>
        commandEntry(`check-${index}`, `bun run check-${index}`),
      ),
      reasoningEntry("trace", "Reading the adapter.", "completed"),
      assistantEntry("answer", "Done.", { completedAt: "2026-03-17T19:12:26.000Z" }),
    ];
    const screen = await render(<Timeline transcriptDetail="full" timelineEntries={entries} />, {
      container: createTimelineHost(),
    });
    try {
      await expect.element(screen.getByText("Reading the adapter.", { exact: true })).toBeVisible();
      for (let index = 0; index < 7; index++) {
        await expect
          .element(screen.getByText(`bun run check-${index}`, { exact: true }))
          .toBeVisible();
      }
      expect(workedForTrigger()).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});

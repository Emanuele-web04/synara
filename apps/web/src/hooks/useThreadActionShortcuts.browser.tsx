import { ProjectId, ThreadId } from "@synara/contracts";
import { type ReactNode, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import "../index.css";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../components/ui/preview-card";
import { SnoozeUntilDialog } from "../components/SnoozeUntilDialog";
import { suspendShortcutDispatch } from "../keybindings";
import type { SplitView } from "../splitViewStore";
import type { SidebarThreadSummary } from "../types";
import { makeThread } from "../storeTestFixtures";
import {
  useThreadActionShortcuts,
  type ThreadActionShortcutsInput,
} from "./useThreadActionShortcuts";

const firstId = ThreadId.makeUnsafe("shortcut-first");
const secondId = ThreadId.makeUnsafe("shortcut-second");
const threadById = {
  [firstId]: {
    ...makeThread({ id: firstId }),
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    pendingBackgroundWorkCount: 0,
  },
  [secondId]: {
    ...makeThread({ id: secondId }),
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    pendingBackgroundWorkCount: 0,
  },
} satisfies Record<string, SidebarThreadSummary>;
const panel = {
  panel: null,
  diffTurnId: null,
  diffFilePath: null,
  hasOpenedPanel: false,
  lastOpenPanel: "diff",
} as const;
const splitView: SplitView = {
  id: "shortcut-split",
  sourceThreadId: firstId,
  ownerProjectId: ProjectId.makeUnsafe("shortcut-project"),
  focusedPaneId: "right",
  root: {
    kind: "split",
    id: "split",
    direction: "horizontal",
    ratio: 0.5,
    first: { kind: "leaf", id: "left", threadId: firstId, panel },
    second: { kind: "leaf", id: "right", threadId: secondId, panel },
  },
  createdAt: "2026-10-05T00:00:00Z",
  updatedAt: "2026-10-05T00:00:00Z",
};

let root: Root;
let host: HTMLDivElement;
let archived: ThreadId[];
let unread: ThreadId[];

function Harness({ input, children }: { input: ThreadActionShortcutsInput; children?: ReactNode }) {
  const [snoozeId, setSnoozeId] = useState<ThreadId | null>(null);
  useThreadActionShortcuts({ ...input, onSnooze: setSnoozeId });
  return (
    <>
      <form data-chat-composer-form="true">
        <textarea aria-label="Composer" />
      </form>
      <output>{snoozeId}</output>
      {children}
      <SnoozeUntilDialog
        open={snoozeId !== null}
        currentSnoozedUntil={null}
        onOpenChange={(open) => {
          if (!open) setSnoozeId(null);
        }}
        onSnooze={() => {}}
      />
    </>
  );
}

function renderHarness(overrides: Partial<ThreadActionShortcutsInput> = {}, children?: ReactNode) {
  const input: ThreadActionShortcutsInput = {
    enabled: true,
    keybindings: [],
    routeThreadId: firstId,
    activeSplitView: null,
    threadById,
    terminalStateByThreadId: {},
    canSnooze: () => true,
    onArchive: async (id) => {
      archived.push(id);
    },
    onMarkUnread: (id) => {
      unread.push(id);
    },
    onSnooze: () => {},
    ...overrides,
  };
  flushSync(() => root.render(<Harness input={input}>{children}</Harness>));
}

function press(key: string, overrides: KeyboardEventInit = {}, target: EventTarget = window) {
  const event = new KeyboardEvent("keydown", {
    key,
    code: `Key${key.toUpperCase()}`,
    metaKey: navigator.platform.includes("Mac"),
    ctrlKey: !navigator.platform.includes("Mac"),
    altKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
    ...overrides,
  });
  flushSync(() => target.dispatchEvent(event));
  return event;
}

beforeEach(() => {
  archived = [];
  unread = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("active thread action shortcuts", () => {
  it("archives and marks unread only the focused split pane, including after focus changes", () => {
    renderHarness({ activeSplitView: splitView });
    expect(press("a").defaultPrevented).toBe(true);
    press("u");
    expect(archived).toEqual([secondId]);
    expect(unread).toEqual([secondId]);
    renderHarness({ activeSplitView: { ...splitView, focusedPaneId: "left" } });
    press("u");
    expect(unread).toEqual([secondId, firstId]);
  });

  it("opens the existing snooze picker from the composer without applying a deadline", async () => {
    renderHarness();
    const composer = host.querySelector("textarea")!;
    composer.focus();
    expect(press("s", {}, composer).defaultPrevented).toBe(true);
    await expect
      .poll(() => document.querySelector('[role="dialog"]')?.textContent)
      .toContain("Snooze until");
    expect(document.querySelector('input[type="datetime-local"]')).not.toBeNull();
    expect(host.querySelector("output")?.textContent).toBe(firstId);
    press("a");
    press("u");
    expect(archived).toEqual([]);
    expect(unread).toEqual([]);
  });

  it("leaves active-chat actions idle while an interactive hover card owns focus", async () => {
    renderHarness(
      {},
      <PreviewCard open>
        <PreviewCardTrigger render={<button type="button" />}>
          Review conversations
        </PreviewCardTrigger>
        <PreviewCardPopup>
          <button type="button">Select another conversation</button>
        </PreviewCardPopup>
      </PreviewCard>,
    );
    await expect
      .poll(
        () =>
          document.querySelector('[data-slot="preview-card-popup"]')?.getClientRects().length ?? 0,
      )
      .toBeGreaterThan(0);
    const popup = document.querySelector('[data-slot="preview-card-popup"]')!;
    const action = popup.querySelector("button")!;
    action.focus();
    press("a", {}, action);
    press("u", {}, action);
    press("s", {}, action);
    expect(archived).toEqual([]);
    expect(unread).toEqual([]);
    expect(host.querySelector("output")?.textContent).toBe("");
  });

  it("ignores repeats, composition, prevented events, and suspended dispatch", () => {
    renderHarness();
    press("a", { repeat: true });
    press("u", { isComposing: true });
    const prevented = new KeyboardEvent("keydown", {
      key: "a",
      metaKey: true,
      altKey: true,
      shiftKey: true,
      cancelable: true,
    });
    prevented.preventDefault();
    window.dispatchEvent(prevented);
    const resume = suspendShortcutDispatch();
    try {
      press("a");
    } finally {
      resume();
    }
    expect(archived).toEqual([]);
    expect(unread).toEqual([]);
  });

  it("ignores unavailable actions, missing chats, settings, archived chats, and empty focused panes", () => {
    renderHarness({
      canSnooze: () => false,
      threadById: { [firstId]: { ...threadById[firstId]!, parentThreadId: secondId } },
    });
    press("a");
    press("s");
    expect(archived).toEqual([]);
    expect(host.querySelector("output")?.textContent).toBe("");
    for (const overrides of [
      { enabled: false },
      { routeThreadId: null },
      { threadById: {} },
      {
        threadById: { [firstId]: { ...threadById[firstId]!, archivedAt: "2026-10-05T00:00:00Z" } },
      },
      { activeSplitView: { ...splitView, focusedPaneId: "empty" } },
    ]) {
      renderHarness(overrides);
      press("a");
      press("u");
      press("s");
    }
    expect(archived).toEqual([]);
    expect(unread).toEqual([]);
    expect(host.querySelector("output")?.textContent).toBe("");
  });

  it("honors custom and unassigned bindings", () => {
    renderHarness({
      keybindings: [
        {
          command: "thread.archive",
          shortcut: {
            key: "k",
            ctrlKey: true,
            metaKey: false,
            modKey: false,
            shiftKey: true,
            altKey: false,
          },
        },
        {
          command: "thread.markUnread",
          shortcut: {
            key: "unassigned",
            ctrlKey: false,
            metaKey: false,
            modKey: false,
            shiftKey: false,
            altKey: false,
          },
        },
      ],
    });
    press("a");
    press("u");
    expect(archived).toEqual([]);
    expect(unread).toEqual([]);
    press("k", { ctrlKey: true, metaKey: false, altKey: false });
    expect(archived).toEqual([firstId]);
  });

  it("respects composer conditions and lets composer commands override action defaults", () => {
    const actionShortcut = {
      key: "u",
      modKey: true,
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      shiftKey: true,
    };
    renderHarness({
      keybindings: [
        {
          command: "thread.markUnread",
          shortcut: actionShortcut,
          whenAst: { type: "identifier", name: "composerFocus" },
        },
      ],
    });
    const composer = host.querySelector("textarea")!;
    press("u");
    expect(unread).toEqual([]);
    press("u", {}, composer);
    expect(unread).toEqual([firstId]);
    renderHarness({
      keybindings: [
        {
          command: "thread.markUnread",
          shortcut: actionShortcut,
          whenAst: { type: "not", node: { type: "identifier", name: "composerFocus" } },
        },
      ],
    });
    press("u", {}, composer);
    expect(unread).toEqual([firstId]);
    renderHarness({
      keybindings: [
        {
          command: "model.effort.next",
          shortcut: { ...actionShortcut, key: "a" },
          whenAst: { type: "identifier", name: "composerFocus" },
        },
      ],
    });
    expect(press("a", {}, composer).defaultPrevented).toBe(false);
    expect(archived).toEqual([]);
  });
});

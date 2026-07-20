// FILE: useChatAutomationSetup.test.ts
// Purpose: Characterizes automation draft restoration and edit-dialog initialization.
// Layer: Chat automation setup hook tests

import { ThreadId, type AutomationDefinition } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reactHarness = vi.hoisted(() => {
  interface HookSlot {
    value?: unknown;
    deps?: readonly unknown[];
    cleanup?: (() => void) | undefined;
  }

  let slots: HookSlot[] = [];
  let cursor = 0;

  const nextSlot = () => {
    const index = cursor;
    cursor += 1;
    slots[index] ??= {};
    return slots[index]!;
  };
  const depsEqual = (left: readonly unknown[] | undefined, right: readonly unknown[]) =>
    left !== undefined &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));
  const useEffect = (effect: () => void | (() => void), deps: readonly unknown[]) => {
    const slot = nextSlot();
    if (depsEqual(slot.deps, deps)) return;
    slot.cleanup?.();
    slot.deps = deps;
    slot.cleanup = effect() ?? undefined;
  };

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      slots = [];
      cursor = 0;
    },
    unmount() {
      for (const slot of slots) slot.cleanup?.();
      slots = [];
      cursor = 0;
    },
    useCallback<T extends (...args: never[]) => unknown>(callback: T, deps: readonly unknown[]): T {
      const slot = nextSlot();
      if (!depsEqual(slot.deps, deps)) {
        slot.deps = deps;
        slot.value = callback;
      }
      return slot.value as T;
    },
    useEffect,
    useLayoutEffect: useEffect,
    useRef<T>(initialValue: T) {
      const slot = nextSlot();
      slot.value ??= { current: initialValue };
      return slot.value as { current: T };
    },
    useState<T>(initialValue: T | (() => T)) {
      const slot = nextSlot();
      if (!("value" in slot)) {
        slot.value =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue = (next: T | ((current: T) => T)) => {
        slot.value =
          typeof next === "function" ? (next as (current: T) => T)(slot.value as T) : next;
      };
      return [slot.value as T, setValue] as const;
    },
  };
});

const automationMocks = vi.hoisted(() => ({
  buildAutomationDraftWarnings: vi.fn(),
  buildAutomationFormWarnings: vi.fn(),
  formFromDefinition: vi.fn(),
  scheduleFromForm: vi.fn(),
  warningIdsForAcknowledgedRisks: vi.fn(),
}));

const storeState = vi.hoisted(() => ({
  projects: [{ id: "project-fallback" }],
  threads: [{ id: "thread-a" }],
}));

vi.mock("react", () => ({
  useCallback: reactHarness.useCallback,
  useEffect: reactHarness.useEffect,
  useLayoutEffect: reactHarness.useLayoutEffect,
  useRef: reactHarness.useRef,
  useState: reactHarness.useState,
}));

vi.mock("../../routes/-automations.shared", () => ({
  buildAutomationFormWarnings: automationMocks.buildAutomationFormWarnings,
  formFromDefinition: automationMocks.formFromDefinition,
  scheduleFromForm: automationMocks.scheduleFromForm,
  useAutomations: () => ({
    data: { definitions: [], runs: [] },
    updateMutation: { mutate: vi.fn() },
  }),
}));

vi.mock("../../lib/automationDraft", () => ({
  buildAutomationDraftWarnings: automationMocks.buildAutomationDraftWarnings,
  updateAutomationDraftWarningAcknowledgement: (
    current: ReadonlySet<string>,
    id: string,
    checked: boolean,
  ) => {
    const next = new Set(current);
    if (checked) next.add(id);
    else next.delete(id);
    return next;
  },
  warningIdsForAcknowledgedRisks: automationMocks.warningIdsForAcknowledgedRisks,
}));

vi.mock("../../storeSelectors", () => ({
  createAllThreadsSelector: () => (state: typeof storeState) => state.threads,
}));

vi.mock("../../store", () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

import { useChatAutomationSetup } from "./useChatAutomationSetup";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");
const EDIT_DEFINITION = {
  id: "automation-a",
  projectId: null,
  acknowledgedRisks: ["full-access"],
} as unknown as AutomationDefinition;
const EDIT_FORM = { prompt: "saved prompt", mode: "standalone" } as never;
const UPDATED_EDIT_FORM = { prompt: "updated prompt", mode: "standalone" } as never;
const EDIT_WARNING = {
  id: "full-access",
  title: "Full access",
  detail: "Review access",
  requiresAcknowledgement: true,
} as const;

describe("useChatAutomationSetup", () => {
  const promptRef = { current: "" };
  const setComposerDraftPrompt = vi.fn();
  let threadId = THREAD_A;

  const render = () => {
    reactHarness.beginRender();
    return useChatAutomationSetup({
      threadId,
      activeProjectId: "active-project",
      hasLiveTurn: false,
      promptRef,
      setComposerDraftPrompt,
    });
  };

  beforeEach(() => {
    reactHarness.reset();
    threadId = THREAD_A;
    promptRef.current = "";
    setComposerDraftPrompt.mockReset();
    automationMocks.buildAutomationDraftWarnings.mockReset().mockReturnValue([]);
    automationMocks.buildAutomationFormWarnings.mockReset().mockReturnValue([EDIT_WARNING]);
    automationMocks.formFromDefinition.mockReset().mockReturnValue(EDIT_FORM);
    automationMocks.scheduleFromForm.mockReset().mockReturnValue({ type: "manual" });
    automationMocks.warningIdsForAcknowledgedRisks
      .mockReset()
      .mockReturnValue(new Set(["full-access"]));
  });

  it("restores accumulated setup text plus the typed prompt when the thread changes", () => {
    let result = render();
    result.setPendingAutomationConversation({
      threadId: THREAD_A,
      accumulatedMessage: "Create a daily summary",
      bubbles: [],
    });
    promptRef.current = "include pull requests";
    result = render();

    threadId = THREAD_B;
    result = render();

    expect(setComposerDraftPrompt).toHaveBeenCalledTimes(1);
    expect(setComposerDraftPrompt).toHaveBeenCalledWith(
      THREAD_A,
      "Create a daily summary\ninclude pull requests",
    );
    expect(result.pendingAutomationConversationRef.current).toBeNull();
  });

  it("restores accumulated setup text plus the typed prompt on unmount", () => {
    let result = render();
    result.setPendingAutomationConversation({
      threadId: THREAD_A,
      accumulatedMessage: "Run the release checks",
      bubbles: [],
    });
    promptRef.current = "every Friday";
    result = render();

    reactHarness.unmount();

    expect(setComposerDraftPrompt).toHaveBeenCalledTimes(1);
    expect(setComposerDraftPrompt).toHaveBeenCalledWith(
      THREAD_A,
      "Run the release checks\nevery Friday",
    );
  });

  it("initializes edit state, acknowledgements, and edit-specific warnings", () => {
    let result = render();

    result.openAutomationEditDialog(EDIT_DEFINITION);
    result = render();

    expect(automationMocks.formFromDefinition).toHaveBeenCalledWith(
      EDIT_DEFINITION,
      "active-project",
    );
    expect(result.automationDraftOpen).toBe(true);
    expect(result.automationEditingDefinition).toBe(EDIT_DEFINITION);
    expect(result.automationDraftForm).toBe(EDIT_FORM);
    expect(result.automationDraftWarnings).toEqual([EDIT_WARNING]);
    expect(result.acknowledgedAutomationWarnings).toEqual(new Set(["full-access"]));

    automationMocks.buildAutomationFormWarnings.mockClear().mockReturnValue([]);
    result.updateAutomationDraftForm(UPDATED_EDIT_FORM);
    result = render();

    expect(automationMocks.buildAutomationFormWarnings).toHaveBeenCalledWith(UPDATED_EDIT_FORM);
    expect(automationMocks.buildAutomationDraftWarnings).not.toHaveBeenCalled();
    expect(result.automationDraftWarnings).toEqual([]);
  });
});

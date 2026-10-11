import { ThreadId } from "@synara/contracts";
import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import "../index.css";

const route = vi.hoisted(() => ({ threadId: "another-thread", navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => route.navigate,
  useParams: () => ThreadId.makeUnsafe(route.threadId),
}));
vi.mock("../hooks/useDiffRouteSearch", () => ({ useDiffRouteSearch: () => ({}) }));
vi.mock("../appSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../appSettings")>()),
  useAppSettings: () => ({
    settings: {
      enableTaskCompletionToasts: true,
      enableSystemTaskCompletionNotifications: false,
    },
  }),
}));

import { TaskCompletionNotifications } from "../notifications/taskCompletion";
import { useStore } from "../store";
import { initialState } from "../storeState";
import { makeReadModel, makeReadModelThread } from "../storeTestFixtures";
import { ToastProvider, toastManager } from "./ui/toast";

const reminderAt = "2026-02-27T09:00:00.000Z";
const title = "Review the deferred change";
const body = "Ready to pick this thread back up.";

let root: Root;
let host: HTMLDivElement;
let threadId: ThreadId;
let snapshotSequence: number;
let toastIds: Array<ReturnType<typeof toastManager.add>>;
let addToast: MockInstance<typeof toastManager.add>;

function receiptKey() {
  return `synara:snooze-reminder:v1:${threadId}`;
}

function syncReminder(at = reminderAt, threadTitle = title) {
  const snapshot = makeReadModel(
    makeReadModelThread({
      id: threadId,
      title: threadTitle,
      snoozedUntil: null,
      snoozeReminderAt: at,
    }),
  );
  flushSync(() =>
    useStore.getState().syncServerReadModel({
      ...snapshot,
      snapshotSequence: ++snapshotSequence,
    }),
  );
}

function renderRuntime() {
  flushSync(() =>
    root.render(
      <StrictMode>
        <ToastProvider>
          <TaskCompletionNotifications />
        </ToastProvider>
      </StrictMode>,
    ),
  );
}

function closeToasts() {
  flushSync(() => {
    for (const id of toastIds) toastManager.close(id);
  });
}

async function expectReminderToast(threadTitle = title) {
  await expect
    .poll(() => document.querySelector('[data-slot="toast-title"]')?.textContent)
    .toBe(threadTitle);
  expect(document.querySelector('[data-slot="toast-description"]')?.textContent).toBe(body);
}

beforeEach(() => {
  threadId = ThreadId.makeUnsafe(`snooze-browser-${crypto.randomUUID()}`);
  snapshotSequence = 0;
  toastIds = [];
  route.threadId = "another-thread";
  route.navigate.mockReset();
  useStore.setState(initialState);
  const realAdd = toastManager.add.bind(toastManager);
  addToast = vi.spyOn(toastManager, "add").mockImplementation((options) => {
    const id = realAdd(options);
    toastIds.push(id);
    return id;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  closeToasts();
  flushSync(() => root.unmount());
  host.remove();
  window.localStorage.removeItem(receiptKey());
  useStore.setState(initialState);
  vi.restoreAllMocks();
});

describe("snooze reminder notifications", () => {
  it("renders an initial overdue reminder once in StrictMode and opens its thread", async () => {
    syncReminder();
    renderRuntime();
    await expectReminderToast();
    expect(addToast).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem(receiptKey())).toBe(reminderAt);

    const open = document.querySelector<HTMLButtonElement>(`button[aria-label="Open ${title}"]`);
    expect(open).not.toBeNull();
    flushSync(() => open!.click());
    expect(route.navigate).toHaveBeenCalledOnce();
    const navigation = route.navigate.mock.calls[0]![0];
    expect(navigation.to).toBe("/$threadId");
    expect(navigation.params).toEqual({ threadId });
    expect(navigation.search({ splitViewId: "old-pair", view: "editor" })).toEqual({
      splitViewId: undefined,
      view: "editor",
    });
  });

  it("waits for hydration before showing or claiming a cached reminder", async () => {
    syncReminder();
    useStore.setState({ threadsHydrated: false });
    renderRuntime();
    await Promise.resolve();
    expect(addToast).not.toHaveBeenCalled();
    expect(document.querySelector('[data-slot="toast-title"]')).toBeNull();
    expect(window.localStorage.getItem(receiptKey())).toBeNull();

    flushSync(() => useStore.setState({ threadsHydrated: true }));
    await expectReminderToast();
    expect(addToast).toHaveBeenCalledOnce();
  });

  it("keeps a delivered reminder deduplicated after updates and a fresh runtime mount", async () => {
    syncReminder();
    renderRuntime();
    await expectReminderToast();
    syncReminder(reminderAt, "Updated thread title");
    await Promise.resolve();
    expect(addToast).toHaveBeenCalledOnce();

    closeToasts();
    flushSync(() => root.unmount());
    // Reset normalized state as a reload does, keeping the real localStorage receipt.
    useStore.setState(initialState);
    syncReminder();
    root = createRoot(host);
    renderRuntime();
    await Promise.resolve();
    expect(addToast).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-slot="toast-title"]')).toBeNull();
    expect(window.localStorage.getItem(receiptKey())).toBe(reminderAt);
  });

  it("shows a new reminder identity for the same thread", async () => {
    syncReminder();
    renderRuntime();
    await expectReminderToast();

    const nextReminderAt = "2026-02-28T09:00:00.000Z";
    syncReminder(nextReminderAt);
    await expect.poll(() => addToast.mock.calls.length).toBe(2);
    expect(window.localStorage.getItem(receiptKey())).toBe(nextReminderAt);
    await expect.poll(() => document.querySelectorAll('[data-slot="toast-title"]').length).toBe(2);
  });
});

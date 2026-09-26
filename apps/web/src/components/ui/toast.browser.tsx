import { ThreadId } from "@synara/contracts";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../../index.css";

const route = vi.hoisted(() => ({ threadId: "toast-thread" }));
vi.mock("@tanstack/react-router", () => ({ useParams: () => route.threadId }));
vi.mock("../../hooks/useDiffRouteSearch", () => ({ useDiffRouteSearch: () => ({}) }));

import { ToastProvider, toastManager } from "./toast";

let root: Root;
let host: HTMLDivElement;

function renderToasts() {
  flushSync(() =>
    root.render(
      <ToastProvider>
        <button data-testid="outside">Outside the toast</button>
      </ToastProvider>,
    ),
  );
}

function dismissButton(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>('[data-slot="toast-close"]')!;
}

function addTimedToast(onClose: () => void) {
  flushSync(() =>
    toastManager.add({
      title: "Thread notice",
      timeout: 0,
      onClose,
      data: { threadId: ThreadId.makeUnsafe("toast-thread"), dismissAfterVisibleMs: 1_000 },
    }),
  );
}

beforeEach(() => {
  route.threadId = "toast-thread";
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  renderToasts();
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("toast focus and visible lifetime", () => {
  it("pauses while a toast control has focus and resumes the remaining visible time", async () => {
    const onClose = vi.fn();
    addTimedToast(onClose);
    await vi.advanceTimersByTimeAsync(400);
    dismissButton().focus();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onClose).not.toHaveBeenCalled();

    host.querySelector<HTMLButtonElement>("button")!.focus();
    await vi.advanceTimersByTimeAsync(599);
    expect(onClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not restart a hidden thread's timer from a queued focus event", async () => {
    const onClose = vi.fn();
    addTimedToast(onClose);
    dismissButton().focus();
    await Promise.resolve();

    // Focusing navigation and changing route can happen in the same event.
    host.querySelector<HTMLButtonElement>("button")!.focus();
    route.threadId = "another-thread";
    renderToasts();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onClose).not.toHaveBeenCalled();

    route.threadId = "toast-thread";
    renderToasts();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps the dismiss control accessible while focused and runs its callback once", async () => {
    const onClose = vi.fn();
    flushSync(() => toastManager.add({ title: "Notice", timeout: 0, data: { onClose } }));
    const button = dismissButton();
    flushSync(() => button.focus());
    expect(button.getAttribute("aria-hidden")).not.toBe("true");
    flushSync(() => button.click());
    await Promise.resolve();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("waits for archive undo, then clears focus before closing", async () => {
    let finishUndo!: (restored: boolean) => void;
    const onClose = vi.fn();
    const onNoUndo = vi.fn();
    flushSync(() =>
      toastManager.add({
        timeout: 0,
        onClose,
        data: {
          dismissAfterVisibleMs: 1_000,
          archiveUndo: {
            onUndo: () =>
              new Promise<boolean>((resolve) => {
                finishUndo = resolve;
              }),
            onViewArchived: () => {},
            onNoUndo,
          },
        },
      }),
    );
    const undo = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Undo",
    )!;
    flushSync(() => {
      undo.focus();
      undo.click();
    });
    expect(dismissButton().disabled).toBe(true);
    dismissButton().click();
    expect(onNoUndo).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onClose).not.toHaveBeenCalled();
    finishUndo(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onNoUndo).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(undo);
  });

  it("shows the dismiss control as disabled while archive undo is pending", () => {
    flushSync(() =>
      toastManager.add({
        timeout: 0,
        data: {
          archiveUndo: {
            onUndo: () => new Promise<boolean>(() => {}),
            onViewArchived: () => {},
            onNoUndo: () => {},
          },
        },
      }),
    );
    const undo = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Undo",
    )!;
    flushSync(() => undo.click());
    const button = dismissButton();
    expect(button.disabled).toBe(true);
    expect(getComputedStyle(button).pointerEvents).toBe("none");
    expect(getComputedStyle(button).opacity).toBe("0.55");
  });

  it("starts archive cleanup only after the Undo toast's visible lifetime", async () => {
    const onNoUndo = vi.fn();
    flushSync(() =>
      toastManager.add({
        timeout: 0,
        data: {
          dismissAfterVisibleMs: 1_000,
          archiveUndo: { onUndo: () => true, onViewArchived: () => {}, onNoUndo },
        },
      }),
    );
    dismissButton().focus();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onNoUndo).not.toHaveBeenCalled();
    host.querySelector<HTMLButtonElement>('button[data-testid="outside"]')!.focus();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onNoUndo).toHaveBeenCalledOnce();
  });
});

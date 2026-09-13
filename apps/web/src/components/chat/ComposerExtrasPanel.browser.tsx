// FILE: ComposerExtrasPanel.browser.tsx
// Purpose: Verifies the composer `+` panel exposes generic file uploads, quick mode toggles, and the AppSnap window picker.
// Layer: Browser UI test
// Depends on: vitest browser rendering helpers and the ComposerExtrasPanel component.

import "../../index.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type {
  DesktopAppSnapCapture,
  DesktopAppSnapState,
  ProviderInteractionMode,
  ThreadId,
} from "@synara/contracts";

const harness = vi.hoisted(() => ({
  insertAppSnapCaptureIntoDraft: vi.fn(),
  toastAdd: vi.fn(),
}));

vi.mock("~/appSnapIntake", () => ({
  insertAppSnapCaptureIntoDraft: harness.insertAppSnapCaptureIntoDraft,
}));

vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: harness.toastAdd },
}));

import { ComposerExtrasPanel } from "./ComposerExtrasPanel";

const threadId = "thread-1" as ThreadId;

const READY_STATE: DesktopAppSnapState = {
  platform: "macos",
  supported: true,
  enabled: true,
  status: "ready",
  shortcut: { kind: "both-option-keys" },
  inputMonitoringPermission: "granted",
  screenRecordingPermission: "granted",
  message: null,
};

const CAPTURE: DesktopAppSnapCapture = {
  id: "capture-1",
  capturedAt: "2026-09-02T10:00:00.000Z",
  name: "AppSnap-capture-1.png",
  mimeType: "image/png",
  sizeBytes: 5,
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]),
  sourceAppName: "Ghostty",
  sourceBundleIdentifier: "com.mitchellh.ghostty",
  sourceAppIconDataUrl: null,
  sourceWindowTitle: "dev",
};

function setDesktopBridge(value: unknown): void {
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value,
  });
}

function appSnapBridge(overrides: {
  getState?: () => Promise<DesktopAppSnapState>;
  listWindows?: () => Promise<
    Array<{
      windowId: number;
      appName: string | null;
      bundleIdentifier: string | null;
      windowTitle: string | null;
      appIconDataUrl: string | null;
    }>
  >;
  captureWindow?: (input: { windowId: number }) => Promise<DesktopAppSnapCapture>;
  acknowledgeCapture?: (captureId: string) => Promise<void>;
  onState?: (listener: (state: DesktopAppSnapState) => void) => () => void;
}) {
  return {
    appSnap: {
      getState: overrides.getState ?? (() => Promise.resolve(READY_STATE)),
      listWindows:
        overrides.listWindows ??
        (() =>
          Promise.resolve([
            {
              windowId: 42,
              appName: "Ghostty",
              bundleIdentifier: "com.mitchellh.ghostty",
              windowTitle: "dev",
              appIconDataUrl: null,
            },
            {
              windowId: 43,
              appName: "Finder",
              bundleIdentifier: "com.apple.finder",
              windowTitle: null,
              appIconDataUrl: null,
            },
          ])),
      captureWindow: overrides.captureWindow ?? (() => Promise.resolve(CAPTURE)),
      acknowledgeCapture: overrides.acknowledgeCapture ?? (() => Promise.resolve()),
      onState: overrides.onState ?? (() => () => undefined),
    },
  };
}

async function mountMenu(props?: {
  fastModeEnabled?: boolean;
  interactionMode?: ProviderInteractionMode;
  supportsFastMode?: boolean;
  threadId?: ThreadId;
}) {
  const onAddAttachments = vi.fn();
  const onToggleFastMode = vi.fn();
  const onInteractionModeChange = vi.fn();
  const onInsertGoal = vi.fn();
  const onClose = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <ComposerExtrasPanel
      panelId="composer-extras-panel"
      interactionMode={props?.interactionMode ?? "default"}
      supportsFastMode={props?.supportsFastMode ?? true}
      fastModeEnabled={props?.fastModeEnabled ?? false}
      {...(props?.threadId !== undefined ? { threadId: props.threadId } : {})}
      onAddAttachments={onAddAttachments}
      onToggleFastMode={onToggleFastMode}
      onInteractionModeChange={onInteractionModeChange}
      onInsertGoal={onInsertGoal}
      onClose={onClose}
    />,
    { container: host },
  );

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
    onAddAttachments,
    onToggleFastMode,
    onInteractionModeChange,
    onInsertGoal,
    onClose,
  };
}

const otherWindowsButton = () => page.getByRole("button", { name: "Choose another window" });

describe("ComposerExtrasPanel", () => {
  beforeEach(() => {
    harness.insertAppSnapCaptureIntoDraft.mockReset().mockResolvedValue("persisted");
    harness.toastAdd.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    setDesktopBridge(undefined);
  });

  it("uses an unrestricted file picker and forwards every selected file", async () => {
    await using menu = await mountMenu();

    const input = document.querySelector<HTMLInputElement>("[data-testid='composer-file-input']");
    expect(input).not.toBeNull();
    expect(input?.hasAttribute("accept")).toBe(false);

    const files = new DataTransfer();
    files.items.add(new File(["photo"], "photo.png", { type: "image/png" }));
    files.items.add(new File(["document"], "document.pdf", { type: "application/pdf" }));
    Object.defineProperty(input, "files", {
      configurable: true,
      value: files.files,
    });
    input?.dispatchEvent(new Event("change", { bubbles: true }));

    expect(menu.onAddAttachments).toHaveBeenCalledTimes(1);
    expect(menu.onAddAttachments.mock.calls[0]?.[0]?.map((file: File) => file.name)).toEqual([
      "photo.png",
      "document.pdf",
    ]);
  });

  it("lists every composer extra as one flat Add list", async () => {
    await using _ = await mountMenu({ interactionMode: "plan", fastModeEnabled: true });

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Files and folders");
      expect(text).toContain("Goal");
      expect(text).toContain("Turn plan mode off");
      expect(text).toContain("Turn debug mode on");
      expect(text).toContain("Turn fast mode off");
      expect(text).not.toContain("Speed");
      expect(document.querySelectorAll("[data-slot='command-group-label']")).toHaveLength(1);
    });
  });

  it("toggles the interaction mode and closes", async () => {
    await using menu = await mountMenu({ interactionMode: "debug" });

    await page.getByText("Plan mode", { exact: true }).click();
    expect(menu.onInteractionModeChange).toHaveBeenLastCalledWith("plan");

    await page.getByText("Debug mode", { exact: true }).click();
    expect(menu.onInteractionModeChange).toHaveBeenLastCalledWith("default");
    expect(menu.onClose).toHaveBeenCalledTimes(2);
  });

  it("inserts the goal command and closes", async () => {
    await using menu = await mountMenu();

    await page.getByText("Set a goal to keep pursuing").click();

    expect(menu.onInsertGoal).toHaveBeenCalledTimes(1);
    expect(menu.onClose).toHaveBeenCalledTimes(1);
  });

  it("wires the speed control", async () => {
    await using menu = await mountMenu();

    await page.getByText("Fast mode", { exact: true }).click();

    expect(menu.onToggleFastMode).toHaveBeenCalledTimes(1);
    expect(menu.onClose).toHaveBeenCalledTimes(1);
  });

  it("hides the AppSnap window picker without a desktop bridge", async () => {
    await using _ = await mountMenu({ threadId });

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Files and folders");
      expect(text).not.toContain("Attach window");
    });
  });

  it("captures the frontmost app window straight from the root row", async () => {
    const captureWindow = vi.fn(() => Promise.resolve(CAPTURE));
    const acknowledgeCapture = vi.fn(() => Promise.resolve());
    setDesktopBridge(appSnapBridge({ captureWindow, acknowledgeCapture }));
    await using menu = await mountMenu({ threadId });

    await expect.element(page.getByText("Attach Ghostty")).toBeVisible();
    expect(document.body.textContent ?? "").not.toContain("Finder");

    await page.getByText("Attach Ghostty").click();

    await vi.waitFor(() => {
      expect(captureWindow).toHaveBeenCalledWith({ windowId: 42 });
      expect(harness.insertAppSnapCaptureIntoDraft).toHaveBeenCalledWith(threadId, CAPTURE);
      expect(acknowledgeCapture).toHaveBeenCalledWith("capture-1");
      expect(harness.toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ type: "success", title: "AppSnap added" }),
      );
    });
    expect(menu.onClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "prefers its titled document over an untitled overlay",
      titled: true,
      identity: true,
      expected: 44,
    },
    {
      name: "keeps its untitled window instead of another app's document",
      titled: false,
      identity: true,
      expected: 42,
    },
    {
      name: "does not guess an app identity from a shared name",
      titled: true,
      identity: false,
      expected: 42,
    },
  ])("$name", async ({ titled, identity, expected }) => {
    const captureWindow = vi.fn(() => Promise.resolve(CAPTURE));
    const frontmost = {
      windowId: 42,
      appName: "Ghostty",
      bundleIdentifier: identity ? "com.mitchellh.ghostty" : null,
      windowTitle: null,
      appIconDataUrl: null,
    };
    setDesktopBridge(
      appSnapBridge({
        captureWindow,
        listWindows: async () => [
          frontmost,
          {
            ...frontmost,
            windowId: 43,
            bundleIdentifier: "com.apple.finder",
            windowTitle: "Downloads",
          },
          { ...frontmost, windowId: 44, windowTitle: titled ? "dev" : null },
        ],
      }),
    );
    await using menu = await mountMenu({ threadId });

    await page.getByText("Attach Ghostty").click();

    await vi.waitFor(() => expect(captureWindow).toHaveBeenCalledWith({ windowId: expected }));
    expect(menu.onClose).toHaveBeenCalledTimes(1);
  });

  it("opens the full window list from the row's arrow and captures the picked window", async () => {
    const captureWindow = vi.fn(() => Promise.resolve(CAPTURE));
    setDesktopBridge(appSnapBridge({ captureWindow }));
    await using menu = await mountMenu({ threadId });

    await expect.element(page.getByText("Attach Ghostty")).toBeVisible();
    await otherWindowsButton().click();
    expect(captureWindow).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Back");
      expect(text).toContain("Ghostty");
      expect(text).toContain("Finder");
    });
    await page.getByText("Finder").click();

    await vi.waitFor(() => {
      expect(captureWindow).toHaveBeenCalledWith({ windowId: 43 });
    });
    expect(menu.onClose).toHaveBeenCalledTimes(1);
  });

  it("opens the window list with ArrowRight and returns with ArrowLeft", async () => {
    setDesktopBridge(appSnapBridge({}));
    await using _ = await mountMenu({ threadId });

    await expect.element(page.getByText("Attach Ghostty")).toBeVisible();
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(page.getByText("Finder")).toBeVisible();

    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(page.getByText("Attach Ghostty")).toBeVisible();
    expect(document.body.textContent ?? "").not.toContain("Finder");
  });

  it("keeps the desktop recovery copy when draft persistence is unverified", async () => {
    harness.insertAppSnapCaptureIntoDraft.mockResolvedValue("unverified");
    const acknowledgeCapture = vi.fn(() => Promise.resolve());
    setDesktopBridge(appSnapBridge({ acknowledgeCapture }));
    await using _ = await mountMenu({ threadId });

    await otherWindowsButton().click();
    await expect.element(page.getByText("Ghostty")).toBeVisible();
    await page.getByText("Ghostty").click();

    await vi.waitFor(() => {
      expect(harness.insertAppSnapCaptureIntoDraft).toHaveBeenCalledWith(threadId, CAPTURE);
      expect(acknowledgeCapture).not.toHaveBeenCalled();
      expect(harness.toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ type: "warning", title: "AppSnap added with a warning" }),
      );
    });
  });

  it("does not send a list request while AppSnap is disabled", async () => {
    const listWindows = vi.fn(() => Promise.resolve([]));
    setDesktopBridge(
      appSnapBridge({
        getState: () =>
          Promise.resolve({
            ...READY_STATE,
            enabled: false,
            status: "disabled",
          }),
        listWindows,
      }),
    );
    await using _ = await mountMenu({ threadId });

    await page.getByText("Attach window").click();

    await expect.element(page.getByText("Enable AppSnap in Settings")).toBeVisible();
    expect(listWindows).not.toHaveBeenCalled();
  });

  it("lists windows when AppSnap becomes ready while the picker is open", async () => {
    let emitState: ((state: DesktopAppSnapState) => void) | undefined;
    const unsubscribe = vi.fn();
    const listWindows = vi.fn(() =>
      Promise.resolve([
        {
          windowId: 42,
          appName: "Ghostty",
          bundleIdentifier: "com.mitchellh.ghostty",
          windowTitle: "dev",
          appIconDataUrl: null,
        },
      ]),
    );
    setDesktopBridge(
      appSnapBridge({
        getState: () => Promise.resolve({ ...READY_STATE, status: "starting" }),
        listWindows,
        onState: (listener) => {
          emitState = listener;
          return unsubscribe;
        },
      }),
    );
    const menu = await mountMenu({ threadId });

    await page.getByText("Attach window").click();
    await expect.element(page.getByText("AppSnap is starting…")).toBeVisible();
    expect(listWindows).not.toHaveBeenCalled();

    emitState?.(READY_STATE);

    await expect.element(page.getByText("Ghostty")).toBeVisible();
    expect(listWindows).toHaveBeenCalledOnce();

    await menu.cleanup();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("retries a failed window list once on a later ready state", async () => {
    let emitState: ((state: DesktopAppSnapState) => void) | undefined;
    const listWindows = vi
      .fn()
      .mockRejectedValueOnce(new Error("Could not list windows."))
      .mockResolvedValueOnce([
        {
          windowId: 42,
          appName: "Ghostty",
          bundleIdentifier: "com.mitchellh.ghostty",
          windowTitle: "dev",
          appIconDataUrl: null,
        },
      ]);
    setDesktopBridge(
      appSnapBridge({
        listWindows,
        onState: (listener) => {
          emitState = listener;
          return () => undefined;
        },
      }),
    );
    await using _ = await mountMenu({ threadId });

    await page.getByText("Attach window").click();
    await expect.element(page.getByText("Could not list windows.")).toBeVisible();

    emitState?.(READY_STATE);

    await expect.element(page.getByText("Ghostty")).toBeVisible();
    expect(listWindows).toHaveBeenCalledTimes(2);
    emitState?.(READY_STATE);
    expect(listWindows).toHaveBeenCalledTimes(2);
  });

  it("keeps the list error after the bounded ready-state retry is exhausted", async () => {
    let emitState: ((state: DesktopAppSnapState) => void) | undefined;
    const listWindows = vi.fn(() => Promise.reject(new Error("Could not list windows.")));
    setDesktopBridge(
      appSnapBridge({
        listWindows,
        onState: (listener) => {
          emitState = listener;
          return () => undefined;
        },
      }),
    );
    await using _ = await mountMenu({ threadId });

    await page.getByText("Attach window").click();
    await expect.element(page.getByText("Could not list windows.")).toBeVisible();

    emitState?.(READY_STATE);
    await vi.waitFor(() => expect(listWindows).toHaveBeenCalledTimes(2));
    await expect.element(page.getByText("Could not list windows.")).toBeVisible();

    emitState?.(READY_STATE);
    expect(listWindows).toHaveBeenCalledTimes(2);
    await expect.element(page.getByText("Could not list windows.")).toBeVisible();
  });
});

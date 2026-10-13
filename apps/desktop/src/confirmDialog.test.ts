import type { BrowserWindow } from "electron";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { showMessageBoxMock } = vi.hoisted(() => ({
  showMessageBoxMock: vi.fn(),
}));

vi.mock("electron", () => ({
  dialog: {
    showMessageBox: showMessageBoxMock,
  },
}));

import { guardDesktopWindowClose, showDesktopConfirmDialog } from "./confirmDialog";
import { initializeDesktopI18n, t } from "./i18n";

describe("showDesktopConfirmDialog", () => {
  beforeEach(() => {
    showMessageBoxMock.mockReset();
    initializeDesktopI18n("en", () => "en-US");
  });

  it("uses Spanish buttons while leaving the caller's message untouched", async () => {
    initializeDesktopI18n("es", () => "en-US");
    showMessageBoxMock.mockResolvedValue({ response: 1 });
    await expect(showDesktopConfirmDialog("Raw provider message", null)).resolves.toBe(true);
    expect(showMessageBoxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: ["No", "Sí"],
        message: "Raw provider message",
        defaultId: 1,
        cancelId: 0,
      }),
    );
  });

  it("returns false and does not open a dialog for empty messages", async () => {
    const result = await showDesktopConfirmDialog("   ", null);

    expect(result).toBe(false);
    expect(showMessageBoxMock).not.toHaveBeenCalled();
  });

  it("opens a dialog for the focused window and returns true on confirm", async () => {
    const ownerWindow = { id: 1 } as BrowserWindow;
    showMessageBoxMock.mockResolvedValue({ response: 1 });

    const result = await showDesktopConfirmDialog("Delete worktree?", ownerWindow);

    expect(result).toBe(true);
    expect(showMessageBoxMock).toHaveBeenCalledWith(
      ownerWindow,
      expect.objectContaining({
        buttons: ["No", "Yes"],
        message: "Delete worktree?",
      }),
    );
  });

  it("opens an app-level dialog when there is no focused window", async () => {
    showMessageBoxMock.mockResolvedValue({ response: 0 });

    const result = await showDesktopConfirmDialog("Delete worktree?", null);

    expect(result).toBe(false);
    expect(showMessageBoxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: ["No", "Yes"],
        message: "Delete worktree?",
      }),
    );
  });
});

describe("guardDesktopWindowClose", () => {
  beforeEach(() => {
    showMessageBoxMock.mockReset();
    initializeDesktopI18n("en", () => "en-US");
  });

  it("resolves a translated close message when closing, after a language change", async () => {
    const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, close: vi.fn() });
    guardDesktopWindowClose(
      window as unknown as BrowserWindow,
      () => t("Quit {{app}}?", { app: "Synara" }),
      () => true,
    );
    initializeDesktopI18n("es", () => "en-US");
    showMessageBoxMock.mockResolvedValue({ response: 0 });
    window.emit("close", { preventDefault: vi.fn() });
    await vi.waitFor(() =>
      expect(showMessageBoxMock).toHaveBeenCalledWith(
        window,
        expect.objectContaining({ message: "¿Salir de Synara?", buttons: ["No", "Sí"] }),
      ),
    );
  });

  function createWindow(shouldConfirm = () => true) {
    const window = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      close: vi.fn(() => {
        const event = { preventDefault: vi.fn() };
        window.emit("close", event);
        return event;
      }),
    });
    guardDesktopWindowClose(
      window as unknown as BrowserWindow,
      "Close the Synara window?",
      shouldConfirm,
    );
    return window;
  }

  it("keeps the window open on cancel and asks again before allowing one close", async () => {
    showMessageBoxMock
      .mockResolvedValueOnce({ response: 0 })
      .mockResolvedValueOnce({ response: 1 });
    const window = createWindow();
    expect(window.close().preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(showMessageBoxMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.close).toHaveBeenCalledTimes(1);
    window.close();
    await vi.waitFor(() => expect(window.close).toHaveBeenCalledTimes(3));
    expect(window.close.mock.results[2]?.value.preventDefault).not.toHaveBeenCalled();
  });

  it("coalesces repeated close attempts while confirmation is open", async () => {
    let confirm: ((result: { response: number }) => void) | undefined;
    showMessageBoxMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
    );
    const window = createWindow();
    window.close();
    window.close();
    expect(showMessageBoxMock).toHaveBeenCalledOnce();
    confirm?.({ response: 1 });
    await vi.waitFor(() => expect(window.close).toHaveBeenCalledTimes(3));
  });

  it("allows shutdown and updater-owned closes without a prompt", () => {
    const window = createWindow(() => false);
    expect(window.close().preventDefault).not.toHaveBeenCalled();
    expect(showMessageBoxMock).not.toHaveBeenCalled();
  });

  it("asks again when another close handler vetoes the confirmed attempt", async () => {
    showMessageBoxMock
      .mockResolvedValueOnce({ response: 1 })
      .mockResolvedValueOnce({ response: 0 });
    const window = createWindow();
    window.on("close", (event) => event.preventDefault());

    window.close();
    await vi.waitFor(() => expect(window.close).toHaveBeenCalledTimes(2));
    expect(window.close.mock.results[1]?.value.preventDefault).toHaveBeenCalledOnce();

    window.close();
    await vi.waitFor(() => expect(showMessageBoxMock).toHaveBeenCalledTimes(2));
    expect(window.close).toHaveBeenCalledTimes(3);
  });
});

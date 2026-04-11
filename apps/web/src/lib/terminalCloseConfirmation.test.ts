// FILE: terminalCloseConfirmation.test.ts
// Purpose: Verifies shared terminal close confirmation copy and dialog behavior.
// Layer: UI logic helper tests
// Depends on: terminalCloseConfirmation helpers and Vitest mocks.

import { describe, expect, it, vi } from "vitest";

import {
  buildTerminalCloseConfirmationMessage,
  confirmTerminalTabClose,
  resolveTerminalCloseTitle,
} from "./terminalCloseConfirmation";

describe("resolveTerminalCloseTitle", () => {
  it("prefers explicit title overrides over generated labels", () => {
    expect(
      resolveTerminalCloseTitle({
        terminalId: "terminal-1",
        terminalLabelsById: { "terminal-1": "Codex 1" },
        terminalTitleOverridesById: { "terminal-1": "Deploy shell" },
      }),
    ).toBe("Deploy shell");
  });

  it("falls back to the stored label when no override exists", () => {
    expect(
      resolveTerminalCloseTitle({
        terminalId: "terminal-1",
        terminalLabelsById: { "terminal-1": "Codex 1" },
        terminalTitleOverridesById: {},
      }),
    ).toBe("Codex 1");
  });
});

describe("buildTerminalCloseConfirmationMessage", () => {
  it("uses the visible terminal title in the confirmation copy", () => {
    expect(
      buildTerminalCloseConfirmationMessage({
        terminalTitle: "Deploy shell",
        willDeleteThread: false,
      }),
    ).toBe(
      [
        'Close terminal "Deploy shell"?',
        "This permanently clears the terminal history for this tab.",
      ].join("\n"),
    );
  });

  it("warns when closing the last placeholder terminal also deletes the thread", () => {
    expect(
      buildTerminalCloseConfirmationMessage({
        terminalTitle: "Codex 1",
        willDeleteThread: true,
      }),
    ).toBe(
      [
        'Close terminal "Codex 1"?',
        "This permanently clears the terminal history for this tab and deletes the empty terminal thread.",
      ].join("\n"),
    );
  });
});

describe("confirmTerminalTabClose", () => {
  it("short-circuits when confirmations are disabled", async () => {
    const confirm = vi.fn();

    await expect(
      confirmTerminalTabClose({
        api: { dialogs: { confirm, pickFolder: vi.fn() } },
        enabled: false,
        terminalTitle: "Deploy shell",
      }),
    ).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("delegates to the shared dialog when confirmations are enabled", async () => {
    const confirm = vi.fn().mockResolvedValue(true);

    await expect(
      confirmTerminalTabClose({
        api: { dialogs: { confirm, pickFolder: vi.fn() } },
        enabled: true,
        terminalTitle: "Deploy shell",
        willDeleteThread: true,
      }),
    ).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith(
      [
        'Close terminal "Deploy shell"?',
        "This permanently clears the terminal history for this tab and deletes the empty terminal thread.",
      ].join("\n"),
    );
  });
});

// FILE: EnvironmentNotesSection.browser.tsx
// Purpose: Browser-level regression tests for the Environment panel notes autosave lifecycle.
// Layer: Vitest browser tests

import "../../../index.css";

import { ThreadId } from "@synara/contracts";
import { useState, type ComponentProps } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { EnvironmentNotesSection } from "./EnvironmentNotesSection";

describe("EnvironmentNotesSection", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("flushes the latest typed note when it unmounts before effects run", async () => {
    const onChange = vi.fn(() => Promise.resolve());
    const screen = await render(
      <EnvironmentNotesSection
        threadId={ThreadId.makeUnsafe("thread-notes-fast-unmount")}
        notes="saved"
        onChange={onChange}
      />,
    );

    await page.getByPlaceholder("Type here").fill("saved plus final keystroke");
    await screen.unmount();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(
      ThreadId.makeUnsafe("thread-notes-fast-unmount"),
      "saved plus final keystroke",
    );
  });

  it("keeps a rejected save dirty so a later flush retries it", async () => {
    type NotesChange = ComponentProps<typeof EnvironmentNotesSection>["onChange"];
    let rejectFirstSave!: (reason?: unknown) => void;
    const firstSave = new Promise<void>((_resolve, reject) => {
      rejectFirstSave = reject;
    });
    const onChange = vi
      .fn<NotesChange>()
      .mockImplementationOnce(() => firstSave)
      .mockResolvedValue(undefined);
    const screen = await render(
      <EnvironmentNotesSection
        threadId={ThreadId.makeUnsafe("thread-notes-retry-after-failure")}
        notes="saved"
        onChange={onChange}
      />,
    );

    await page.getByPlaceholder("Type here").fill("unsaved draft");
    document.querySelector<HTMLTextAreaElement>("textarea")?.blur();
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    rejectFirstSave(new Error("offline"));
    await firstSave.catch(() => undefined);
    await Promise.resolve();

    await screen.unmount();

    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    expect(onChange).toHaveBeenLastCalledWith(
      ThreadId.makeUnsafe("thread-notes-retry-after-failure"),
      "unsaved draft",
    );
  });

  it("does not re-adopt stale props after a focused autosave succeeds before the echo", async () => {
    const onChange = vi.fn(() => Promise.resolve());
    await render(
      <EnvironmentNotesSection
        threadId={ThreadId.makeUnsafe("thread-notes-stale-echo")}
        notes="server old"
        onChange={onChange}
      />,
    );

    await page.getByPlaceholder("Type here").fill("server new");
    await vi.waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        ThreadId.makeUnsafe("thread-notes-stale-echo"),
        "server new",
      ),
    );
    document.querySelector<HTMLTextAreaElement>("textarea")?.blur();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("server new");
  });

  it("adopts a different remote update while waiting for the local echo", async () => {
    const onChange = vi.fn(() => Promise.resolve());
    function CompetingRemoteHarness() {
      const [notes, setNotes] = useState("server old");
      return (
        <>
          <button type="button" onClick={() => setNotes("server remote")}>
            Apply competing remote
          </button>
          <EnvironmentNotesSection
            threadId={ThreadId.makeUnsafe("thread-notes-competing-remote")}
            notes={notes}
            onChange={onChange}
          />
        </>
      );
    }

    await render(<CompetingRemoteHarness />);

    await page.getByPlaceholder("Type here").fill("server local");
    await vi.waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        ThreadId.makeUnsafe("thread-notes-competing-remote"),
        "server local",
      ),
    );
    await page.getByRole("button", { name: "Apply competing remote" }).click();

    await vi.waitFor(() =>
      expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("server remote"),
    );
  });

  it("adopts remote note updates while idle", async () => {
    const onChange = vi.fn(() => Promise.resolve());
    function RemoteNotesHarness() {
      const [notes, setNotes] = useState("server old");
      return (
        <>
          <button type="button" onClick={() => setNotes("server remote")}>
            Apply remote
          </button>
          <EnvironmentNotesSection
            threadId={ThreadId.makeUnsafe("thread-notes-remote-update")}
            notes={notes}
            onChange={onChange}
          />
        </>
      );
    }

    await render(<RemoteNotesHarness />);

    await page.getByRole("button", { name: "Apply remote" }).click();

    expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("server remote");
    expect(onChange).not.toHaveBeenCalled();
  });
});

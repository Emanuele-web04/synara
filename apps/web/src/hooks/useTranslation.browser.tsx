import { describe, expect, it } from "vitest";
import { render, renderHook } from "vitest-browser-react";

import { getFormatLocale, useTranslation } from "~/i18n";
import { formatVisualNumber } from "~/components/chat/inlineVisualBlocks.logic";
import { workEntryDisplayParts } from "~/components/chat/TimelineWorkEntryRow";
import type { WorkLogEntry } from "~/session-logic";
import { TurnHeaderLine } from "~/components/chat/TurnHeaderLine";
import type { TurnHeader } from "~/components/chat/MessagesTimeline.logic";

describe("interface translation", () => {
  it("renders settled and resumed headers without replacing their timing or provider text", async () => {
    const resumedBy = [{ description: "settings:accessibility", outcome: "finished" }] as const;
    const header: TurnHeader = {
      elapsed: "20s",
      endedAt: "2026-01-01T00:00:20Z",
      outcome: "completed",
      reason: null,
      resumedBy,
    };
    const screen = await render(
      <>
        <TurnHeaderLine kind="settled" fontSize="inherit" header={header} />
        <TurnHeaderLine
          kind="live"
          fontSize="inherit"
          startedAt="2026-01-01T00:00:00Z"
          nowLabel="5s"
          resumedBy={resumedBy}
        />
      </>,
    );
    const settled = () =>
      screen.container.querySelector('[data-turn-header="completed"]')?.textContent;
    const live = () => screen.container.querySelector('[data-turn-header="live"]')?.textContent;
    try {
      expect(settled()).toBe("Resumed: “settings:accessibility” finished · 20s");
      expect(live()).toBe("Resumed: “settings:accessibility” finished · 5s");
    } finally {
      await screen.unmount();
    }
  });

  it("labels a command row while preserving its literal command", async () => {
    const entry: WorkLogEntry = {
      id: "command-language-test",
      createdAt: "2026-10-13T10:00:00Z",
      tone: "tool",
      label: "Command completed",
      itemType: "command_execution",
      toolStatus: "completed",
      command: "echo Settings",
    };
    const hook = await renderHook(() => {
      const { t } = useTranslation();
      return workEntryDisplayParts(entry, t);
    });
    try {
      expect(hook.result.current.heading).toBe("Ran");
      expect(hook.result.current.commandLiteral).toBe("echo Settings");
    } finally {
      await hook.unmount();
    }
  });

  it("formats numbers in mounted consumers with the system locale", async () => {
    const hook = await renderHook(() => {
      const { locale, formatLocale } = useTranslation();
      return { locale, formatLocale, number: formatVisualNumber(12345.67, {}, formatLocale) };
    });
    try {
      expect(hook.result.current.locale).toBe("en");
      expect(hook.result.current.formatLocale).toBe(getFormatLocale());
      expect(hook.result.current.number).toBe(
        new Intl.NumberFormat(getFormatLocale(), { maximumFractionDigits: 2 }).format(12345.67),
      );
    } finally {
      await hook.unmount();
    }
  });
});

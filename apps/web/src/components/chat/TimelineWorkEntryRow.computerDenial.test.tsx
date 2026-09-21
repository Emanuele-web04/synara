// FILE: TimelineWorkEntryRow.computerDenial.test.tsx
// Purpose: Pins the denial wiring: a computer-control denial renders the
// actionable card (not a buried tool-error line) in both densities, and the
// setup prompt renders its card the same way — neither is capped, collapsed,
// or truncated into a plain row.
// Layer: Chat transcript UI regression test

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { WorkLogEntry } from "../../workLog";
import { TimelineWorkEntryRow } from "./TimelineWorkEntryRow";

function denialEntry(): WorkLogEntry {
  return {
    id: "work-denied",
    createdAt: new Date(0).toISOString(),
    label: "Computer control is off for this chat",
    tone: "error",
    computerControlDenied: { toolName: "computer_click" },
  };
}

function setupEntry(): WorkLogEntry {
  return {
    id: "work-setup",
    createdAt: new Date(0).toISOString(),
    label: "Computer control needs setup",
    tone: "error",
    computerSetupRequired: { missing: [] },
  };
}

function renderRow(workEntry: WorkLogEntry, density: "default" | "compact"): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <TimelineWorkEntryRow
        workEntry={workEntry}
        chatMetaFontSizePx={12}
        density={density}
        markdownCwd={undefined}
        onImageExpand={() => undefined}
        timestampFormat="locale"
        computerControlEnabled={false}
        onEnableComputerControl={() => undefined}
      />
    </QueryClientProvider>,
  );
}

describe("TimelineWorkEntryRow computer denial wiring", () => {
  it.each(["default", "compact"] as const)(
    "renders the denial card uncapped at %s density",
    (density) => {
      const markup = renderRow(denialEntry(), density);

      expect(markup).toContain("Turn it on in Settings to let the agent use the desktop.");
      expect(markup).toContain(">Enable<");
    },
  );

  it.each(["default", "compact"] as const)(
    "renders the setup card uncapped at %s density",
    (density) => {
      const markup = renderRow(setupEntry(), density);

      expect(markup).toContain("Computer control needs setup");
    },
  );
});

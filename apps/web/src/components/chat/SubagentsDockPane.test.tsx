import { ThreadId } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  runningSubagentRosterItem,
  subagentRosterItem,
} from "./environment/subagentRosterFixtures";
import { SubagentsList } from "./SubagentsDockPane";

const noop = () => undefined;

describe("SubagentsList", () => {
  it("lists active runs with controls, then done runs folded after ten", () => {
    const markup = renderToStaticMarkup(
      <SubagentsList
        roster={{
          active: [
            runningSubagentRosterItem("Scout", { lastToolName: "Grep", totalTokens: 18_000 }),
          ],
          previous: [
            subagentRosterItem("Broken", { statusLabel: "Failed", statusKind: "failed" }),
            ...Array.from({ length: 11 }, (_, index) => subagentRosterItem(`Done ${index + 1}`)),
          ],
        }}
        parent={{ threadId: ThreadId.makeUnsafe("parent"), label: "Refactor auth" }}
        nowMs={Date.parse("2026-10-10T10:02:00.000Z")}
        onOpen={noop}
        onBackground={noop}
        onStop={noop}
      />,
    );

    expect(markup).toContain("Back to Refactor auth");
    expect(markup).toContain("Active · 1");
    expect(markup).toContain("Running");
    expect(markup).toContain(" · Grep · 18k tokens");
    expect(markup).toContain("Stop subagent Scout");
    expect(markup).toContain("Run Scout in background");
    expect(markup).toContain("Done · 12");
    expect(markup).toContain("Failed");
    expect(markup).toContain("Done 9");
    expect(markup).not.toContain("Done 10<");
    expect(markup).toContain("Show 2 more");
  });

  it("says so when the chat has no subagents", () => {
    const markup = renderToStaticMarkup(
      <SubagentsList
        roster={{ active: [], previous: [] }}
        parent={null}
        nowMs={0}
        onOpen={noop}
        onBackground={noop}
        onStop={noop}
      />,
    );

    expect(markup).toContain("No subagents in this chat yet.");
  });
});

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
    expect(markup).toContain('aria-hidden="true" inert=""');
    expect(markup).toContain("Show 2 more");
  });

  it("keeps parent navigation when sibling details are not hydrated", () => {
    const markup = renderToStaticMarkup(
      <SubagentsList
        roster={{ active: [], previous: [] }}
        parent={{ threadId: ThreadId.makeUnsafe("parent"), label: "Parent" }}
        nowMs={0}
        onOpen={noop}
        onBackground={noop}
        onStop={noop}
      />,
    );
    expect(markup).toContain("Back to Parent");
    expect(markup).toContain("No subagents in this chat yet.");
  });

  it("does not invent a finish time and keeps failure statistics separate from the summary", () => {
    const markup = renderToStaticMarkup(
      <SubagentsList
        roster={{
          active: [],
          previous: [
            subagentRosterItem("Broken", {
              settledAt: null,
              statusKind: "failed",
              statusLabel: "Failed",
              summary: "Quota exhausted",
              totalTokens: 12000,
              toolUses: 3,
            }),
          ],
        }}
        parent={null}
        nowMs={Date.parse("2026-10-10T10:02:00Z")}
        onOpen={noop}
        onBackground={noop}
        onStop={noop}
      />,
    );
    expect(markup).not.toContain("ago");
    expect(markup).toContain("12k tokens · 3 tool calls");
    expect(markup.match(/Quota exhausted/g)).toHaveLength(1);
  });

  it("updates known finish labels using the supplied clock", () => {
    const render = (nowMs: number) =>
      renderToStaticMarkup(
        <SubagentsList
          roster={{
            active: [],
            previous: [subagentRosterItem("Quiet", { statusKind: "idle", statusLabel: "Idle" })],
          }}
          parent={null}
          nowMs={nowMs}
          onOpen={noop}
          onBackground={noop}
          onStop={noop}
        />,
      );
    expect(render(Date.parse("2026-10-10T10:01:10Z"))).toContain("just now");
    expect(render(Date.parse("2026-10-10T10:03:10Z"))).toContain("2m ago");
  });

  it.each(["Idle", "Closed"])("does not label a finished row as %s", (statusLabel) => {
    const markup = renderToStaticMarkup(
      <SubagentsList
        roster={{
          active: [],
          previous: [subagentRosterItem("Quiet", { statusKind: "idle", statusLabel })],
        }}
        parent={null}
        nowMs={0}
        onOpen={noop}
        onBackground={noop}
        onStop={noop}
      />,
    );
    expect(markup).not.toContain(`>${statusLabel}</span>`);
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

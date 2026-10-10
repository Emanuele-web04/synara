import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EnvironmentSubagentsSection } from "./EnvironmentSubagentsSection";
import { runningSubagentRosterItem, subagentRosterItem } from "./subagentRosterFixtures";

const noop = () => undefined;

describe("EnvironmentSubagentsSection", () => {
  it("summarizes running and done subagents in one row that opens the list", () => {
    const markup = renderToStaticMarkup(
      <EnvironmentSubagentsSection
        roster={{
          active: ["Scout", "Reviewer"].map((label) => runningSubagentRosterItem(label)),
          previous: ["One", "Two", "Three"].map((label) => subagentRosterItem(label)),
        }}
        onOpenList={noop}
      />,
    );

    expect(markup).toContain("Subagents");
    expect(markup).toContain("Open subagents: 2 running, 3 done");
    // Only the live agents' avatars lead the summary.
    expect(markup.match(/<svg/g)).toHaveLength(2);
  });

  it("counts every subagent once none is running", () => {
    const markup = renderToStaticMarkup(
      <EnvironmentSubagentsSection
        roster={{
          active: [],
          previous: ["One", "Two", "Three", "Four"].map((label) => subagentRosterItem(label)),
        }}
        onOpenList={noop}
      />,
    );

    expect(markup).toContain("4 subagents");
    expect(markup).not.toContain("done");
    expect(markup.match(/<svg/g)).toHaveLength(3);
  });

  it("renders nothing before the thread spawns a subagent", () => {
    const markup = renderToStaticMarkup(
      <EnvironmentSubagentsSection roster={{ active: [], previous: [] }} onOpenList={noop} />,
    );

    expect(markup).toBe("");
  });
});

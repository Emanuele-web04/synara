import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { setLanguagePreference } from ".";
import { formatDayAwareTimestamp } from "../timestampFormat";
import {
  PullRequestStateGlyph,
  IssueStateGlyph,
} from "../components/pullRequest/PullRequestStateGlyph";
import {
  resolvePrStatePresentation,
  resolveIssueStatePresentation,
} from "../components/pullRequest/pullRequestStatePresentation";

afterEach(() => setLanguagePreference("system"));

describe("locale-aware presentation", () => {
  it("changes weekday names immediately and keeps formatter caches separate", () => {
    const now = new Date(2026, 2, 17, 12, 0);
    const monday = new Date(2026, 2, 16, 9, 5).toISOString();
    setLanguagePreference("en");
    expect(formatDayAwareTimestamp(monday, "24-hour", now)).toMatch(/^Monday /);
    setLanguagePreference("zh-CN");
    expect(formatDayAwareTimestamp(monday, "24-hour", now)).toMatch(/^星期一 /);
    setLanguagePreference("en");
    expect(formatDayAwareTimestamp(monday, "24-hour", now)).toMatch(/^Monday /);
  });

  it("keeps source PR and issue states stable for agent context while localizing glyphs", () => {
    setLanguagePreference("zh-CN");
    expect(resolvePrStatePresentation({ state: "open", isDraft: true }).label).toBe("PR draft");
    expect(
      resolveIssueStatePresentation({ state: "closed", stateReason: "completed" }).shortLabel,
    ).toBe("Closed");
    expect(renderToStaticMarkup(<PullRequestStateGlyph state="open" isDraft={true} />)).toContain(
      'aria-label="拉取请求草稿"',
    );
    expect(
      renderToStaticMarkup(<IssueStateGlyph state="closed" stateReason="completed" />),
    ).toContain('aria-label="议题已关闭"');
  });
});

it("keeps project names that match translation keys unchanged in settings groups", async () => {
  const { SettingsSection } = await import("../components/settings/SettingsPanelPrimitives");
  setLanguagePreference("zh-CN");
  expect(
    renderToStaticMarkup(
      <SettingsSection title="workspace:toast_settings" translateTitle={false}>
        <span>data</span>
      </SettingsSection>,
    ),
  ).toContain(">workspace:toast_settings</h2>");
  expect(
    renderToStaticMarkup(
      <SettingsSection title="workspace:toast_settings">
        <span>data</span>
      </SettingsSection>,
    ),
  ).toContain(">设置</h2>");
});

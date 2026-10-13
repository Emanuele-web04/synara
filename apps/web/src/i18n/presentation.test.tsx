import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { i18n, setLanguagePreference } from ".";
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
    setLanguagePreference("es");
    expect(formatDayAwareTimestamp(monday, "24-hour", now)).toMatch(/^lunes /);
    setLanguagePreference("en");
    expect(formatDayAwareTimestamp(monday, "24-hour", now)).toMatch(/^Monday /);
  });

  it("keeps source PR and issue states stable for agent context while localizing glyphs", () => {
    i18n.addResources("es", "translation", {
      "PR draft": "PR en borrador",
      "Issue closed": "Issue cerrada",
      Closed: "Cerrada",
    });
    setLanguagePreference("es");
    expect(resolvePrStatePresentation({ state: "open", isDraft: true }).label).toBe("PR draft");
    expect(
      resolveIssueStatePresentation({ state: "closed", stateReason: "completed" }).shortLabel,
    ).toBe("Closed");
    expect(renderToStaticMarkup(<PullRequestStateGlyph state="open" isDraft={true} />)).toContain(
      'aria-label="PR en borrador"',
    );
    expect(
      renderToStaticMarkup(<IssueStateGlyph state="closed" stateReason="completed" />),
    ).toContain('aria-label="Issue cerrada"');
  });
});

it("keeps project names that match translation keys unchanged in settings groups", async () => {
  const { SettingsSection } = await import("../components/settings/SettingsPanelPrimitives");
  setLanguagePreference("es");
  expect(
    renderToStaticMarkup(
      <SettingsSection title="Settings" translateTitle={false}>
        <span>data</span>
      </SettingsSection>,
    ),
  ).toContain(">Settings</h2>");
  expect(
    renderToStaticMarkup(
      <SettingsSection title="Settings">
        <span>data</span>
      </SettingsSection>,
    ),
  ).toContain(">Ajustes</h2>");
});

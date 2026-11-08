import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { i18n } from ".";
import { Translation } from "./Translation";

describe("rich localized text", () => {
  it("renders shipped sentences with explicit React slots", () => {
    const html = renderToStaticMarkup(
      <Translation
        message="settings:binaryPathDescription"
        values={{ command: "codex" }}
        components={{ command: <code /> }}
      />,
    );
    expect(html).toContain("<code>codex</code>");
    expect(html).toContain("Leave blank");
  });

  it("keeps the project control and complete project heading together", () => {
    const html = renderToStaticMarkup(
      <Translation
        message="chat:emptyLandingProjectHeading"
        components={{ project: <button type="button">{"<project> & 项目"}</button> }}
      />,
    );
    expect(html).toBe(
      'What should we do in <button type="button">&lt;project&gt; &amp; 项目</button>?',
    );
  });

  it("keeps HTML, event handlers, and named slots inside interpolated values as literal text", () => {
    const command =
      '<command onclick="alert(1)"><strong>用户内容</strong></command> & <img src="x" />';
    const html = renderToStaticMarkup(
      <Translation
        message="settings:binaryPathDescription"
        values={{ command }}
        components={{ command: <code /> }}
      />,
    );
    expect(html.match(/<code>/g)).toHaveLength(1);
    expect(html).toContain("&lt;command onclick=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&lt;strong&gt;用户内容&lt;/strong&gt;");
    expect(html).toContain(" &amp; ");
    expect(html).not.toMatch(/<(?:strong|img|command)\b/);
    expect(html).not.toContain("&amp;lt;");
  });

  it("does not interpret catalog HTML that has no explicit React slot", () => {
    const key = "binaryPathDescription";
    const original: string = i18n.getResource("en", "settings", key);
    i18n.addResource(
      "en",
      "settings",
      key,
      '<strong>中文</strong><img src="x" onerror="alert(1)" /><command>{{command}}</command>',
    );
    try {
      const html = renderToStaticMarkup(
        <Translation
          message="settings:binaryPathDescription"
          values={{ command: "codex" }}
          components={{ command: <code /> }}
        />,
      );
      expect(html).toContain("&lt;strong&gt;中文&lt;/strong&gt;");
      expect(html).not.toMatch(/<(?:strong|img)\b/);
      expect(html).toContain("<code>codex</code>");
    } finally {
      i18n.addResource("en", "settings", key, original);
    }
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProviderUsagePanelContent } from "./ProviderUsagePanelContent";

describe("ProviderUsagePanelContent", () => {
  it("shows plan metadata in the detailed usage view", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsagePanelContent provider="codex" planName="Plus" rateLimits={[]} showTitle />,
    );

    expect(markup).toContain("Codex usage");
    expect(markup).toContain("Plus");
    expect(markup).toContain('title="Plus"');
  });
});

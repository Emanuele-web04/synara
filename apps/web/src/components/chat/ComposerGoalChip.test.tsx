import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ComposerGoalChip } from "./ComposerGoalChip";

describe("ComposerGoalChip", () => {
  it("renders the active goal label and clear affordance", () => {
    const html = renderToStaticMarkup(
      <ComposerGoalChip label="Explore docs folder" onClear={vi.fn()} />,
    );

    expect(html).toContain("Explore docs folder");
    expect(html).toContain("Disable goal");
    expect(html).toContain("composer-goal-chip");
  });
});

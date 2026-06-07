// FILE: ProviderIcon.test.tsx
// Purpose: Covers shared provider icon rendering that many chat surfaces reuse.
// Layer: web UI tests
// Depends on: react-dom server rendering and ProviderIcon provider mapping.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProviderIcon } from "./ProviderIcon";

describe("ProviderIcon", () => {
  it("uses the reversed Central icon for opencode in dark mode", () => {
    const markup = renderToStaticMarkup(
      <ProviderIcon provider="opencode" className="size-4 text-muted-foreground" />,
    );

    expect(markup).toContain("dark:hidden");
    expect(markup).toContain("hidden dark:inline-block");
    expect(markup).toContain("dark:text-foreground/90");
    expect(markup).toContain("/central-icons-reversed/opencode.svg");
  });
});

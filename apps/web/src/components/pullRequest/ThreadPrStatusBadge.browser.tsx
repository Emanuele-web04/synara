// FILE: ThreadPrStatusBadge.browser.tsx
// Purpose: Guards the icon-only PR badge, its accessible name, and its clickable destination.
// Layer: Pull request presentation test

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ThreadPrStatusBadge } from "./ThreadPrStatusBadge";

describe("ThreadPrStatusBadge", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders an icon-only badge that exposes the PR number via its accessible name", async () => {
    const onOpen = vi.fn();
    await render(
      <ThreadPrStatusBadge
        pr={{
          number: 841,
          title: "Fix created-at thread ordering",
          url: "https://github.com/acme/synara/pull/841",
          state: "open",
          isDraft: false,
          mergeability: "mergeable",
        }}
        onOpen={onOpen}
      />,
    );

    const button = page.getByRole("button", {
      name: "#841 PR open: Fix created-at thread ordering",
    });
    await expect.element(button).toBeVisible();
    expect(document.body.textContent).not.toContain("841");

    await button.click();

    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen.mock.calls[0]?.[1]).toBe("https://github.com/acme/synara/pull/841");
  });
});

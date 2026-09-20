import "../../index.css";

import type { ProviderKind } from "@synara/contracts";
import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ShareCard, SHARE_CARD_HEIGHT, SHARE_CARD_WIDTH } from "./ShareCard";
import { baseStats, tokenStats } from "./profileTestFixtures";

it("keeps the full missing-token disclosure inside the exported card", async () => {
  await page.viewport(960, 520);
  const unavailableProviders: ProviderKind[] = [
    "antigravity",
    "cursor",
    "devin",
    "droid",
    "grok",
    "opencode",
    "pi",
  ];
  const heatmap = Array.from({ length: 183 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 0, index + 1));
    return {
      day: date.toISOString().slice(0, 10),
      weekday: date.getUTCDay(),
      count: (index % 5) * 1000,
      intensity: index % 5,
    };
  });
  const mounted = await render(
    <ShareCard
      stats={baseStats}
      tokenStats={{ ...tokenStats, heatmap, unavailableProviders }}
      displayName="Synara"
      handle="@synara"
      avatarColor="#2563eb"
      avatarImage={null}
    />,
  );
  const card = mounted.container.firstElementChild as HTMLElement;
  const disclosure = card.querySelector("p")!;
  const bounds = card.getBoundingClientRect();
  expect(bounds.width).toBe(SHARE_CARD_WIDTH);
  expect(bounds.height).toBe(SHARE_CARD_HEIGHT);
  expect(card.scrollHeight).toBeLessThanOrEqual(SHARE_CARD_HEIGHT);
  expect(card.scrollWidth).toBeLessThanOrEqual(SHARE_CARD_WIDTH);
  expect(disclosure.textContent).toContain("Grok, OpenCode, Pi");
  expect(disclosure.getBoundingClientRect().bottom).toBeLessThanOrEqual(bounds.bottom);
  expect(disclosure.getBoundingClientRect().top).toBeGreaterThan(bounds.top);
  await mounted.unmount();
});

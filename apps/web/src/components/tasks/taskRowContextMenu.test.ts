import { expect, it } from "vitest";

import { buildTaskRowContextMenu } from "./taskRowContextMenu";

it("keeps the linked chat reachable without offering unlink until delegation settles", () => {
  const starting = buildTaskRowContextMenu({
    isDelegated: true,
    isDone: false,
    hasLink: true,
    canUnlink: false,
  });
  expect(starting.some((item) => item.id === "open-chat")).toBe(true);
  expect(starting.some((item) => item.id === "unlink-chat")).toBe(false);
  expect(starting.some((item) => item.id === "delegate")).toBe(false);
  const settled = buildTaskRowContextMenu({
    isDelegated: true,
    isDone: false,
    hasLink: true,
    canUnlink: true,
  });
  expect(settled.some((item) => item.id === "unlink-chat")).toBe(true);
});

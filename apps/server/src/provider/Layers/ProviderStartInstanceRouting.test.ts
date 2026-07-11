import { describe, expect, it } from "vitest";

import { resolveCursorStartInstanceId } from "./CursorAdapter.ts";
import { resolveOpenCodeStartInstanceId } from "./OpenCodeAdapter.ts";

describe("direct provider start instance routing", () => {
  it("uses modelSelection identity for Cursor launch when explicit identity is absent", () => {
    expect(
      resolveCursorStartInstanceId({
        modelSelection: { instanceId: "cursor_work", model: "cursor/model" },
      } as never),
    ).toBe("cursor_work");
  });

  it.each(["opencode_work", "kilo_work"])(
    "uses modelSelection identity for %s launch/cache/session",
    (instanceId) => {
      expect(
        resolveOpenCodeStartInstanceId({
          modelSelection: { instanceId, model: "provider/model" },
        } as never),
      ).toBe(instanceId);
    },
  );
});

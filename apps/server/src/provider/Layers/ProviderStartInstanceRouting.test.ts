import { describe, expect, it } from "vitest";

import { resolveCursorStartInstanceId } from "./CursorAdapter.ts";
import { resolveOpenCodeStartInstanceId } from "./OpenCodeAdapter.ts";

describe("direct provider start instance routing", () => {
  it("uses modelSelection identity for Cursor launch when explicit identity is absent", () => {
    expect(
      resolveCursorStartInstanceId({
        modelSelection: {
          provider: "cursor",
          instanceId: "cursor_work",
          model: "cursor/model",
        },
      } as never),
    ).toBe("cursor_work");
  });

  it("uses modelSelection identity for OpenCode launch/cache/session", () => {
    expect(
      resolveOpenCodeStartInstanceId({
        modelSelection: {
          provider: "opencode",
          instanceId: "opencode_work",
          model: "provider/model",
        },
      } as never),
    ).toBe("opencode_work");
  });
});

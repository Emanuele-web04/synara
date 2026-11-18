import { describe, expect, it } from "vitest";

import { resolveAcpPromptImageMode } from "./AcpAdapter.ts";

describe("resolveAcpPromptImageMode", () => {
  it("sends image blocks only when the agent advertises image prompt support", () => {
    expect(resolveAcpPromptImageMode({ image: true })).toBe("blocks");
  });

  it("degrades to path references when the agent does not advertise image support", () => {
    expect(resolveAcpPromptImageMode({ image: false })).toBe("path-references");
  });

  it("degrades to path references when prompt capabilities are absent", () => {
    expect(resolveAcpPromptImageMode(undefined)).toBe("path-references");
    expect(resolveAcpPromptImageMode({})).toBe("path-references");
  });
});

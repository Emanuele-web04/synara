import { describe, expect, it } from "vitest";

import { requireHttpExternalUrl } from "./externalUrl";

describe("requireHttpExternalUrl", () => {
  it.each(["https://github.com/openai/codex", "http://localhost:5173/path"])("allows %s", (url) =>
    expect(requireHttpExternalUrl(url)).toBe(url),
  );

  it.each(["javascript:alert(1)", "file:///tmp/secret", "mailto:user@example.com", "/relative"])(
    "rejects %s",
    (url) => expect(() => requireHttpExternalUrl(url)).toThrow("Only HTTP(S)"),
  );
});

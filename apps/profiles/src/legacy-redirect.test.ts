import { describe, expect, it } from "vitest";
import redirect from "./legacy-redirect";

describe("legacy profile links", () => {
  it.each(["/@emanueledpt?from=app", "//attacker.example/@handle"])(
    "preserves the path and query on the configured origin: %s",
    (path) => {
      const response = redirect.fetch(new Request(`https://old.example${path}`), {
        PROFILES_PUBLIC_ORIGIN: "https://new.example",
      });
      expect(response.status).toBe(308);
      expect(response.headers.get("location")).toBe(`https://new.example${path}`);
    },
  );
});

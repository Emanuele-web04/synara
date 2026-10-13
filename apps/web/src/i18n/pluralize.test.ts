import { afterEach, expect, it } from "vitest";
import { pluralize as sourcePluralize } from "@synara/shared/text";

import { i18n, setLanguagePreference } from ".";
import { pluralize } from "./pluralize";

afterEach(() => setLanguagePreference("system"));

it("localizes count nouns without changing the shared source/protocol utility", () => {
  i18n.addResources("es", "translation", {
    thread: "conversación",
    threads: "conversaciones",
    file: "archivo",
    files: "archivos",
    has: "tiene",
    have: "tienen",
  });
  setLanguagePreference("en");
  expect(pluralize(2, "thread")).toBe("threads");
  setLanguagePreference("es");
  expect(pluralize(1, "thread")).toBe("conversación");
  expect(pluralize(0, "thread")).toBe("conversaciones");
  expect(pluralize(2, "file")).toBe("archivos");
  expect(pluralize(2, "has", "have")).toBe("tienen");
  expect(sourcePluralize(2, "thread")).toBe("threads");
});

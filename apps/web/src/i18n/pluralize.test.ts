import { afterEach, expect, it } from "vitest";
import { pluralize as sourcePluralize } from "@synara/shared/text";

import { setLanguagePreference } from ".";
import { pluralize } from "./pluralize";

afterEach(() => setLanguagePreference("system"));

it("localizes count nouns without changing the shared source/protocol utility", () => {
  setLanguagePreference("en");
  expect(pluralize(2, "thread")).toBe("threads");
  setLanguagePreference("zh-CN");
  expect(pluralize(1, "thread")).toBe("个对话");
  expect(pluralize(0, "thread")).toBe("个对话");
  expect(pluralize(2, "file")).toBe("个文件");
  expect(pluralize(2, "has", "have")).toBe("有");
  expect(sourcePluralize(2, "thread")).toBe("threads");
});

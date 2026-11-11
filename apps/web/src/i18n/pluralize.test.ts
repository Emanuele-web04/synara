import { expect, it } from "vitest";
import { pluralize as sourcePluralize } from "@synara/shared/text";

import { pluralize } from "./pluralize";

it("pluralizes count nouns without changing the shared source/protocol utility", () => {
  expect(pluralize(2, "thread")).toBe("threads");
  expect(sourcePluralize(2, "thread")).toBe("threads");
});

import "../index.css";

import { page } from "vitest/browser";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { DiffTruncationWarning } from "./DiffTruncationWarning";

it("clearly identifies a size-bounded patch as a partial diff", async () => {
  await render(<DiffTruncationWarning />);

  await expect.element(page.getByRole("alert")).toBeVisible();
  await expect.element(page.getByText("Partial diff", { exact: true })).toBeVisible();
  await expect.element(page.getByText(/some files or changes may be missing/i)).toBeVisible();
});

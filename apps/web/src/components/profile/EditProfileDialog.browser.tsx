import "../../index.css";

import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { EditProfileDialog } from "./EditProfileDialog";

it("keeps a hyphenated account handle when only publication changes", async () => {
  const onSave = vi.fn(async () => {});
  await render(
    <EditProfileDialog
      open
      onOpenChange={() => {}}
      initials="AL"
      name="Ada Lovelace"
      handle="@ada-example"
      avatarColor="#5A8DEE"
      avatarImage={null}
      accountProfile={{ handle: "ada-example", public: false, avatarSource: "placeholder" }}
      onSave={onSave}
    />,
  );

  await page.getByRole("switch", { name: "Public profile", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await vi.waitFor(() => {
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ handle: "@ada-example", isPublic: true }),
    );
  });
});

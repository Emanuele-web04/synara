import "../index.css";

import { useState } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { AnnouncementSheet } from "./AnnouncementSheet";
import { useAnnouncementSheetSlotStore } from "./announcementSheetSlot";
import { waitForTransientPopups } from "../lib/browserPopupCleanup";

function Sheet(props: { title: string }) {
  const [open, setOpen] = useState(true);
  return (
    <AnnouncementSheet
      open={open}
      hero={null}
      title={props.title}
      description="Body"
      dismissLabel={`Dismiss ${props.title}`}
      confirmLabel={`Confirm ${props.title}`}
      onDismiss={() => setOpen(false)}
      onConfirm={() => setOpen(false)}
    />
  );
}

describe("AnnouncementSheet", () => {
  afterEach(async () => {
    useAnnouncementSheetSlotStore.setState({ owner: null, handedOff: false });
    await waitForTransientPopups();
    document.body.innerHTML = "";
  });

  it("shows one startup announcement at a time and the next after a dismiss", async () => {
    const screen = await render(
      <>
        <Sheet title="First" />
        <Sheet title="Second" />
      </>,
    );
    try {
      await expect.element(page.getByRole("dialog", { name: "First" })).toBeVisible();
      expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);

      await page.getByRole("button", { name: "Dismiss First" }).click();
      await expect.element(page.getByRole("dialog", { name: "Second" })).toBeVisible();
      await expect.element(page.getByRole("dialog", { name: "First" })).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps waiting announcements closed after a confirm starts its follow-on flow", async () => {
    const screen = await render(
      <>
        <Sheet title="First" />
        <Sheet title="Second" />
      </>,
    );
    try {
      await page.getByRole("button", { name: "Confirm First" }).click();
      await expect.element(page.getByRole("dialog", { name: "First" })).not.toBeInTheDocument();
      expect(useAnnouncementSheetSlotStore.getState()).toMatchObject({
        owner: null,
        handedOff: true,
      });
      await expect.element(page.getByRole("dialog", { name: "Second" })).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});

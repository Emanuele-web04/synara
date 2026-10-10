import "../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { AnnouncementSheet } from "../components/AnnouncementSheet";
import { useAnnouncementSheetSlotStore } from "../components/announcementSheetSlot";
import WhatsNewDialog from "../components/WhatsNewDialog";
import { useOnboardingDialogStore } from "../onboarding/onboardingDialogStore";
import { WhatsNewPopoutCard } from "../whatsNew/WhatsNewPopoutCard";
import { useWhatsNew } from "../whatsNew/useWhatsNew";

const storageKey = "synara:whats-new:v1";
const entry = {
  version: "1.0.0",
  date: "Oct 5",
  features: [{ id: "welcome", title: "Welcome", description: "Release highlights" }],
};

beforeEach(() => {
  localStorage.setItem(storageKey, JSON.stringify({ lastSeenVersion: "0.9.9" }));
  useAnnouncementSheetSlotStore.setState({ owner: null, handedOff: false });
  useOnboardingDialogStore.setState({
    startupGateSettled: true,
    isOpen: false,
    betaWelcomePending: false,
  });
});
afterEach(() => localStorage.removeItem(storageKey));

function WhatsNew() {
  const notes = useWhatsNew({ entries: [entry], currentVersion: "1.0.0" });
  return (
    <>
      {notes.isPopoutVisible && (
        <WhatsNewPopoutCard
          entry={entry}
          currentVersion={notes.currentVersion}
          onOpen={notes.openDialog}
          onDismiss={notes.dismissPopout}
        />
      )}
      <WhatsNewDialog
        open={notes.isDialogOpen}
        onOpenChange={notes.onDialogOpenChange}
        currentEntry={notes.currentEntry}
        allEntries={notes.allEntries}
        currentVersion={notes.currentVersion}
      />
    </>
  );
}

it("keeps update notes unseen while queued and retains the slot from card through dialog", async () => {
  useAnnouncementSheetSlotStore.getState().claim("onboarding");
  const screen = await render(
    <>
      <WhatsNew />
      <AnnouncementSheet
        open
        hero={null}
        title="Waiting announcement"
        description="Body"
        confirmLabel="Continue"
        onDismiss={() => {}}
        onConfirm={() => {}}
      />
    </>,
  );
  try {
    await expect
      .element(page.getByRole("button", { name: "Open What's new in v1.0.0" }))
      .not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({ lastSeenVersion: "0.9.9" });
    useAnnouncementSheetSlotStore.getState().release("onboarding");
    await page.getByRole("button", { name: "Open What's new in v1.0.0" }).click();
    await expect
      .element(page.getByRole("button", { name: "Open What's new in v1.0.0" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("dialog", { name: "Waiting announcement" }))
      .not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({ lastSeenVersion: "0.9.9" });
    await page.getByRole("button", { name: "Got it" }).click();
    await expect.element(page.getByRole("dialog", { name: "Waiting announcement" })).toBeVisible();
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({ lastSeenVersion: "1.0.0" });
  } finally {
    await screen.unmount();
  }
});

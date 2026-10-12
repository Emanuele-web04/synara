import { beforeEach, describe, expect, it } from "vitest";

import { useAnnouncementSheetSlotStore } from "./announcementSheetSlot";

beforeEach(() =>
  useAnnouncementSheetSlotStore.setState({ owner: null, ownerPriority: 0, handedOff: false }),
);

describe("announcement slot ownership", () => {
  it("holds one owner until that owner releases it", () => {
    const slot = useAnnouncementSheetSlotStore.getState();
    slot.claim("first", 1);
    slot.claim("waiting");
    slot.release("waiting");
    expect(useAnnouncementSheetSlotStore.getState().owner).toBe("first");
    slot.release("first");
    slot.claim("waiting", 1);
    expect(useAnnouncementSheetSlotStore.getState().owner).toBe("waiting");
  });

  it("lets a startup announcement preempt a passive coachmark", () => {
    const slot = useAnnouncementSheetSlotStore.getState();
    slot.claim("coachmark", 0);
    slot.claim("browser-import", 1);
    expect(useAnnouncementSheetSlotStore.getState()).toMatchObject({
      owner: "browser-import",
      ownerPriority: 1,
    });
    slot.release("coachmark");
    expect(useAnnouncementSheetSlotStore.getState().owner).toBe("browser-import");
  });

  it("defers unseen startup sheets after handoff but allows a deliberate replay", () => {
    const slot = useAnnouncementSheetSlotStore.getState();
    slot.claim("first", 1);
    slot.handOff();
    slot.release("first");
    slot.claim("startup", 1);
    expect(useAnnouncementSheetSlotStore.getState().owner).toBeNull();
    slot.claim("replay", 1, true);
    expect(useAnnouncementSheetSlotStore.getState().owner).toBe("replay");
    slot.claim("second-replay", 1, true);
    expect(useAnnouncementSheetSlotStore.getState().owner).toBe("replay");
  });
});

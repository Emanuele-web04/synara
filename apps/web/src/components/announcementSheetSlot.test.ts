import { beforeEach, describe, expect, it } from "vitest";

import { useAnnouncementSheetSlotStore } from "./announcementSheetSlot";

beforeEach(() => useAnnouncementSheetSlotStore.setState({ owner: null, handedOff: false }));

describe("announcement slot ownership", () => {
  it("holds one owner until that owner releases it", () => {
    const slot = useAnnouncementSheetSlotStore.getState();
    slot.claim("first");
    slot.claim("waiting");
    slot.release("waiting");
    expect(useAnnouncementSheetSlotStore.getState().owner).toBe("first");
    slot.release("first");
    slot.claim("waiting");
    expect(useAnnouncementSheetSlotStore.getState().owner).toBe("waiting");
  });

  it("defers unseen startup sheets after handoff but allows a deliberate replay", () => {
    const slot = useAnnouncementSheetSlotStore.getState();
    slot.claim("first");
    slot.handOff();
    slot.release("first");
    slot.claim("startup");
    expect(useAnnouncementSheetSlotStore.getState().owner).toBeNull();
    slot.claim("replay", true);
    expect(useAnnouncementSheetSlotStore.getState().owner).toBe("replay");
    slot.claim("second-replay", true);
    expect(useAnnouncementSheetSlotStore.getState().owner).toBe("replay");
  });
});

// FILE: announcementSheetSlot.ts
// Purpose: One shared slot so startup announcement sheets open one at a time.
// Layer: Web UI store
//
// Startup announcements wait for the first-run gate and onboarding to finish, even
// while the onboarding dialog is loading. Beta welcome precedes that gate and opts out.
// Each announcement decides to open from its own asynchronous probe (desktop bridge,
// server config), so no fixed order can be relied on. The first surface that wants to
// open takes the slot; the others wait and open after it is dismissed. Confirming a
// sheet starts its follow-on flow (a dialog, a Settings page), so the waiting sheets
// stay closed for the rest of this launch instead of covering that flow; they are not
// acknowledged, so they come back on the next one.
//
// A sheet ordered "last" also waits for the startup chain to settle and for every other
// sheet or hint that wants to open to finish first, so it is always the final one.

import { useEffect, useId, useLayoutEffect } from "react";
import { create } from "zustand";

import { useOnboardingDialogStore } from "~/onboarding/onboardingDialogStore";

interface AnnouncementSheetSlotStore {
  owner: string | null;
  /** Startup probes and the feature tour have finished; passive hints may now claim. */
  startupSettled: boolean;
  /** True once a sheet was confirmed; no further sheet opens during this launch. */
  handedOff: boolean;
  /** Surfaces that want to open now, holding the slot or queued for it; "last" ones excluded. */
  pending: readonly string[];
  claim: (id: string, allowAfterHandOff?: boolean, last?: boolean) => void;
  release: (id: string) => void;
  setPending: (id: string, pending: boolean) => void;
  handOff: () => void;
  settleStartup: () => void;
}

export const useAnnouncementSheetSlotStore = create<AnnouncementSheetSlotStore>((set) => ({
  owner: null,
  startupSettled: false,
  handedOff: false,
  pending: [],
  claim: (id, allowAfterHandOff = false, last = false) =>
    set((state) => {
      if (state.owner !== null || (state.handedOff && !allowAfterHandOff)) return state;
      if (last && (!state.startupSettled || state.pending.length > 0)) return state;
      return { owner: id };
    }),
  release: (id) => set((state) => (state.owner === id ? { owner: null } : state)),
  setPending: (id, pending) =>
    set((state) => {
      if (state.pending.includes(id) === pending) return state;
      return {
        pending: pending ? [...state.pending, id] : state.pending.filter((other) => other !== id),
      };
    }),
  handOff: () => set({ handedOff: true }),
  settleStartup: () => set({ startupSettled: true }),
}));

/** `open` is true while this sheet wants to open and holds the slot. */
export function useAnnouncementSheetSlot(
  wantsOpen: boolean,
  allowAfterHandOff = false,
  waitForOnboarding = true,
  order: "any" | "last" = "any",
): {
  open: boolean;
  handOff: () => void;
} {
  const id = useId();
  const owner = useAnnouncementSheetSlotStore((state) => state.owner);
  const claim = useAnnouncementSheetSlotStore((state) => state.claim);
  const release = useAnnouncementSheetSlotStore((state) => state.release);
  const setPending = useAnnouncementSheetSlotStore((state) => state.setPending);
  const handOff = useAnnouncementSheetSlotStore((state) => state.handOff);
  const othersFirst = useAnnouncementSheetSlotStore(
    (state) => !state.startupSettled || state.pending.some((other) => other !== id),
  );
  const onboardingBlocking = useOnboardingDialogStore(
    (state) => !state.startupGateSettled || state.isOpen || state.betaWelcomePending,
  );
  const ready = wantsOpen && (!waitForOnboarding || !onboardingBlocking);
  const last = order === "last";
  // Once open, a "last" sheet keeps the slot even if another surface queues behind it.
  const eligible = ready && (!last || owner === id || !othersFirst);

  // Register newly ready hints before passive claim effects run. The store also
  // checks pending claims in case the claiming render used an older snapshot.
  useLayoutEffect(() => {
    if (!last) setPending(id, ready);
  }, [id, last, ready, setPending]);
  // Re-runs when the owner changes, so a waiting sheet claims the slot once it frees.
  useEffect(() => {
    if (eligible) claim(id, allowAfterHandOff, last);
    else release(id);
  }, [allowAfterHandOff, claim, eligible, id, last, owner, release]);
  useEffect(
    () => () => {
      release(id);
      setPending(id, false);
    },
    [id, release, setPending],
  );

  return { open: eligible && owner === id, handOff };
}

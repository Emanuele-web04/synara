// FILE: botEditorStore.ts
// Purpose: Opens and closes the bot editor from anywhere in the window (the SynBot page, the
//          panel, cards). `BotEditorHost` renders whatever this store points at.
// Layer: UI state store
// Exports: useBotEditor, BotEditorTarget

import { ProjectId } from "@synara/contracts";
import { create } from "zustand";

/**
 * `create.template`: a template name ("Frontend"), "crew" for the three-bot crew, or null for
 * the template picker. `edit.botId`: the bot (its Hub project id).
 */
export type BotEditorTarget =
  | { readonly mode: "create"; readonly template: string | null }
  | { readonly mode: "edit"; readonly botId: ProjectId };

interface BotEditorState {
  readonly open: boolean;
  /** Kept after `close()` so the sheet keeps its content while it animates out. */
  readonly target: BotEditorTarget | null;
  /** Bumped on every open: a fresh form per open. */
  readonly session: number;
  /** A save or remove is in flight: Escape and the backdrop do not close the sheet. */
  readonly busy: boolean;
  readonly openCreate: (options?: { readonly template?: string }) => void;
  readonly openEdit: (botId: string) => void;
  readonly close: () => void;
  readonly setBusy: (busy: boolean) => void;
}

export const useBotEditor = create<BotEditorState>()((set) => ({
  open: false,
  target: null,
  session: 0,
  busy: false,
  openCreate: (options) =>
    set((state) => ({
      open: true,
      target: { mode: "create", template: options?.template ?? null },
      session: state.session + 1,
    })),
  openEdit: (botId) =>
    set((state) => ({
      open: true,
      target: { mode: "edit", botId: ProjectId.makeUnsafe(botId) },
      session: state.session + 1,
    })),
  close: () => set({ open: false }),
  setBusy: (busy) => set({ busy }),
}));

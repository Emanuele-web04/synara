// FILE: whatsNew/useWhatsNew.ts
// Purpose: React hook that drives the two-stage "What's new" surface:
//   1. A small popout card (bottom-left) advertising the new release.
//   2. A dialog with the release notes, opened only when the user taps the card.
// Persists the "already seen this version" marker in localStorage so the popout
// doesn't reappear after dismissal.
// Layer: hook — glue between `logic.ts` (pure rules), the changelog data, and
// the popout + dialog components.

import { Schema } from "effect";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { APP_VERSION } from "../branding";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { WHATS_NEW_ENTRIES } from "./entries";
import {
  resolveWhatsNewState,
  type WhatsNewEntry,
  type WhatsNewInputs,
  type WhatsNewState,
} from "./logic";

const WHATS_NEW_STORAGE_KEY = "dpcode:whats-new:v1";

// Using an Option<string> via Schema.NullOr keeps the "never seen" sentinel
// explicit on disk. Omitting the field (undefined) would round-trip poorly
// through JSON; `null` stays faithful across reloads.
const WhatsNewStorageSchema = Schema.Struct({
  lastSeenVersion: Schema.NullOr(Schema.String),
});
type WhatsNewStorage = typeof WhatsNewStorageSchema.Type;

const INITIAL_STORAGE: WhatsNewStorage = { lastSeenVersion: null };

export interface UseWhatsNewResult {
  /**
   * The release entry matching the installed build. `null` means "nothing
   * to advertise" — silent-bootstrap or noop. When null, neither popout nor
   * dialog should render.
   */
  readonly currentEntry: WhatsNewEntry | null;
  /** Full curated history, sorted newest-first, for the changelog view. */
  readonly allEntries: readonly WhatsNewEntry[];
  /** Version the popout / dialog is announcing (the installed build). */
  readonly currentVersion: string;
  /** Whether the bottom-left "New: ..." card should be rendered. */
  readonly isPopoutVisible: boolean;
  /** Whether the post-update release-notes dialog should be rendered open. */
  readonly isDialogOpen: boolean;
  /**
   * Open the dialog in response to the user tapping the popout card. We don't
   * mark the update as seen here — acknowledging the card is not the same as
   * acknowledging the notes. `onDialogOpenChange(false)` handles that.
   */
  readonly openDialog: () => void;
  /**
   * Dismiss the popout via its ✕ button. This marks the release as seen and
   * never re-prompts — even if the user never opens the dialog. Matches
   * IndieDevs behaviour: hitting the X is a deliberate "I don't care".
   */
  readonly dismissPopout: () => void;
  /**
   * Close handler for the dialog (base-ui `onOpenChange(open)` shape). When
   * the dialog closes, persist the seen marker and hide the popout so the
   * user isn't nagged by the card they just acted on.
   */
  readonly onDialogOpenChange: (open: boolean) => void;
}

/**
 * Drives the "What's new" post-update surface.
 *
 * Behaviour summary (see `resolveWhatsNewState` for the rules):
 *   - First launch → silently record the current version, no popout.
 *   - User already on the latest (or somehow ahead) → no popout.
 *   - User upgraded and there are curated notes → show the popout card.
 *   - User upgraded but no curated notes exist → silently advance the marker.
 *
 * The dialog is never opened automatically — only via the popout card click.
 */
export function useWhatsNew(options?: {
  readonly entries?: readonly WhatsNewEntry[];
  readonly currentVersion?: string;
}): UseWhatsNewResult {
  const entries = options?.entries ?? WHATS_NEW_ENTRIES;
  const currentVersion = options?.currentVersion ?? APP_VERSION;

  const [storage, setStorage] = useLocalStorage(
    WHATS_NEW_STORAGE_KEY,
    INITIAL_STORAGE,
    WhatsNewStorageSchema,
  );

  // Snapshot the decision once per mount using the initial storage value so
  // that updating localStorage (e.g. acknowledging the dialog) doesn't flip
  // the UI back and forth while animations are still running.
  const initialStorageRef = useRef(storage);
  const initialState = useMemo<WhatsNewState>(
    () =>
      resolveWhatsNewState({
        entries,
        currentVersion,
        lastSeenVersion: initialStorageRef.current.lastSeenVersion,
      } satisfies WhatsNewInputs),
    [entries, currentVersion],
  );

  // The popout starts visible only when we actually have something to show.
  const [isPopoutVisible, setIsPopoutVisible] = useState(initialState.kind === "show");
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  // Silent bootstrap (first launch or no curated notes for this upgrade):
  // advance the marker in the background so the next upgrade is correctly
  // detected. Done in an effect so we only touch storage once per mount.
  useEffect(() => {
    if (initialState.kind === "silent-bootstrap") {
      setStorage({ lastSeenVersion: initialState.nextLastSeenVersion });
    }
  }, [initialState, setStorage]);

  const currentEntry = useMemo<WhatsNewEntry | null>(
    () => (initialState.kind === "show" ? initialState.currentEntry : null),
    [initialState],
  );

  const allEntries = useMemo<readonly WhatsNewEntry[]>(
    () => (initialState.kind === "show" ? initialState.allEntries : []),
    [initialState],
  );

  const markSeen = useCallback(() => {
    if (initialState.kind === "show") {
      setStorage({ lastSeenVersion: initialState.nextLastSeenVersion });
    }
  }, [initialState, setStorage]);

  const openDialog = useCallback(() => {
    // Just open the dialog. The user is about to read the notes — don't mark
    // as seen yet; that happens on dialog close.
    setIsDialogOpen(true);
  }, []);

  const dismissPopout = useCallback(() => {
    // X on the card: treat as "I've acknowledged this update". Mark as seen
    // and hide the popout forever (for this version).
    setIsPopoutVisible(false);
    markSeen();
  }, [markSeen]);

  const onDialogOpenChange = useCallback(
    (open: boolean) => {
      setIsDialogOpen(open);
      if (!open) {
        // Dismissing the dialog = finished reading the notes. Hide the
        // popout too so we don't leave the "click me" affordance lingering
        // after the user clearly engaged.
        setIsPopoutVisible(false);
        markSeen();
      }
    },
    [markSeen],
  );

  return {
    currentEntry,
    allEntries,
    currentVersion,
    isPopoutVisible,
    isDialogOpen,
    openDialog,
    dismissPopout,
    onDialogOpenChange,
  };
}

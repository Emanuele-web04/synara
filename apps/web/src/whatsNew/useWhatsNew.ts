import { Schema } from "effect";
import { useEffect, useRef, useState } from "react";

import { APP_VERSION } from "../branding";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { WHATS_NEW_ENTRIES } from "./entries";
import {
  resolveWhatsNewState,
  type WhatsNewEntry,
  type WhatsNewInputs,
  type WhatsNewState,
} from "./logic";

const WHATS_NEW_STORAGE_KEY = "synara:whats-new:v1";

// Using an Option<string> via Schema.NullOr keeps the "never seen" sentinel explicit on disk. Omitting the field (undefined) would round-trip poorly through JSON; `null` stays faithful across reloads.
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
  readonly allEntries: readonly WhatsNewEntry[];
  readonly currentVersion: string;
  readonly isPopoutVisible: boolean;
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

  // Snapshot the decision once per mount using the initial storage value so that updating localStorage (e.g. acknowledging the dialog) doesn't flip the UI back and forth while animations are still running.
  const [initialLastSeenVersion] = useState(() => storage.lastSeenVersion);
  const initialState: WhatsNewState = resolveWhatsNewState({
    entries,
    currentVersion,
    lastSeenVersion: initialLastSeenVersion,
  } satisfies WhatsNewInputs);

  // The popout starts visible only when we actually have something to show.
  const [isPopoutVisible, setIsPopoutVisible] = useState(initialState.kind === "show");
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  // silent bootstrap: advance the marker in the background so the next upgrade is detected; once-per-mount ref-guarded since initialState/setStorage identity isn't stable
  const silentBootstrapDoneRef = useRef(false);
  useEffect(() => {
    if (silentBootstrapDoneRef.current || initialState.kind !== "silent-bootstrap") {
      return;
    }
    silentBootstrapDoneRef.current = true;
    setStorage({ lastSeenVersion: initialState.nextLastSeenVersion });
  }, [initialState, setStorage]);

  const currentEntry: WhatsNewEntry | null =
    initialState.kind === "show" ? initialState.currentEntry : null;

  const allEntries: readonly WhatsNewEntry[] =
    initialState.kind === "show" ? initialState.allEntries : [];

  const markSeen = () => {
    if (initialState.kind === "show") {
      setStorage({ lastSeenVersion: initialState.nextLastSeenVersion });
    }
  };

  const openDialog = () => {
    // Just open the dialog. The user is about to read the notes — don't mark as seen yet; that happens on dialog close.
    setIsDialogOpen(true);
  };

  const dismissPopout = () => {
    // X on the card: treat as "I've acknowledged this update". Mark as seen and hide the popout forever (for this version).
    setIsPopoutVisible(false);
    markSeen();
  };

  const onDialogOpenChange = (open: boolean) => {
    setIsDialogOpen(open);
    if (!open) {
      // Dismissing the dialog = finished reading the notes. Hide the popout too so we don't leave the "click me" affordance lingering after the user clearly engaged.
      setIsPopoutVisible(false);
      markSeen();
    }
  };

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

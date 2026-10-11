// FILE: ShortcutRecorderDialog.tsx
// Purpose: The small dialog that records a command's shortcut: press the keys, see them
//          as keycaps, save.
// Layer: Settings UI components
// Depends on: the shortcut editor model, key capture, the shared dialog, and Keycap.

import type { KeybindingShortcut, ServerKeybindingEdit } from "@synara/contracts";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { Keycap } from "~/components/ui/keycap";
import {
  buildShortcutEditorRows,
  evaluateRecordedShortcut,
  shortcutModifierHint,
  shortcutResetEdits,
  shortcutResetTakeovers,
  shortcutSaveEdits,
  type ShortcutEditorBinding,
  type ShortcutEditorRow,
  type ShortcutEditorSource,
} from "~/keybindingEditor";
import { formatShortcutLabel, splitShortcutLabel, suspendShortcutDispatch } from "~/keybindings";
import { CentralIcon } from "~/lib/central-icons";
import { CircleCheckIcon, TriangleAlertIcon } from "~/lib/icons";
import {
  shortcutFromKeyboardEvent,
  shortcutModifiersFromKeyboardEvent,
} from "~/lib/keybindingCapture";
import { cn, isMacPlatform } from "~/lib/utils";

export interface ShortcutRecorderTarget {
  /** The row as it was when the dialog opened; the live one is looked up by its id. */
  row: ShortcutEditorRow;
  /** The binding being changed, or null when the command gains a new one. */
  binding: ShortcutEditorBinding | null;
  /** Differs on every open, so a dialog reopened while it is still closing starts fresh. */
  session: number;
}

/** What the recording is judged against: the live bindings, or the ones a save started from. */
interface RecorderView {
  source: ShortcutEditorSource;
  row: ShortcutEditorRow;
  binding: ShortcutEditorBinding | null;
}

type ShortcutModifiers = Omit<KeybindingShortcut, "key">;

const NO_MODIFIERS: ShortcutModifiers = {
  modKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
};
const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift", "AltGraph", "OS"]);
const KEY_PRESS_MS = 90;

function hasModifier(modifiers: ShortcutModifiers): boolean {
  return (
    modifiers.modKey ||
    modifiers.metaKey ||
    modifiers.ctrlKey ||
    modifiers.altKey ||
    modifiers.shiftKey
  );
}

/**
 * The character the chord types on the user's keyboard, when it is one people need:
 * Option on macOS, and AltGr (Ctrl+Alt) elsewhere, type "@", "{" or "|" on many
 * layouts, and a shortcut on that chord takes the character away from every field.
 */
function typedCharacter(
  event: KeyboardEvent,
  shortcut: KeybindingShortcut,
  platform: string,
): string | null {
  // Shift alone changes "1" to "!" on every layout; that is not a character the
  // chord takes away.
  const charChord = isMacPlatform(platform)
    ? event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey
    : event.altKey && event.ctrlKey && !event.metaKey && !event.shiftKey;
  if (!charChord || !/^[\x21-\x7e]$/.test(event.key)) return null;
  return event.key.toLowerCase() === shortcut.key ? null : event.key;
}

function joinPhrases(phrases: readonly string[]): string {
  return phrases.length <= 2
    ? phrases.join(" and ")
    : `${phrases.slice(0, 2).join(", ")} and ${phrases.length - 2} more`;
}

function joinLabels(labels: readonly string[]): string {
  return joinPhrases(labels.map((label) => `“${label}”`));
}

export function ShortcutRecorderDialog({
  open,
  target,
  source,
  onOpenChange,
  onApply,
}: {
  open: boolean;
  target: ShortcutRecorderTarget | null;
  /** The live bindings. */
  source: ShortcutEditorSource;
  onOpenChange: (open: boolean) => void;
  /** Sends the edits; resolves false when the server rejected them. */
  onApply: (edits: ServerKeybindingEdit[]) => Promise<boolean>;
}) {
  const keyWellRef = useRef<HTMLDivElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-[380px]" showCloseButton={false} initialFocus={keyWellRef}>
        {/* Recording state lives below DialogPopup, which unmounts its children once
            closed. A reopen during the closing animation keeps them mounted, so the
            session key starts every open from the binding being edited. */}
        {target ? (
          <ShortcutRecorder
            key={target.session}
            target={target}
            source={source}
            active={open}
            keyWellRef={keyWellRef}
            onClose={() => onOpenChange(false)}
            onApply={onApply}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function ShortcutRecorder({
  target,
  source: liveSource,
  active,
  keyWellRef,
  onClose,
  onApply,
}: {
  target: ShortcutRecorderTarget;
  source: ShortcutEditorSource;
  /** False while the dialog closes: keys go back to the app at once. */
  active: boolean;
  keyWellRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onApply: (edits: ServerKeybindingEdit[]) => Promise<boolean>;
}) {
  const statusId = useId();
  // Judge against the live bindings, so a change made elsewhere while the dialog is open
  // (another window, keybindings.json) is never overwritten from an old copy. Once a
  // save starts, hold the view it started from: the save itself changes the bindings.
  const liveRow =
    buildShortcutEditorRows(liveSource).find((candidate) => candidate.id === target.row.id) ?? null;
  const liveBinding = target.binding
    ? (liveRow?.bindings.find((candidate) => candidate.id === target.binding?.id) ?? null)
    : null;
  const [frozenView, setFrozenView] = useState<RecorderView | null>(null);
  const stale = frozenView === null && (!liveRow || (target.binding !== null && !liveBinding));
  const view: RecorderView = frozenView ?? {
    source: liveSource,
    row: liveRow ?? target.row,
    binding: target.binding ? (liveBinding ?? target.binding) : null,
  };
  const { row, binding, source } = view;
  const { platform } = source;
  const [recorded, setRecorded] = useState<KeybindingShortcut | null>(
    target.binding?.rules[0]?.shortcut ?? null,
  );
  const [character, setCharacter] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const liveRef = useRef(true);
  const [heldModifiers, setHeldModifiers] = useState<ShortcutModifiers>(NO_MODIFIERS);
  // Held modifiers preview the next shortcut until a key lands; after that the recorded
  // keys stay up while the modifiers are still down.
  const [capturedSinceModifiers, setCapturedSinceModifiers] = useState(false);
  const [unsupportedKey, setUnsupportedKey] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const pressTimeoutRef = useRef<number | null>(null);

  const recording = evaluateRecordedShortcut({
    source,
    row,
    replacing: binding,
    shortcut: recorded,
  });
  const canSave = recording.status === "ready" && !unsupportedKey && !isSaving && !stale;
  const canReset = !row.isDefault && source.defaultKeybindings !== undefined && !stale;
  const resetTakeovers = canReset ? shortcutResetTakeovers(source, row) : [];
  // Only while there is still something to warn about: the bindings can change under it.
  const confirmReset = confirmingReset && resetTakeovers.length > 0;
  const isPreviewing = hasModifier(heldModifiers) && !capturedSinceModifiers;

  const shortcutLabel = (shortcut: KeybindingShortcut) =>
    row.numbered
      ? `${formatShortcutLabel({ ...shortcut, key: "1" }, platform)}–9`
      : formatShortcutLabel(shortcut, platform);

  const apply = async (edits: ServerKeybindingEdit[]) => {
    if (isSaving) return;
    setIsSaving(true);
    setFrozenView(view);
    const applied = await onApply(edits);
    // Closed (Escape) or replaced by a newer open while the save was in flight: that
    // dialog is no longer this one to close or update.
    if (!liveRef.current) return;
    if (applied) {
      onClose();
      return;
    }
    setFrozenView(null);
    setIsSaving(false);
    setConfirmingReset(false);
  };
  const save = () => {
    if (recording.status === "ready" && canSave) void apply(shortcutSaveEdits(recording, binding));
  };
  // Resetting can take a shortcut from another command; say so once before doing it.
  const reset = () => {
    if (resetTakeovers.length > 0 && !confirmReset) {
      setConfirmingReset(true);
      return;
    }
    void apply(shortcutResetEdits(source, row));
  };

  const handleModifierChange = useEffectEvent((event: KeyboardEvent) => {
    if (!hasModifier(heldModifiers)) setCapturedSinceModifiers(false);
    setHeldModifiers(shortcutModifiersFromKeyboardEvent(event, platform));
  });
  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (MODIFIER_KEYS.has(event.key)) {
      handleModifierChange(event);
      return;
    }
    const bare = !event.metaKey && !event.ctrlKey && !event.altKey;
    // Escape closes the dialog, Tab still walks its buttons, and Enter or Space on a
    // focused button presses it. Everything else is a key being recorded.
    if (bare && !event.shiftKey && event.key === "Escape") return;
    if (bare && event.key === "Tab") return;
    const onButton = event.target instanceof Element && event.target.closest("button") !== null;
    const activates = event.key === "Enter" || event.key === " ";
    if (bare && !event.shiftKey && activates && onButton) return;

    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    if (bare && !event.shiftKey && event.key === "Enter") {
      save();
      return;
    }

    const shortcut = shortcutFromKeyboardEvent(event, platform);
    setCapturedSinceModifiers(true);
    setUnsupportedKey(shortcut === null);
    setConfirmingReset(false);
    if (!shortcut) return;
    setRecorded(shortcut);
    setCharacter(typedCharacter(event, shortcut, platform));
    setPressed(true);
    if (pressTimeoutRef.current !== null) window.clearTimeout(pressTimeoutRef.current);
    pressTimeoutRef.current = window.setTimeout(() => setPressed(false), KEY_PRESS_MS);
  });
  const handleKeyUp = useEffectEvent((event: KeyboardEvent) => {
    if (MODIFIER_KEYS.has(event.key)) handleModifierChange(event);
  });

  useEffect(() => {
    liveRef.current = active;
    return () => {
      liveRef.current = false;
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    // While recording, no shortcut fires, so every key reaches the recorder.
    const resume = suspendShortcutDispatch();
    const onKeyDown = (event: KeyboardEvent) => handleKeyDown(event);
    const onKeyUp = (event: KeyboardEvent) => handleKeyUp(event);
    const onBlur = () => setHeldModifiers(NO_MODIFIERS);
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
      window.removeEventListener("blur", onBlur);
      if (pressTimeoutRef.current !== null) window.clearTimeout(pressTimeoutRef.current);
      resume();
    };
  }, [active]);

  const problem = stale
    ? "This shortcut changed while the dialog was open. Close it and try again."
    : unsupportedKey
      ? "That key can't be used in a shortcut. Try another."
      : recording.status === "problem"
        ? recording.message
        : null;
  const conflicts = recording.status === "ready" && !unsupportedKey ? recording.conflicts : [];
  const resetWarning =
    confirmReset && !problem
      ? `Resetting takes back ${joinPhrases(
          resetTakeovers.map(
            ({ rule, label }) => `${formatShortcutLabel(rule.shortcut, platform)} from “${label}”`,
          ),
        )}.`
      : null;
  const caution =
    recording.status === "ready" && recorded && character
      ? `On your keyboard, ${shortcutLabel(recorded)} types “${character}”. Saving it stops those keys from typing it.`
      : null;

  return (
    <div className="flex flex-col gap-3 px-4 pt-4 pb-3">
      <div className="flex items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-[9px] border border-[color:var(--color-border)] bg-muted text-foreground">
          <CentralIcon name="shortcut" className="size-4.5" />
        </div>
        <div className="min-w-0 space-y-0.5">
          <DialogTitle className="truncate text-[15px]">{row.label}</DialogTitle>
          <DialogDescription className="text-ui-sm">
            {binding ? "Press new keys to change its shortcut." : "Choose the keys that run it."}
          </DialogDescription>
        </div>
      </div>

      {/* The recessed tray the keycaps sit in, like the keyboard's own well. */}
      <div
        ref={keyWellRef}
        tabIndex={-1}
        role="group"
        aria-label={recorded ? `Shortcut ${shortcutLabel(recorded)}` : "Type a shortcut"}
        aria-describedby={statusId}
        className="flex min-h-[88px] items-center justify-center gap-2 rounded-xl border border-[color:var(--color-border)] bg-muted px-3 shadow-[inset_0_1px_3px_rgba(0,0,0,0.12)] outline-none dark:shadow-[inset_0_1px_3px_rgba(0,0,0,0.5)]"
      >
        {isPreviewing ? (
          <>
            {splitShortcutLabel(formatShortcutLabel({ ...heldModifiers, key: "" }, platform)).map(
              (label) => (
                <Keycap key={label} label={label} pressed />
              ),
            )}
            <Keycap label={row.numbered ? "1–9" : " "} pending />
          </>
        ) : recorded ? (
          <>
            {splitShortcutLabel(shortcutLabel(recorded)).map((label) => (
              <Keycap key={label} label={label} pressed={pressed} />
            ))}
          </>
        ) : (
          <span className="text-ui font-medium text-muted-foreground/70">Type a shortcut</span>
        )}
      </div>

      <div
        id={statusId}
        role="status"
        className={cn(
          "flex min-h-[2lh] items-start gap-1.5 text-ui-sm leading-snug",
          problem
            ? "text-destructive"
            : resetWarning || conflicts.length > 0 || caution
              ? "text-warning"
              : "text-muted-foreground",
        )}
      >
        {problem ? (
          <>
            <TriangleAlertIcon className="mt-px size-3.5 shrink-0" />
            <span>{problem}</span>
          </>
        ) : resetWarning ? (
          <>
            <TriangleAlertIcon className="mt-px size-3.5 shrink-0" />
            <span>{resetWarning}</span>
          </>
        ) : recording.status === "ready" && recorded ? (
          conflicts.length > 0 || caution ? (
            <>
              <TriangleAlertIcon className="mt-px size-3.5 shrink-0" />
              <span>
                {conflicts.length > 0
                  ? `${shortcutLabel(recorded)} already runs ${joinLabels([
                      ...new Set(conflicts.map((conflict) => conflict.label)),
                    ])}. Saving moves it here.`
                  : null}
                {conflicts.length > 0 && caution ? " " : null}
                {caution}
              </span>
            </>
          ) : (
            <>
              <CircleCheckIcon className="mt-px size-3.5 shrink-0 text-success" />
              <span className="text-foreground/85">{shortcutLabel(recorded)} is available.</span>
            </>
          )
        ) : (
          <span>
            {row.numbered
              ? "Hold the modifiers, then press any number key."
              : shortcutModifierHint(platform)}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {canReset ? (
          <Button
            size="sm"
            variant="ghost"
            className="-ml-2 font-normal"
            disabled={isSaving}
            // A double click would land its second click on "Reset anyway".
            onClick={(event) => {
              if (event.detail <= 1) reset();
            }}
          >
            {confirmReset ? "Reset anyway" : "Reset to default"}
          </Button>
        ) : null}
        <div className="flex-1" />
        <Button size="sm" variant="outline" disabled={isSaving} onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" disabled={!canSave} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}

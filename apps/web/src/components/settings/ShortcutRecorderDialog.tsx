// FILE: ShortcutRecorderDialog.tsx
// Purpose: The small dialog that records a command's shortcut: press the keys, see them
//          as keycaps, save.
// Layer: Settings UI components
// Depends on: the shortcut editor model, key capture, the shared dialog, and Keycap.

import type { KeybindingShortcut, ServerKeybindingEdit } from "@synara/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { Keycap } from "~/components/ui/keycap";
import {
  evaluateRecordedShortcut,
  shortcutModifierHint,
  shortcutResetEdits,
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
import { cn } from "~/lib/utils";

export interface ShortcutRecorderTarget {
  row: ShortcutEditorRow;
  /** The binding being changed, or null when the command gains a new one. */
  binding: ShortcutEditorBinding | null;
  /** Bindings as they were when the dialog opened, so a save does not re-judge itself. */
  source: ShortcutEditorSource;
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

function joinLabels(labels: readonly string[]): string {
  const quoted = labels.map((label) => `“${label}”`);
  return quoted.length <= 2
    ? quoted.join(" and ")
    : `${quoted.slice(0, 2).join(", ")} and ${quoted.length - 2} more`;
}

export function ShortcutRecorderDialog({
  open,
  target,
  onOpenChange,
  onApply,
}: {
  open: boolean;
  target: ShortcutRecorderTarget | null;
  onOpenChange: (open: boolean) => void;
  /** Sends the edits; resolves false when the server rejected them. */
  onApply: (edits: ServerKeybindingEdit[]) => Promise<boolean>;
}) {
  const keyWellRef = useRef<HTMLDivElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-[380px]" showCloseButton={false} initialFocus={keyWellRef}>
        {/* Recording state lives below DialogPopup, which unmounts its children on
            close: every open starts from the binding being edited. */}
        {target ? (
          <ShortcutRecorder
            target={target}
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
  keyWellRef,
  onClose,
  onApply,
}: {
  target: ShortcutRecorderTarget;
  keyWellRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onApply: (edits: ServerKeybindingEdit[]) => Promise<boolean>;
}) {
  const { row, binding, source } = target;
  const { platform } = source;
  const [recorded, setRecorded] = useState<KeybindingShortcut | null>(
    binding?.rules[0]?.shortcut ?? null,
  );
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
  const canSave = recording.status === "ready" && !unsupportedKey && !isSaving;
  const canReset = !row.isDefault && source.defaultKeybindings !== undefined;
  const isPreviewing = hasModifier(heldModifiers) && !capturedSinceModifiers;

  const shortcutLabel = (shortcut: KeybindingShortcut) =>
    row.numbered
      ? `${formatShortcutLabel({ ...shortcut, key: "1" }, platform)}–9`
      : formatShortcutLabel(shortcut, platform);

  const apply = async (edits: ServerKeybindingEdit[]) => {
    if (isSaving) return;
    setIsSaving(true);
    if (await onApply(edits)) {
      onClose();
      return;
    }
    setIsSaving(false);
  };
  const save = () => {
    if (recording.status === "ready" && canSave) void apply(shortcutSaveEdits(recording, binding));
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
    if (!shortcut) return;
    setRecorded(shortcut);
    setPressed(true);
    if (pressTimeoutRef.current !== null) window.clearTimeout(pressTimeoutRef.current);
    pressTimeoutRef.current = window.setTimeout(() => setPressed(false), KEY_PRESS_MS);
  });
  const handleKeyUp = useEffectEvent((event: KeyboardEvent) => {
    if (MODIFIER_KEYS.has(event.key)) handleModifierChange(event);
  });

  useEffect(() => {
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
  }, []);

  const problem = unsupportedKey
    ? "That key can't be used in a shortcut. Try another."
    : recording.status === "problem"
      ? recording.message
      : null;
  const conflicts = recording.status === "ready" && !unsupportedKey ? recording.conflicts : [];

  return (
    <div className="flex flex-col gap-3.5 px-5 pt-5 pb-4">
      <div className="flex items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-[9px] border border-[color:var(--color-border)] bg-muted text-foreground">
          <CentralIcon name="shortcut" className="size-5" />
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
        className="flex min-h-[104px] items-center justify-center gap-2 rounded-xl border border-[color:var(--color-border)] bg-muted px-3 shadow-[inset_0_1px_3px_rgba(0,0,0,0.12)] outline-none dark:shadow-[inset_0_1px_3px_rgba(0,0,0,0.5)]"
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
            <span className="sr-only">Shortcut {shortcutLabel(recorded)}</span>
            {splitShortcutLabel(shortcutLabel(recorded)).map((label) => (
              <Keycap key={label} label={label} pressed={pressed} />
            ))}
          </>
        ) : (
          <span className="text-ui font-medium text-muted-foreground/70">Type a shortcut</span>
        )}
      </div>

      <div
        role="status"
        className={cn(
          "flex min-h-[30px] items-start gap-1.5 text-ui-sm leading-snug",
          problem
            ? "text-destructive"
            : conflicts.length > 0
              ? "text-warning"
              : "text-muted-foreground",
        )}
      >
        {problem ? (
          <>
            <TriangleAlertIcon className="mt-px size-3.5 shrink-0" />
            <span>{problem}</span>
          </>
        ) : recording.status === "ready" && recorded ? (
          conflicts.length > 0 ? (
            <>
              <TriangleAlertIcon className="mt-px size-3.5 shrink-0" />
              <span>
                {shortcutLabel(recorded)} already runs{" "}
                {joinLabels([...new Set(conflicts.map((conflict) => conflict.label))])}. Saving
                moves it here.
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
            onClick={() => void apply(shortcutResetEdits(source, row))}
          >
            Reset to default
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

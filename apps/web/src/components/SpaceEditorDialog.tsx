// FILE: SpaceEditorDialog.tsx
// Purpose: Shared create/edit dialog for a Space name and curated Central icon.

import { SPACE_NAME_MAX_LENGTH, type SpaceIconName } from "@synara/contracts";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { suggestSpaceIcon } from "~/lib/spaceIconSuggestion";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { SPACE_ICON_OPTIONS, SpaceIcon } from "./SpaceIcon";
import { cn } from "~/lib/utils";

const DEFAULT_SPACE_ICON: SpaceIconName = "bag";

const FIELD_LABEL_CLASS_NAME =
  "text-[length:var(--app-font-size-ui-sm,11px)] font-medium text-foreground/80";

const ICON_CELL_CLASS_NAME =
  "flex aspect-square cursor-pointer items-center justify-center rounded-lg border text-muted-foreground transition-colors outline-hidden hover:bg-foreground/6 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50";

export interface SpaceEditorValue {
  readonly name: string;
  readonly icon: SpaceIconName;
}

export function SpaceEditorDialog(props: {
  open: boolean;
  mode: "create" | "edit";
  initialValue?: SpaceEditorValue | undefined;
  existingNames: ReadonlyArray<string>;
  onOpenChange: (open: boolean) => void;
  onSubmit: (value: SpaceEditorValue) => Promise<void> | void;
}) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<SpaceIconName>(DEFAULT_SPACE_ICON);
  /**
   * In create mode the icon tracks the name (`suggestSpaceIcon`) until the user taps
   * the grid, which pins their choice. Edit mode starts pinned: a rename must never
   * silently swap an icon someone already chose.
   */
  const [iconPinned, setIconPinned] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const openedRef = useRef(false);
  const fieldId = useId();
  const nameInputId = `${fieldId}-name`;
  const nameErrorId = `${fieldId}-name-error`;
  const iconLegendId = `${fieldId}-icon-legend`;

  useEffect(() => {
    // Seed on the closed -> open transition only. `initialValue` is recomputed from the
    // live snapshot every render, so seeding whenever it changes would let a rename from
    // another window overwrite the name the user is part-way through typing here.
    if (props.open === openedRef.current) return;
    openedRef.current = props.open;
    if (!props.open) return;
    setName(props.initialValue?.name ?? "");
    setIcon(props.initialValue?.icon ?? DEFAULT_SPACE_ICON);
    setIconPinned(props.mode === "edit");
    setSubmitting(false);
    setSubmitError(null);
    // Deferred a frame: the dialog moves focus itself on open, so selecting the name
    // has to happen after that lands or it is immediately undone. Matches PickerPanelShell.
    const frame = requestAnimationFrame(() => nameInputRef.current?.select());
    return () => cancelAnimationFrame(frame);
  }, [props.initialValue?.icon, props.initialValue?.name, props.mode, props.open]);

  const trimmedName = name.trim();
  const duplicateName = props.existingNames.some(
    (existingName) => existingName.trim().toLowerCase() === trimmedName.toLowerCase(),
  );
  const nameError =
    trimmedName.length === 0
      ? "Enter a space name."
      : trimmedName.toLowerCase() === "void"
        ? "Void is reserved for unassigned projects."
        : duplicateName
          ? "A space with this name already exists."
          : null;
  // An empty field is a starting point, not a mistake — only speak up once there is input.
  const visibleNameError = name.length > 0 ? nameError : null;

  const submit = async () => {
    if (nameError || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await props.onSubmit({ name: trimmedName, icon });
      props.onOpenChange(false);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Unable to save the space.");
      setSubmitting(false);
    }
  };

  // The grid reflows between 10 and 5 columns, so the icons are driven as one linear
  // radio group: either axis steps to the neighbouring icon and selects it.
  const handleIconKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const stepByKey: Record<string, number | "first" | "last"> = {
      ArrowLeft: -1,
      ArrowUp: -1,
      ArrowRight: 1,
      ArrowDown: 1,
      Home: "first",
      End: "last",
    };
    const step = stepByKey[event.key];
    if (step === undefined) return;
    const cells = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-space-icon]"),
    );
    if (cells.length === 0) return;
    const currentIndex = cells.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex =
      step === "first"
        ? 0
        : step === "last"
          ? cells.length - 1
          : (Math.max(currentIndex, 0) + step + cells.length) % cells.length;
    event.preventDefault();
    cells[nextIndex]?.focus();
    cells[nextIndex]?.click();
  }, []);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup surface="solid" className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{props.mode === "create" ? "New space" : "Edit space"}</DialogTitle>
          <DialogDescription>
            {props.mode === "create"
              ? "Group projects into a focused work context. Projects you add while a space is open land in it."
              : "Rename this space or give it a different icon. Its projects stay where they are."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {/* The error sits outside the label on purpose: text inside a wrapping label
              becomes part of the field's accessible name, so nesting it here would have
              the field announce itself as "Name A space with this name already exists."
              and then repeat the message as its description. */}
          <div className="space-y-1.5">
            <label htmlFor={nameInputId} className={cn("block", FIELD_LABEL_CLASS_NAME)}>
              Name
            </label>
            <Input
              id={nameInputId}
              ref={nameInputRef}
              value={name}
              maxLength={SPACE_NAME_MAX_LENGTH}
              aria-invalid={Boolean(visibleNameError)}
              {...(visibleNameError ? { "aria-describedby": nameErrorId } : {})}
              onChange={(event) => {
                setName(event.target.value);
                // The icon follows the name until the user pins one from the grid.
                if (!iconPinned) setIcon(suggestSpaceIcon(event.target.value));
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder="Work"
            />
            {visibleNameError ? (
              <p
                id={nameErrorId}
                role="alert"
                className="text-[length:var(--app-font-size-ui-xs,10px)] text-destructive"
              >
                {visibleNameError}
              </p>
            ) : null}
          </div>

          <fieldset>
            <legend id={iconLegendId} className={cn("mb-2", FIELD_LABEL_CLASS_NAME)}>
              Icon
            </legend>
            <div
              role="radiogroup"
              aria-labelledby={iconLegendId}
              onKeyDown={handleIconKeyDown}
              className="grid grid-cols-10 gap-1.5 max-sm:grid-cols-5"
            >
              {SPACE_ICON_OPTIONS.map((option) => {
                const selected = icon === option.name;
                return (
                  <button
                    key={option.name}
                    type="button"
                    role="radio"
                    data-space-icon
                    aria-checked={selected}
                    aria-label={option.label}
                    // Roving tabindex: the whole grid is one tab stop.
                    tabIndex={selected ? 0 : -1}
                    onClick={() => {
                      setIcon(option.name);
                      setIconPinned(true);
                    }}
                    className={cn(
                      ICON_CELL_CLASS_NAME,
                      selected
                        ? "border-foreground/25 bg-foreground/9 text-foreground"
                        : "border-transparent bg-foreground/3",
                    )}
                  >
                    <SpaceIcon icon={option.name} />
                  </button>
                );
              })}
            </div>
          </fieldset>
          {submitError ? (
            <p
              role="alert"
              className="text-[length:var(--app-font-size-ui-xs,10px)] text-destructive"
            >
              {submitError}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => props.onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={Boolean(nameError) || submitting}>
            {submitting ? "Saving…" : props.mode === "create" ? "Create space" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

// FILE: EditorActionPicker.tsx
// Purpose: Synara's command picker for editor commands, navigation results,
//          problems and workspace symbols.
// Layer: Web editor UI
// Exports: EditorActionPicker, EditorActionRow

import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
  CommandStatus,
} from "../ui/command";

export interface EditorActionRow {
  id: string;
  label: string;
  /** Secondary text: a location, a severity, an action kind. */
  detail?: string | undefined;
  /** The configured chord, formatted for the platform (ShortcutKbd capsule). */
  shortcut?: string | undefined;
  run: () => void | Promise<void>;
}

export function EditorActionPicker(props: {
  open: boolean;
  title: string;
  query: string;
  rows: readonly EditorActionRow[];
  busy: boolean;
  message?: string | null;
  onQueryChange: (query: string) => void;
  onClose: () => void;
  onChoose: (row: EditorActionRow) => void;
}) {
  return (
    <CommandDialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <CommandDialogPopup aria-label={props.title}>
        <Command items={props.rows.map((row) => row.id)} mode="none">
          <CommandInput
            aria-label={props.title}
            placeholder={props.title}
            value={props.query}
            onChange={(event) => props.onQueryChange(event.currentTarget.value)}
          />
          <CommandStatus>
            {props.busy
              ? "Searching…"
              : (props.message ?? (props.rows.length ? null : "No matching results."))}
          </CommandStatus>
          <CommandList className="max-h-80 overflow-auto">
            {props.rows.map((row, index) => (
              <CommandItem
                key={row.id}
                index={index}
                value={row.id}
                onClick={() => props.onChoose(row)}
              >
                <span className="min-w-0 flex-1 truncate text-ui">{row.label}</span>
                {row.detail ? (
                  <span className="max-w-[55%] truncate text-ui-sm text-muted-foreground">
                    {row.detail}
                  </span>
                ) : null}
                {row.shortcut ? <CommandShortcut>{row.shortcut}</CommandShortcut> : null}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}

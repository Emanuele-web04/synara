import { useId, useState, useSyncExternalStore } from "react";
import { Button } from "../ui/button";
import { EditorExtensionContributions } from "./EditorExtensionContributions";
import { Dialog, DialogPopup, DialogTitle, DialogDescription, DialogFooter } from "../ui/dialog";
import { Input } from "../ui/input";
import { EditorActionPicker } from "./EditorActionPicker";
import {
  extensionRecord,
  type EditorExtensionBridge,
  type ExtensionInteraction,
} from "./editorExtensionBridge";
import type { EditorModelEntry } from "./editorModels";

function ExtensionPrompt({
  bridge,
  interaction,
}: {
  bridge: EditorExtensionBridge;
  interaction: ExtensionInteraction;
}) {
  const id = useId();
  const [value, setValue] = useState(() => {
    const options = interaction.params.options;
    return interaction.method === "ui.input" &&
      options &&
      typeof options === "object" &&
      "value" in options &&
      typeof options.value === "string"
      ? options.value
      : "";
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options =
    interaction.params.options === undefined ? {} : extensionRecord(interaction.params.options);
  const answer = async (response?: unknown) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await bridge.answer(interaction.id, response);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to answer extension.");
    } finally {
      setBusy(false);
    }
  };
  if (interaction.method === "ui.quickPick") {
    const rows = interaction.items
      .filter((item) =>
        `${item.label} ${item.detail ?? ""}`.toLowerCase().includes(value.toLowerCase()),
      )
      .map((item) => ({
        id: String(item.handle),
        label: item.label,
        ...(item.detail ? { detail: item.detail } : {}),
        run: () => answer(item.handle),
      }));
    return (
      <EditorActionPicker
        open
        title={typeof options.title === "string" ? options.title : "Extension selection"}
        query={value}
        onQueryChange={setValue}
        rows={rows}
        busy={busy}
        message={error}
        onClose={() => void answer()}
        onChoose={(row) => {
          void row.run();
        }}
      />
    );
  }
  const input = interaction.method === "ui.input";
  const description = input ? options.prompt : interaction.params.message;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) void answer();
      }}
    >
      <DialogPopup>
        <DialogTitle>
          {typeof options.title === "string"
            ? options.title
            : input
              ? "Extension input"
              : "Extension message"}
        </DialogTitle>
        <DialogDescription>
          {typeof description === "string"
            ? description
            : "An enabled extension requests your input."}
        </DialogDescription>
        {input ? (
          <div className="space-y-2">
            <label htmlFor={id} className="text-ui">
              {typeof options.placeHolder === "string" ? options.placeHolder : "Response"}
            </label>
            <Input
              id={id}
              type={options.password === true ? "password" : "text"}
              value={value}
              disabled={busy}
              maxLength={100_000}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void answer(value);
                }
              }}
            />
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-ui text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void answer()}>
            Cancel
          </Button>
          {input ? (
            <Button size="sm" disabled={busy} onClick={() => void answer(value)}>
              Submit
            </Button>
          ) : (
            interaction.items.map((item) => (
              <Button
                key={item.handle}
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void answer(item.handle)}
              >
                {item.label}
              </Button>
            ))
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Existing Synara dialogs and command pickers; never an embedded workbench. */
export function EditorExtensionInteraction({
  bridge,
  entry,
  owner,
}: {
  bridge: EditorExtensionBridge;
  entry: EditorModelEntry | null;
  owner?: object;
}) {
  const state = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
  const [contributionError, setContributionError] = useState<string | null>(null);
  if (!bridge.ownsInteraction(owner ?? entry)) return null;
  const interaction = state.interactions[0];
  return (
    <>
      {state.error ? (
        <div
          role="alert"
          className="border-t border-destructive/20 px-3 py-1 text-ui-sm text-destructive"
        >
          {state.error}
        </div>
      ) : null}
      {contributionError ? (
        <p role="alert" className="px-3 py-1 text-ui-sm text-destructive">
          {contributionError}
        </p>
      ) : null}
      <EditorExtensionContributions
        snapshot={state.contributions}
        controller={bridge.contributions}
        onError={(error) =>
          setContributionError(
            error instanceof Error ? error.message : "Extension contribution failed.",
          )
        }
      />
      {interaction ? (
        <ExtensionPrompt key={interaction.id} bridge={bridge} interaction={interaction} />
      ) : null}
    </>
  );
}

// FILE: ProviderInstanceEnvironmentEditor.tsx
// Purpose: Edit process-scoped environment variables for an individual provider instance.
// Layer: Settings UI components

import { Schema } from "effect";
import { useState } from "react";

import {
  ProviderInstanceEnvironmentVariableName,
  type ProviderInstanceEnvironment,
  type ProviderInstanceEnvironmentVariable,
} from "@synara/contracts";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { PlusIcon, XIcon } from "~/lib/icons";
import { DebouncedSettingTextInput } from "./DebouncedSettingTextInput";

const isEnvironmentVariableName = Schema.is(ProviderInstanceEnvironmentVariableName);

function isRedactedVariable(variable: ProviderInstanceEnvironmentVariable): boolean {
  return variable.sensitive === true && variable.valueRedacted === true;
}

// Rows are keyed by variable name, so a committed rename remounts the row. Commit
// names only on blur/Enter (never on a typing debounce) to keep focus stable.
function EnvVariableNameInput({
  id,
  name,
  disabled,
  title,
  onCommit,
}: {
  readonly id: string;
  readonly name: string;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly onCommit: (nextName: string) => void;
}) {
  const [draft, setDraft] = useState(name);
  return (
    <Input
      id={id}
      size="sm"
      variant="soft"
      className="w-2/5 font-mono"
      disabled={disabled}
      title={title}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          setDraft(name);
        }
      }}
      placeholder="VAR_NAME"
      spellCheck={false}
    />
  );
}

export function ProviderInstanceEnvironmentEditor({
  instanceId,
  environment,
  onChange,
}: {
  readonly instanceId: string;
  readonly environment: ProviderInstanceEnvironment | undefined;
  readonly onChange: (environment: ProviderInstanceEnvironment) => void;
}) {
  const entries = environment ?? [];
  const [draftName, setDraftName] = useState("");
  const [draftValue, setDraftValue] = useState("");
  const [draftSensitive, setDraftSensitive] = useState(false);

  const draftNameTrimmed = draftName.trim();
  const draftNameTaken = entries.some((entry) => entry.name === draftNameTrimmed);
  const canAddDraft = isEnvironmentVariableName(draftNameTrimmed) && !draftNameTaken;

  const replaceEntry = (index: number, next: ProviderInstanceEnvironmentVariable | null): void => {
    onChange(
      next === null
        ? entries.filter((_, entryIndex) => entryIndex !== index)
        : entries.map((entry, entryIndex) => (entryIndex === index ? next : entry)),
    );
  };

  const addDraft = (): void => {
    if (!canAddDraft) {
      return;
    }
    onChange([
      ...entries,
      { name: draftNameTrimmed, value: draftValue, sensitive: draftSensitive },
    ]);
    setDraftName("");
    setDraftValue("");
    setDraftSensitive(false);
  };

  return (
    <div className="space-y-2 sm:col-span-2">
      <span className="block text-xs font-medium text-foreground">Environment variables</span>
      <span className="block text-xs text-muted-foreground">
        Applied only to this instance&apos;s processes. Mark credentials as secret to store them
        redacted on the server.
      </span>

      {entries.map((entry, index) => {
        const redacted = isRedactedVariable(entry);
        return (
          <div key={`${instanceId}-env-${entry.name}`} className="flex items-center gap-2">
            <EnvVariableNameInput
              id={`provider-instance-${instanceId}-env-${index}-name`}
              disabled={redacted}
              name={entry.name}
              // The server stores redacted secrets by name and cannot move them
              // to a new key, so renaming a saved secret would silently drop it.
              onCommit={(nextName) => {
                const trimmed = nextName.trim();
                if (
                  redacted ||
                  trimmed === entry.name ||
                  !isEnvironmentVariableName(trimmed) ||
                  entries.some(
                    (other, otherIndex) => otherIndex !== index && other.name === trimmed,
                  )
                ) {
                  return;
                }
                replaceEntry(index, { ...entry, name: trimmed });
              }}
              {...(redacted
                ? { title: "Replace or remove the saved secret before renaming it." }
                : {})}
            />
            <DebouncedSettingTextInput
              id={`provider-instance-${instanceId}-env-${index}-value`}
              size="sm"
              variant="soft"
              className="flex-1 font-mono"
              type={entry.sensitive ? "password" : "text"}
              value={redacted ? "" : (entry.value ?? "")}
              onCommit={(nextValue) => {
                if (redacted && nextValue.length === 0) {
                  // Keep the stored secret when the redacted field is left untouched.
                  return;
                }
                const { valueRedacted: _valueRedacted, ...rest } = entry;
                replaceEntry(index, { ...rest, value: nextValue });
              }}
              placeholder={redacted ? "Secret saved — type to replace" : "value"}
              spellCheck={false}
            />
            <Switch
              checked={entry.sensitive === true}
              disabled={redacted}
              onCheckedChange={(checked) => replaceEntry(index, { ...entry, sensitive: checked })}
              aria-label={`Store ${entry.name} as a secret`}
            />
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => replaceEntry(index, null)}
              aria-label={`Remove ${entry.name}`}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        );
      })}

      <div className="flex items-center gap-2">
        <Input
          id={`provider-instance-${instanceId}-env-draft-name`}
          size="sm"
          variant="soft"
          className="w-2/5 font-mono"
          value={draftName}
          onChange={(event) => setDraftName(event.target.value)}
          placeholder="ANTHROPIC_API_KEY"
          spellCheck={false}
        />
        <Input
          id={`provider-instance-${instanceId}-env-draft-value`}
          size="sm"
          variant="soft"
          className="flex-1 font-mono"
          type={draftSensitive ? "password" : "text"}
          value={draftValue}
          onChange={(event) => setDraftValue(event.target.value)}
          placeholder="value"
          spellCheck={false}
        />
        <Switch
          checked={draftSensitive}
          onCheckedChange={setDraftSensitive}
          aria-label="Store new variable as a secret"
        />
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={!canAddDraft}
          onClick={addDraft}
        >
          <PlusIcon className="size-3.5" />
          Add
        </Button>
      </div>
    </div>
  );
}

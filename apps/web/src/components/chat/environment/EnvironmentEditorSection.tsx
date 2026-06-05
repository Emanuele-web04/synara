// FILE: EnvironmentEditorSection.tsx
// Purpose: "Editor" section of the Environment panel — one "Open in <editor>" row per
//          installed editor. Replaces the chat-header Open-in split button when the
//          controls are consolidated into the panel; shares launch logic via the
//          useEditorLaunchers hook so the two surfaces never drift.
// Layer: Environment panel section

import type { EditorId, ResolvedKeybindingsConfig } from "@t3tools/contracts";

import { useEditorLaunchers } from "~/hooks/useEditorLaunchers";

import {
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentRow,
  EnvironmentSectionLabel,
} from "./EnvironmentRow";

export function EnvironmentEditorSection({
  keybindings,
  availableEditors,
  openInCwd,
}: {
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
}) {
  const { options, openInEditor } = useEditorLaunchers({
    keybindings,
    availableEditors,
    openInCwd,
  });

  if (options.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-0.5">
      <EnvironmentSectionLabel>Editor</EnvironmentSectionLabel>
      {options.map(({ value, label, Icon }) => (
        <EnvironmentRow
          key={value}
          icon={<Icon aria-hidden className={ENVIRONMENT_ROW_ICON_CLASS_NAME} />}
          label={`Open in ${label}`}
          disabled={!openInCwd}
          onClick={() => openInEditor(value)}
        />
      ))}
    </div>
  );
}

// FILE: EnvironmentProjectInstructionsSection.tsx
// Purpose: Environment-panel section for project-scoped instructions that seed thread notes.
// Layer: Environment panel section
// Exports: EnvironmentProjectInstructionsSection

import { useCallback, useEffect, useRef, useState, type ChangeEventHandler } from "react";
import { THREAD_NOTES_MAX_CHARS, type ProjectId } from "@t3tools/contracts";

import { Textarea } from "~/components/ui/textarea";
import { Button } from "~/components/ui/button";
import { CopyIcon } from "~/lib/icons";

import { EnvironmentCollapsibleSection } from "./EnvironmentRow";

const PROJECT_INSTRUCTIONS_AUTOSAVE_DEBOUNCE_MS = 500;

interface PendingProjectInstructionsSave {
  readonly projectId: ProjectId;
  readonly value: string;
  readonly lastCommitted: string;
}

function useProjectInstructionsAutosave({
  projectId,
  instructions,
  onChange,
}: {
  readonly projectId: ProjectId | null;
  readonly instructions: string;
  readonly onChange: (projectId: ProjectId, instructions: string) => void;
}) {
  const [value, setValue] = useState(instructions);
  const [focused, setFocused] = useState(false);
  const debounceRef = useRef<number | null>(null);
  const valueRef = useRef(value);
  const lastCommittedRef = useRef(instructions);
  const projectIdRef = useRef(projectId);
  const pendingSaveRef = useRef<PendingProjectInstructionsSave | null>(null);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const flush = useCallback(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const pendingSave = pendingSaveRef.current;
    pendingSaveRef.current = null;
    if (pendingSave === null || pendingSave.value === pendingSave.lastCommitted) {
      return;
    }
    onChangeRef.current(pendingSave.projectId, pendingSave.value);
    if (projectIdRef.current === pendingSave.projectId) {
      lastCommittedRef.current = pendingSave.value;
    }
  }, []);

  useEffect(() => {
    const projectChanged = projectIdRef.current !== projectId;
    if (projectChanged) {
      flush();
      projectIdRef.current = projectId;
      pendingSaveRef.current = null;
      valueRef.current = instructions;
      lastCommittedRef.current = instructions;
      setValue(instructions);
      return;
    }
    projectIdRef.current = projectId;
    if (
      !focused &&
      debounceRef.current === null &&
      pendingSaveRef.current === null &&
      instructions !== valueRef.current
    ) {
      valueRef.current = instructions;
      lastCommittedRef.current = instructions;
      setValue(instructions);
    }
  }, [flush, focused, instructions, projectId]);

  useEffect(() => {
    return () => {
      flush();
    };
  }, [flush]);

  const handleChange = useCallback<ChangeEventHandler<HTMLTextAreaElement>>(
    (event) => {
      const nextValue = event.target.value;
      valueRef.current = nextValue;
      setValue(nextValue);
      const currentProjectId = projectIdRef.current;
      if (!currentProjectId) {
        pendingSaveRef.current = null;
        if (debounceRef.current !== null) {
          window.clearTimeout(debounceRef.current);
          debounceRef.current = null;
        }
        return;
      }
      // Keep the project id with the pending payload; active projects can switch before debounce fires.
      pendingSaveRef.current = {
        projectId: currentProjectId,
        value: nextValue,
        lastCommitted: lastCommittedRef.current,
      };
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
      }
      debounceRef.current = window.setTimeout(flush, PROJECT_INSTRUCTIONS_AUTOSAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  return {
    value,
    onChange: handleChange,
    onFocus: () => setFocused(true),
    onBlur: () => {
      setFocused(false);
      flush();
    },
  };
}

export function EnvironmentProjectInstructionsSection({
  projectId,
  instructions,
  threadNotes,
  canCopyToThreadNotes,
  onInstructionsChange,
  onCopyToThreadNotes,
}: {
  projectId: ProjectId | null;
  instructions: string;
  threadNotes: string;
  canCopyToThreadNotes: boolean;
  onInstructionsChange: (projectId: ProjectId, instructions: string) => void;
  onCopyToThreadNotes: () => void;
}) {
  const autosave = useProjectInstructionsAutosave({
    projectId,
    instructions,
    onChange: onInstructionsChange,
  });
  const hasInstructions = autosave.value.trim().length > 0;
  const copyLabel = threadNotes.trim().length === 0 ? "Copy to notepad" : "Append to notepad";

  return (
    <EnvironmentCollapsibleSection label="Project instructions" defaultOpen={hasInstructions}>
      <div className="flex flex-col gap-2 px-2 pb-1">
        <Textarea
          unstyled
          className="relative inline-flex w-full rounded-lg border border-[color:var(--color-border-light)] bg-transparent text-[length:var(--app-font-size-ui,12px)] text-foreground transition-colors has-focus-visible:border-foreground/25 [&_[data-slot=textarea]]:px-3 [&_[data-slot=textarea]]:py-2"
          value={autosave.value}
          onChange={autosave.onChange}
          onFocus={autosave.onFocus}
          onBlur={autosave.onBlur}
          placeholder="Architecture notes, conventions, repo links"
          maxLength={THREAD_NOTES_MAX_CHARS}
          disabled={!projectId}
        />
        {hasInstructions && canCopyToThreadNotes ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="self-start"
            onClick={onCopyToThreadNotes}
          >
            <CopyIcon className="size-3.5" />
            {copyLabel}
          </Button>
        ) : null}
      </div>
    </EnvironmentCollapsibleSection>
  );
}

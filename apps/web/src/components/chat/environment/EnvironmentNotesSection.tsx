import { THREAD_NOTES_MAX_CHARS, type ThreadId } from "@synara/contracts";

import { Textarea } from "~/components/ui/textarea";

import { EnvironmentCollapsibleSection } from "./EnvironmentRow";
import { useThreadNotesAutosave } from "./useThreadNotesAutosave";

export function EnvironmentNotesSection({
  threadId,
  notes,
  onChange,
}: {
  threadId: ThreadId;
  notes: string;
  onChange: (threadId: ThreadId, notes: string) => Promise<void>;
}) {
  const autosave = useThreadNotesAutosave({ threadId, notes, onChange });

  return (
    <EnvironmentCollapsibleSection label="Notepad">
      <div className="px-2 pb-1">
        <Textarea
          // `unstyled` drops the default filled surface + focus ring, which read as noisy in the panel; restyled transparent with a divider-toned border that warms on focus
          unstyled
          className="relative inline-flex w-full rounded-lg border border-[color:var(--color-border-light)] bg-transparent text-ui text-foreground transition-colors has-focus-visible:border-foreground/25 [&_[data-slot=textarea]]:px-3 [&_[data-slot=textarea]]:py-2"
          value={autosave.value}
          onChange={autosave.onChange}
          onFocus={autosave.onFocus}
          onBlur={autosave.onBlur}
          placeholder="Type here"
          maxLength={THREAD_NOTES_MAX_CHARS}
        />
      </div>
    </EnvironmentCollapsibleSection>
  );
}

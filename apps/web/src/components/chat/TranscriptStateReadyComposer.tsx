import { useCallback, useState, type FormEvent, type ReactElement } from "react";

import { ComposerPromptEditor } from "../ComposerPromptEditor";
import { Button } from "../ui/button";
import {
  COMPOSER_EDITOR_PADDING_CLASS_NAME,
  COMPOSER_FOOTER_ROW_CLASS_NAME,
  COMPOSER_INPUT_SHELL_CLASS_NAME,
  COMPOSER_INPUT_SURFACE_CLASS_NAME,
} from "./composerPickerStyles";
import {
  composerActionLabel,
  composerModeForScenario,
  composerPlaceholderForState,
  composerStatusLabel,
} from "./TranscriptStateComposer.logic";
import { TranscriptStateComposerStatus } from "./TranscriptStateComposerStatus";
import type { TranscriptScenarioState } from "./transcriptStateFixtures";
import { cn } from "~/lib/utils";

interface TranscriptStateReadyComposerProps {
  readonly state: TranscriptScenarioState;
  readonly className?: string;
}

export function TranscriptStateReadyComposer({
  state,
  className,
}: TranscriptStateReadyComposerProps): ReactElement {
  const mode = composerModeForScenario(state);
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const hasContent = draft.trim().length > 0;
  const statusLabel = submitted
    ? "Next turn staged in the lab"
    : composerStatusLabel(mode, state, null, false);

  const onDraftChange = useCallback(
    (
      nextValue: string,
      nextCursor: number,
      _expandedCursor: number,
      _cursorAdjacentToMention: boolean,
      _terminalContextIds: string[],
    ): void => {
      setDraft(nextValue);
      setCursor(nextCursor);
      setSubmitted(false);
    },
    [],
  );

  const noopComposerAction = useCallback((): void => undefined, []);

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      if (!hasContent) return;
      setDraft("");
      setCursor(0);
      setSubmitted(true);
    },
    [hasContent],
  );

  return (
    <form
      className={cn("mx-auto w-full max-w-[46rem]", className)}
      aria-label="Transcript lab composer"
      onSubmit={onSubmit}
    >
      <div className={cn(COMPOSER_INPUT_SHELL_CLASS_NAME, "overflow-hidden")}>
        <div className={cn(COMPOSER_INPUT_SURFACE_CLASS_NAME, "overflow-hidden")}>
          <div className={COMPOSER_EDITOR_PADDING_CLASS_NAME}>
            <ComposerPromptEditor
              value={draft}
              cursor={cursor}
              terminalContexts={[]}
              disabled={false}
              placeholder={composerPlaceholderForState(mode, state)}
              onRemoveTerminalContext={noopComposerAction}
              onChange={onDraftChange}
              onPaste={noopComposerAction}
              className="max-h-24 overflow-y-auto"
            />
          </div>
          <div className={cn(COMPOSER_FOOTER_ROW_CLASS_NAME, "gap-2")}>
            <TranscriptStateComposerStatus label={statusLabel} />
            <Button
              type="submit"
              size="sm"
              className="rounded-full px-4"
              disabled={!hasContent}
            >
              {composerActionLabel(mode, state)}
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}

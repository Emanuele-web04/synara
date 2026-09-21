// panicThreshold default makes bailouts silent (all auto-memoization lost); known triggers: default value in destructuring, ref read off props, value block or throw inside try, manual memo deps the compiler can't match

import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileReactModule } from "../test/reactCompiler";

interface HotPathModule {
  readonly relativePath: string;
  readonly requiredFunction?: string;
  // exact multiset of deliberate, reviewed bailout reasons — anything else (including a second copy of an allowed reason) fails the test
  readonly allowedBailoutReasons: readonly string[];
}

const HOT_PATH_MODULES: readonly HotPathModule[] = [
  { relativePath: "ChatView.tsx", requiredFunction: "ChatView", allowedBailoutReasons: [] },
  {
    relativePath: "chat/useChatTranscriptScroll.ts",
    requiredFunction: "useChatTranscriptScroll",
    allowedBailoutReasons: [],
  },
  {
    relativePath: "chat/useChatTimelineMessages.ts",
    requiredFunction: "useChatTimelineMessages",
    allowedBailoutReasons: [],
  },
  {
    relativePath: "chat/useChatWorkLog.ts",
    requiredFunction: "useChatWorkLog",
    allowedBailoutReasons: [],
  },
  {
    relativePath: "chat/useChatWorkspaceSelection.ts",
    requiredFunction: "useChatWorkspaceSelection",
    allowedBailoutReasons: [],
  },
  {
    relativePath: "chat/useChatProjectScripts.ts",
    requiredFunction: "useChatProjectScripts",
    allowedBailoutReasons: [],
  },
  {
    relativePath: "chat/useComposerAttachmentPersistence.ts",
    requiredFunction: "useComposerAttachmentPersistence",
    allowedBailoutReasons: [],
  },
  {
    relativePath: "chat/ChatComposerFooter.tsx",
    requiredFunction: "ChatComposerFooter",
    allowedBailoutReasons: [],
  },
  {
    relativePath: "chat/useComposerDiscovery.ts",
    requiredFunction: "useComposerDiscovery",
    allowedBailoutReasons: [],
  },
  {
    relativePath: "chat/useComposerReferences.ts",
    requiredFunction: "useComposerReferences",
    allowedBailoutReasons: [],
  },
  {
    relativePath: "chat/WorkflowRunCard.tsx",
    requiredFunction: "WorkflowRunCard",
    allowedBailoutReasons: [],
  },
  {
    relativePath: "chat/useChatProviderModels.ts",
    requiredFunction: "useChatProviderModels",
    allowedBailoutReasons: [],
  },
  {
    relativePath: "chat/useChatProviderStatus.ts",
    requiredFunction: "useChatProviderStatus",
    allowedBailoutReasons: [],
  },
  {
    relativePath: "chat/useChatRuntimeModes.ts",
    requiredFunction: "useChatRuntimeModes",
    allowedBailoutReasons: [],
  },
  {
    relativePath: "chat/useChatPendingInteractions.ts",
    requiredFunction: "useChatPendingInteractions",
    allowedBailoutReasons: [],
  },
  {
    relativePath: "chat/useChatComposerDraft.ts",
    requiredFunction: "useChatComposerDraft",
    allowedBailoutReasons: [],
  },
  {
    relativePath: "chat/useChatLocalDispatch.ts",
    requiredFunction: "useChatLocalDispatch",
    allowedBailoutReasons: [],
  },
  {
    relativePath: "chat/useChatAutomationCreation.ts",
    requiredFunction: "useChatAutomationCreation",
    allowedBailoutReasons: [],
  },
  {
    relativePath: "chat/useChatComposerEditing.ts",
    requiredFunction: "useChatComposerEditing",
    allowedBailoutReasons: [],
  },
  {
    relativePath: "chat/useChatComposerCommands.ts",
    requiredFunction: "useChatComposerCommands",
    allowedBailoutReasons: [],
  },
  {
    relativePath: "chat/useChatTurnSubmission.ts",
    requiredFunction: "useChatTurnSubmission",
    allowedBailoutReasons: [],
  },
  {
    relativePath: "chat/useChatTurnFollowUps.ts",
    requiredFunction: "useChatTurnFollowUps",
    allowedBailoutReasons: [],
  },
  {
    relativePath: "chat/useChatKeyboardShortcuts.ts",
    requiredFunction: "useChatKeyboardShortcuts",
    allowedBailoutReasons: [],
  },
  {
    relativePath: "chat/useChatQueuedTurns.ts",
    requiredFunction: "useChatQueuedTurns",
    allowedBailoutReasons: [],
  },
  {
    relativePath: "chat/useChatTurnExecution.ts",
    requiredFunction: "useChatTurnExecution",
    allowedBailoutReasons: [],
  },
  { relativePath: "Sidebar.tsx", allowedBailoutReasons: [] },
  {
    relativePath: "chat/MessagesTimeline.tsx",
    // `useStableRows` deliberately reads/rewrites a previous-state ref in its memo to reuse row identities across streaming updates
    allowedBailoutReasons: ["Cannot access refs during render"],
  },
  { relativePath: "chat/TimelineWorkEntryRow.tsx", allowedBailoutReasons: [] },
  { relativePath: "chat/ChatTranscriptPane.tsx", allowedBailoutReasons: [] },
  // the composer surface: these render or re-render on keystrokes while a picker or slash menu is open
  { relativePath: "chat/ComposerCommandMenu.tsx", allowedBailoutReasons: [] },
  { relativePath: "chat/ComposerMenuPanel.tsx", allowedBailoutReasons: [] },
  { relativePath: "chat/TraitsPicker.tsx", allowedBailoutReasons: [] },
  { relativePath: "chat/ProjectPicker.tsx", allowedBailoutReasons: [] },
  // Not chat-specific, but rendered inside every message row and sidebar row.
  { relativePath: "ui/button.tsx", allowedBailoutReasons: [] },
  // one per running thread in the sidebar; its ref + layout-effect timeline sync must not cost it memoization
  { relativePath: "ThreadRunningSpinner.tsx", allowedBailoutReasons: [] },
  { relativePath: "../lib/animationTimelineSync.ts", allowedBailoutReasons: [] },
  // a bailing hook doesn't stop its caller from compiling but loses its own memoization — these run on every composer keystroke and sidebar action
  { relativePath: "../hooks/useComposerSlashCommands.ts", allowedBailoutReasons: [] },
  { relativePath: "../hooks/useLocalStorage.ts", allowedBailoutReasons: [] },
  { relativePath: "../hooks/useSidebarThreadActions.ts", allowedBailoutReasons: [] },
];

/**
 * These are among the largest modules in the app — a cold
 * Babel compile of it was measured at 66s while the rest of the workspace suite competed for CPU.
 * The budget only exists to stop a hang, so it is set far above the observed worst case rather
 * than near it; a tight bound here fails the suite for machine load, not for a real regression.
 */
const COMPILE_TIMEOUT_MS = 240_000;

describe("chat hot-path React Compiler coverage", () => {
  for (const module of HOT_PATH_MODULES) {
    it(
      `compiles ${module.relativePath} without unexpected bailouts`,
      () => {
        const events = compileReactModule(join(import.meta.dirname, module.relativePath));
        const bailoutReasons = events
          .filter((event) => event.kind === "CompileError")
          .map((event) => event.detail?.reason ?? event.detail?.description ?? "unknown")
          .toSorted();

        // Pipeline failures (including stack overflows) do not emit CompileError.
        // A successful helper must not mask failure to compile the main component.
        expect(events.filter((event) => event.kind === "PipelineError")).toEqual([]);
        expect(bailoutReasons).toEqual(module.allowedBailoutReasons.toSorted());
        if (module.requiredFunction) {
          expect(
            events.some(
              (event) =>
                event.kind === "CompileSuccess" && event.fnName === module.requiredFunction,
            ),
          ).toBe(true);
        }
        expect(events.some((event) => event.kind === "CompileSuccess")).toBe(true);
      },
      COMPILE_TIMEOUT_MS,
    );
  }
});

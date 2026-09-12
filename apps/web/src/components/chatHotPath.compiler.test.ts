// FILE: chatHotPath.compiler.test.ts
// Purpose: Regression guard — the chat hot-path modules must stay fully
//          compilable by React Compiler. The compiler runs with the default
//          `panicThreshold`, so a bailout is silent: the module keeps
//          rendering but loses *all* auto-memoization. Everything listed below
//          renders (or gates) a message row, a sidebar row, or a keystroke, so a
//          silent bailout here costs whole-tree re-renders while typing.
//
//          Four triggers have actually shipped in this repo, all of them cheap to
//          avoid once known:
//            1. a default value inside a parameter destructuring pattern
//               (BuildHIR AssignmentPattern) — apply defaults in the body;
//            2. a ref-typed prop read off a `props` object (`ref={props.itemRef}`),
//               which spreads the ref verdict to every later `props.x` read —
//               destructure the props instead;
//            3. any value block (`??`, `&&`, `?.`, a ternary, a conditional
//               spread) or a `throw` inside a `try` — hoist it out, or move the
//               whole block to module scope;
//            4. a hand-written `useCallback`/`useMemo` dependency list the
//               compiler cannot match to its own inferred scope — drop the manual
//               memoization and let the compiler own it.
// Layer: Web build-integrity test
// Depends on: babel-plugin-react-compiler (same plugin the Vite build uses).

import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileReactModule } from "../test/reactCompiler";

interface HotPathModule {
  readonly relativePath: string;
  readonly requiredFunction?: string;
  // Exact multiset of bailout reasons that are deliberate and reviewed. Anything
  // else — including a second copy of an allowed reason — fails the test.
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
    // `useStableRows` and `useStableMessageTimelineEntries` deliberately read
    // and rewrite a previous-state ref inside their memo to reuse row/message
    // identities across streaming updates. That pattern is documented in place
    // and costs memoization only for those small hooks.
    allowedBailoutReasons: ["Cannot access refs during render", "Cannot access refs during render"],
  },
  { relativePath: "chat/TimelineWorkEntryRow.tsx", allowedBailoutReasons: [] },
  { relativePath: "chat/ChatTranscriptPane.tsx", allowedBailoutReasons: [] },
  // The composer surface: these three render or re-render on keystrokes while a
  // picker or the slash-command menu is open.
  { relativePath: "chat/ComposerCommandMenu.tsx", allowedBailoutReasons: [] },
  { relativePath: "chat/TraitsPicker.tsx", allowedBailoutReasons: [] },
  { relativePath: "chat/ProjectPicker.tsx", allowedBailoutReasons: [] },
  // Not chat-specific, but rendered inside every message row and sidebar row.
  { relativePath: "ui/button.tsx", allowedBailoutReasons: [] },
  // One per running thread in the sidebar; its ref + layout-effect timeline sync must
  // not cost it memoization.
  { relativePath: "ThreadRunningSpinner.tsx", allowedBailoutReasons: [] },
  { relativePath: "../lib/animationTimelineSync.ts", allowedBailoutReasons: [] },
  // Hooks called from the chat and sidebar render paths. A bailing hook does not
  // stop its caller from compiling, but it does lose its own memoization, and
  // these run on every composer keystroke and every sidebar action.
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

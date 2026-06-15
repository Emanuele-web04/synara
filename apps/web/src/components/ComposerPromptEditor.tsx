import { LexicalComposer, type InitialConfigType } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import {
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_TAB_COMMAND,
  COMMAND_PRIORITY_HIGH,
  KEY_BACKSPACE_COMMAND,
  $getRoot,
  type EditorState,
} from "lexical";
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type ClipboardEventHandler,
  type Ref,
} from "react";

import {
  clampCollapsedComposerCursor,
  collapseExpandedComposerCursor,
  expandCollapsedComposerCursor,
  isCollapsedCursorAdjacentToInlineToken,
} from "~/composer-logic";
import { type TerminalContextDraft } from "~/lib/terminalContext";
import type { ProviderMentionReference } from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import {
  COMPOSER_EDITOR_CONTENT_RESET_CLASS_NAME,
  COMPOSER_EDITOR_LINE_HEIGHT_CLASS_NAME,
  COMPOSER_EDITOR_MIN_HEIGHT_CLASS_NAME,
  COMPOSER_EDITOR_TEXT_CLASS_NAME,
} from "./chat/composerPickerStyles";
import {
  ComposerMentionNode,
  ComposerSkillNode,
  ComposerAgentMentionNode,
  ComposerTerminalContextNode,
  isComposerInlineTokenNode,
  type ComposerInlineTokenNode,
} from "./composer-nodes";
import {
  terminalContextSignature,
  mentionReferencesSignature,
  clampExpandedCursor,
  getAbsoluteOffsetForPoint,
  $getComposerRootLength,
  $setSelectionAtComposerOffset,
  $readSelectionOffsetFromEditorState,
  $readExpandedSelectionOffsetFromEditorState,
  $setComposerEditorPrompt,
  collectTerminalContextIds,
} from "./ComposerPromptEditor.helpers";

const COMPOSER_EDITOR_HMR_KEY = `composer-editor-${Math.random().toString(36).slice(2)}`;

const ComposerTerminalContextActionsContext = createContext<{
  onRemoveTerminalContext: (contextId: string) => void;
}>({
  onRemoveTerminalContext: () => {},
});

export interface ComposerPromptEditorHandle {
  blur: () => void;
  focus: () => void;
  focusAt: (cursor: number) => void;
  focusAtEnd: () => void;
  isFocused: () => boolean;
  readSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  };
}

interface ComposerPromptEditorProps {
  value: string;
  cursor: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  mentionReferences?: ReadonlyArray<ProviderMentionReference>;
  disabled: boolean;
  placeholder: string;
  ariaLabel?: string;
  className?: string;
  onRemoveTerminalContext: (contextId: string) => void;
  onChange: (
    nextValue: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
    terminalContextIds: string[],
  ) => void;
  onCommandKeyDown?: (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Slash",
    event: KeyboardEvent,
  ) => boolean;
  onPaste: ClipboardEventHandler<HTMLElement>;
}

interface ComposerPromptEditorInnerProps extends ComposerPromptEditorProps {
  editorRef: Ref<ComposerPromptEditorHandle>;
}

function ComposerCommandKeyPlugin(props: {
  onCommandKeyDown?: (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Slash",
    event: KeyboardEvent,
  ) => boolean;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const handleCommand = (
      key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Slash",
      event: KeyboardEvent | null,
    ): boolean => {
      if (!props.onCommandKeyDown || !event) {
        return false;
      }
      const handled = props.onCommandKeyDown(key, event);
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
      return handled;
    };

    const unregisterArrowDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => handleCommand("ArrowDown", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterArrowUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => handleCommand("ArrowUp", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => handleCommand("Enter", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => handleCommand("Tab", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterSlash = editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event) =>
        event instanceof KeyboardEvent && event.key === "/" ? handleCommand("Slash", event) : false,
      COMMAND_PRIORITY_HIGH,
    );

    return () => {
      unregisterArrowDown();
      unregisterArrowUp();
      unregisterEnter();
      unregisterTab();
      unregisterSlash();
    };
  }, [editor, props]);

  return null;
}

function ComposerInlineTokenArrowPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const unregisterLeft = editor.registerCommand(
      KEY_ARROW_LEFT_COMMAND,
      (event) => {
        let nextOffset: number | null = null;
        editor.getEditorState().read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
          const currentOffset = $readSelectionOffsetFromEditorState(0);
          if (currentOffset <= 0) return;
          const promptValue = $getRoot().getTextContent();
          if (!isCollapsedCursorAdjacentToInlineToken(promptValue, currentOffset, "left")) {
            return;
          }
          nextOffset = currentOffset - 1;
        });
        if (nextOffset === null) return false;
        const selectionOffset = nextOffset;
        event?.preventDefault();
        event?.stopPropagation();
        editor.update(() => {
          $setSelectionAtComposerOffset(selectionOffset);
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterRight = editor.registerCommand(
      KEY_ARROW_RIGHT_COMMAND,
      (event) => {
        let nextOffset: number | null = null;
        editor.getEditorState().read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
          const currentOffset = $readSelectionOffsetFromEditorState(0);
          const composerLength = $getComposerRootLength();
          if (currentOffset >= composerLength) return;
          const promptValue = $getRoot().getTextContent();
          if (!isCollapsedCursorAdjacentToInlineToken(promptValue, currentOffset, "right")) {
            return;
          }
          nextOffset = currentOffset + 1;
        });
        if (nextOffset === null) return false;
        const selectionOffset = nextOffset;
        event?.preventDefault();
        event?.stopPropagation();
        editor.update(() => {
          $setSelectionAtComposerOffset(selectionOffset);
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
    return () => {
      unregisterLeft();
      unregisterRight();
    };
  }, [editor]);

  return null;
}

function ComposerInlineTokenSelectionNormalizePlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      let afterOffset: number | null = null;
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
        const anchorNode = selection.anchor.getNode();
        if (!isComposerInlineTokenNode(anchorNode)) return;
        if (selection.anchor.offset === 0) return;
        const beforeOffset = getAbsoluteOffsetForPoint(anchorNode, 0);
        afterOffset = beforeOffset + 1;
      });
      if (afterOffset !== null) {
        queueMicrotask(() => {
          editor.update(() => {
            $setSelectionAtComposerOffset(afterOffset!);
          });
        });
      }
    });
  }, [editor]);

  return null;
}

function ComposerInlineTokenBackspacePlugin() {
  const [editor] = useLexicalComposerContext();
  const { onRemoveTerminalContext } = useContext(ComposerTerminalContextActionsContext);

  useEffect(() => {
    return editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return false;
        }

        const anchorNode = selection.anchor.getNode();
        const selectionOffset = $readSelectionOffsetFromEditorState(0);
        const removeInlineTokenNode = (candidate: unknown): boolean => {
          if (!isComposerInlineTokenNode(candidate)) {
            return false;
          }
          const tokenStart = getAbsoluteOffsetForPoint(candidate, 0);
          candidate.remove();
          if (candidate instanceof ComposerTerminalContextNode) {
            onRemoveTerminalContext(candidate.__context.id);
            $setSelectionAtComposerOffset(selectionOffset);
          } else {
            $setSelectionAtComposerOffset(tokenStart);
          }
          event?.preventDefault();
          return true;
        };
        if (removeInlineTokenNode(anchorNode)) {
          return true;
        }

        if ($isTextNode(anchorNode)) {
          if (selection.anchor.offset > 0) {
            return false;
          }
          if (removeInlineTokenNode(anchorNode.getPreviousSibling())) {
            return true;
          }
          const parent = anchorNode.getParent();
          if ($isElementNode(parent)) {
            const index = anchorNode.getIndexWithinParent();
            if (index > 0 && removeInlineTokenNode(parent.getChildAtIndex(index - 1))) {
              return true;
            }
          }
          return false;
        }

        if ($isElementNode(anchorNode)) {
          const childIndex = selection.anchor.offset - 1;
          if (childIndex >= 0 && removeInlineTokenNode(anchorNode.getChildAtIndex(childIndex))) {
            return true;
          }
        }

        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onRemoveTerminalContext]);

  return null;
}

function ComposerPromptEditorInner({
  value,
  cursor,
  terminalContexts,
  mentionReferences = [],
  disabled,
  placeholder,
  ariaLabel,
  className,
  onRemoveTerminalContext,
  onChange,
  onCommandKeyDown,
  onPaste,
  editorRef,
}: ComposerPromptEditorInnerProps) {
  const [editor] = useLexicalComposerContext();
  const onChangeRef = useRef(onChange);
  const initialCursor = clampCollapsedComposerCursor(value, cursor);
  const terminalContextsSignature = terminalContextSignature(terminalContexts);
  const terminalContextsSignatureRef = useRef(terminalContextsSignature);
  const mentionsSignature = mentionReferencesSignature(mentionReferences);
  const mentionsSignatureRef = useRef(mentionsSignature);
  const snapshotRef = useRef({
    value,
    cursor: initialCursor,
    expandedCursor: expandCollapsedComposerCursor(value, initialCursor),
    terminalContextIds: terminalContexts.map((context) => context.id),
  });
  const isApplyingControlledUpdateRef = useRef(false);
  const terminalContextActions = useMemo(
    () => ({ onRemoveTerminalContext }),
    [onRemoveTerminalContext],
  );

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    editor.setEditable(!disabled);
  }, [disabled, editor]);

  useLayoutEffect(() => {
    const normalizedCursor = clampCollapsedComposerCursor(value, cursor);
    const previousSnapshot = snapshotRef.current;
    const contextsChanged = terminalContextsSignatureRef.current !== terminalContextsSignature;
    const mentionsChanged = mentionsSignatureRef.current !== mentionsSignature;
    if (
      previousSnapshot.value === value &&
      previousSnapshot.cursor === normalizedCursor &&
      !contextsChanged &&
      !mentionsChanged
    ) {
      return;
    }

    snapshotRef.current = {
      value,
      cursor: normalizedCursor,
      expandedCursor: expandCollapsedComposerCursor(value, normalizedCursor),
      terminalContextIds: terminalContexts.map((context) => context.id),
    };
    terminalContextsSignatureRef.current = terminalContextsSignature;
    mentionsSignatureRef.current = mentionsSignature;

    const rootElement = editor.getRootElement();
    const isFocused = Boolean(rootElement && document.activeElement === rootElement);
    if (previousSnapshot.value === value && !contextsChanged && !mentionsChanged && !isFocused) {
      return;
    }

    isApplyingControlledUpdateRef.current = true;
    editor.update(() => {
      const shouldRewriteEditorState =
        previousSnapshot.value !== value || contextsChanged || mentionsChanged;
      if (shouldRewriteEditorState) {
        $setComposerEditorPrompt(value, terminalContexts, mentionReferences);
      }
      if (shouldRewriteEditorState || isFocused) {
        $setSelectionAtComposerOffset(normalizedCursor);
      }
    });
    queueMicrotask(() => {
      isApplyingControlledUpdateRef.current = false;
    });
  }, [
    cursor,
    editor,
    mentionReferences,
    mentionsSignature,
    terminalContexts,
    terminalContextsSignature,
    value,
  ]);

  const focusAt = useCallback(
    (nextCursor: number) => {
      const rootElement = editor.getRootElement();
      if (!rootElement) return;
      const boundedCursor = clampCollapsedComposerCursor(snapshotRef.current.value, nextCursor);
      rootElement.focus();
      editor.update(() => {
        $setSelectionAtComposerOffset(boundedCursor);
      });
      snapshotRef.current = {
        value: snapshotRef.current.value,
        cursor: boundedCursor,
        expandedCursor: expandCollapsedComposerCursor(snapshotRef.current.value, boundedCursor),
        terminalContextIds: snapshotRef.current.terminalContextIds,
      };
      onChangeRef.current(
        snapshotRef.current.value,
        boundedCursor,
        snapshotRef.current.expandedCursor,
        false,
        snapshotRef.current.terminalContextIds,
      );
    },
    [editor],
  );

  const blurEditor = useCallback(() => {
    editor.getRootElement()?.blur();
  }, [editor]);

  // Keep global shortcuts decoupled from Lexical's root element details.
  const isEditorFocused = useCallback(() => {
    const rootElement = editor.getRootElement();
    return Boolean(
      rootElement && typeof document !== "undefined" && document.activeElement === rootElement,
    );
  }, [editor]);

  const readSnapshot = useCallback((): {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  } => {
    let snapshot = snapshotRef.current;
    editor.getEditorState().read(() => {
      const nextValue = $getRoot().getTextContent();
      const fallbackCursor = clampCollapsedComposerCursor(nextValue, snapshotRef.current.cursor);
      const nextCursor = clampCollapsedComposerCursor(
        nextValue,
        $readSelectionOffsetFromEditorState(fallbackCursor),
      );
      const fallbackExpandedCursor = clampExpandedCursor(
        nextValue,
        snapshotRef.current.expandedCursor,
      );
      const nextExpandedCursor = clampExpandedCursor(
        nextValue,
        $readExpandedSelectionOffsetFromEditorState(fallbackExpandedCursor),
      );
      const terminalContextIds = collectTerminalContextIds($getRoot());
      snapshot = {
        value: nextValue,
        cursor: nextCursor,
        expandedCursor: nextExpandedCursor,
        terminalContextIds,
      };
    });
    snapshotRef.current = snapshot;
    return snapshot;
  }, [editor]);

  useImperativeHandle(
    editorRef,
    () => ({
      blur: blurEditor,
      focus: () => {
        focusAt(snapshotRef.current.cursor);
      },
      focusAt,
      focusAtEnd: () => {
        focusAt(
          collapseExpandedComposerCursor(
            snapshotRef.current.value,
            snapshotRef.current.value.length,
          ),
        );
      },
      isFocused: isEditorFocused,
      readSnapshot,
    }),
    [blurEditor, focusAt, isEditorFocused, readSnapshot],
  );

  const handleEditorChange = useCallback((editorState: EditorState) => {
    editorState.read(() => {
      const nextValue = $getRoot().getTextContent();
      const fallbackCursor = clampCollapsedComposerCursor(nextValue, snapshotRef.current.cursor);
      const nextCursor = clampCollapsedComposerCursor(
        nextValue,
        $readSelectionOffsetFromEditorState(fallbackCursor),
      );
      const fallbackExpandedCursor = clampExpandedCursor(
        nextValue,
        snapshotRef.current.expandedCursor,
      );
      const nextExpandedCursor = clampExpandedCursor(
        nextValue,
        $readExpandedSelectionOffsetFromEditorState(fallbackExpandedCursor),
      );
      const terminalContextIds = collectTerminalContextIds($getRoot());
      const previousSnapshot = snapshotRef.current;
      if (
        previousSnapshot.value === nextValue &&
        previousSnapshot.cursor === nextCursor &&
        previousSnapshot.expandedCursor === nextExpandedCursor &&
        previousSnapshot.terminalContextIds.length === terminalContextIds.length &&
        previousSnapshot.terminalContextIds.every((id, index) => id === terminalContextIds[index])
      ) {
        return;
      }
      if (isApplyingControlledUpdateRef.current) {
        return;
      }
      snapshotRef.current = {
        value: nextValue,
        cursor: nextCursor,
        expandedCursor: nextExpandedCursor,
        terminalContextIds,
      };
      const cursorAdjacentToMention =
        isCollapsedCursorAdjacentToInlineToken(nextValue, nextCursor, "left") ||
        isCollapsedCursorAdjacentToInlineToken(nextValue, nextCursor, "right");
      onChangeRef.current(
        nextValue,
        nextCursor,
        nextExpandedCursor,
        cursorAdjacentToMention,
        terminalContextIds,
      );
    });
  }, []);

  return (
    <ComposerTerminalContextActionsContext.Provider value={terminalContextActions}>
      <div className="relative">
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              className={cn(
                "font-system-ui block max-h-[200px] w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent text-foreground focus:outline-none",
                COMPOSER_EDITOR_TEXT_CLASS_NAME,
                COMPOSER_EDITOR_LINE_HEIGHT_CLASS_NAME,
                COMPOSER_EDITOR_MIN_HEIGHT_CLASS_NAME,
                COMPOSER_EDITOR_CONTENT_RESET_CLASS_NAME,
                className,
              )}
              data-testid="composer-editor"
              aria-label={ariaLabel}
              aria-placeholder={placeholder}
              placeholder={<span />}
              onPaste={onPaste}
            />
          }
          placeholder={
            terminalContexts.length > 0 ? null : (
              <div
                className={cn(
                  "font-system-ui pointer-events-none absolute inset-0 text-muted-foreground/70",
                  COMPOSER_EDITOR_TEXT_CLASS_NAME,
                  COMPOSER_EDITOR_LINE_HEIGHT_CLASS_NAME,
                )}
              >
                {placeholder}
              </div>
            )
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <OnChangePlugin onChange={handleEditorChange} />
        <ComposerCommandKeyPlugin {...(onCommandKeyDown ? { onCommandKeyDown } : {})} />
        <ComposerInlineTokenArrowPlugin />
        <ComposerInlineTokenSelectionNormalizePlugin />
        <ComposerInlineTokenBackspacePlugin />
        <HistoryPlugin />
      </div>
    </ComposerTerminalContextActionsContext.Provider>
  );
}

export const ComposerPromptEditor = forwardRef<
  ComposerPromptEditorHandle,
  ComposerPromptEditorProps
>(function ComposerPromptEditor(
  {
    value,
    cursor,
    terminalContexts,
    mentionReferences,
    disabled,
    placeholder,
    ariaLabel,
    className,
    onRemoveTerminalContext,
    onChange,
    onCommandKeyDown,
    onPaste,
  },
  ref,
) {
  const initialValueRef = useRef(value);
  const initialTerminalContextsRef = useRef(terminalContexts);
  // Normalize once at the wrapper boundary so the inner editor can treat mention refs as concrete.
  const normalizedMentionReferences = mentionReferences ?? [];
  const initialMentionReferencesRef = useRef(normalizedMentionReferences);
  const initialConfig = useMemo<InitialConfigType>(
    () => ({
      namespace: "t3tools-composer-editor",
      editable: true,
      nodes: [
        ComposerMentionNode,
        ComposerSkillNode,
        ComposerTerminalContextNode,
        ComposerAgentMentionNode,
      ],
      editorState: () => {
        $setComposerEditorPrompt(
          initialValueRef.current,
          initialTerminalContextsRef.current,
          initialMentionReferencesRef.current,
        );
      },
      onError: (error) => {
        throw error;
      },
    }),
    [],
  );

  return (
    <LexicalComposer key={COMPOSER_EDITOR_HMR_KEY} initialConfig={initialConfig}>
      <ComposerPromptEditorInner
        value={value}
        cursor={cursor}
        terminalContexts={terminalContexts}
        mentionReferences={normalizedMentionReferences}
        disabled={disabled}
        placeholder={placeholder}
        {...(ariaLabel ? { ariaLabel } : {})}
        onRemoveTerminalContext={onRemoveTerminalContext}
        onChange={onChange}
        onPaste={onPaste}
        editorRef={ref}
        {...(onCommandKeyDown ? { onCommandKeyDown } : {})}
        {...(className ? { className } : {})}
      />
    </LexicalComposer>
  );
});

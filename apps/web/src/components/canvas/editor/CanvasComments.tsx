import type { CanvasCommentChangeInput, CanvasCommentThread } from "@synara/contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "~/i18n";
import {
  CircleCheckIcon,
  ComposerSendArrowIcon,
  MoreHorizontalIcon,
  RotateCcwIcon,
  XIcon,
} from "~/lib/icons";
import { cn, isMacNavigatorPlatform } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { ComposerPickerMenuPopup } from "../../chat/ComposerPickerMenuPopup";
import { APP_TRANSLUCENT_POPUP_SURFACE_CLASS_NAME } from "../../chat/composerPickerStyles";
import { Button } from "../../ui/button";
import { IconButton } from "../../ui/icon-button";
import { Menu, MenuItem, MenuSeparator, MenuShortcut, MenuTrigger } from "../../ui/menu";
import { Textarea } from "../../ui/textarea";
import { toastManager } from "../../ui/toast";
import { useCanvasEditorStore } from "../canvasStores";
import { runCanvasWrite } from "../canvasWorkCache";
import { canvasId } from "./canvasClipboard";
import { layerLabel } from "./canvasSelection";
import { useCanvasEditor, type CanvasEditorApi } from "./CanvasEditorContext";
import { animateCanvasCamera } from "./useCanvasCamera";
import {
  COMMENT_PIN_SIZE as PIN,
  CommentAvatar,
  CommentMeta,
  CommentPin,
  useCommentUserInitial,
} from "./CommentPin";

type Rect = { x: number; y: number; width: number; height: number };
type Pending = { frameId: string; layerId: string | null; x: number; y: number };
type CommentOperation = CanvasCommentChangeInput["operation"];

/** Gap between a pin and the card that opens beside it. */
const CARD_GAP = 8;
/** How far inside its layer's edges a pin stays (world pixels). */
const PIN_INSET = 2;
/** Width of an open thread card (`w-68`). */
const THREAD_CARD_WIDTH = 272;

/** A world point on screen, through the camera variables the viewport keeps up to date. */
const pinStyle = (point: { x: number; y: number }): CSSProperties => ({
  left: `calc(var(--canvas-x, 0px) + ${point.x}px * var(--canvas-zoom, 1))`,
  top: `calc(var(--canvas-y, 0px) + ${point.y}px * var(--canvas-zoom, 1))`,
});

/**
 * Comment pins: anchored to a layer, so a pin follows the layer it points at.
 * Boxes are in world pixels, so pins follow a pan or zoom without a render.
 */
export function CanvasCommentLayer({
  frameRect,
  layerRect,
  pending,
  onPendingDone,
}: {
  frameRect: (frameId: string) => Rect | null;
  layerRect: (frameId: string, layerId: string) => Rect | null;
  pending: Pending | null;
  onPendingDone: () => void;
}) {
  const editor = useCanvasEditor();
  const { page, activeCommentId, openComment } = editor;
  const userInitial = useCommentUserInitial();
  // ⇧C hides every comment on the canvas.
  const hidden = useCanvasEditorStore((state) => state.commentsHidden);
  // A pin stays inside its layer (a little in from the edges) when the layer shrinks.
  const pinPoint = (anchor: Pending | CanvasCommentThread) => {
    const base =
      (anchor.layerId ? layerRect(anchor.frameId, anchor.layerId) : null) ??
      frameRect(anchor.frameId);
    if (!base) return null;
    const clamp = (value: number, size: number) =>
      size <= PIN_INSET * 2 ? size / 2 : Math.min(size - PIN_INSET, Math.max(PIN_INSET, value));
    return { x: base.x + clamp(anchor.x, base.width), y: base.y + clamp(anchor.y, base.height) };
  };
  const threads = page.comments.filter(
    (thread) => thread.status === "open" || thread.id === activeCommentId,
  );
  const pendingPoint = pending ? pinPoint(pending) : null;
  if (hidden) return null;
  return (
    <div className="pointer-events-none absolute inset-0" data-canvas-comments="">
      {threads.map((thread) => {
        const point = pinPoint(thread);
        if (!point) return null;
        const active = thread.id === activeCommentId;
        const first = thread.messages[0]!;
        return (
          <div key={thread.id} className={cn("absolute", active && "z-10")} style={pinStyle(point)}>
            <CommentPin
              thread={thread}
              author={first.author}
              userInitial={userInitial}
              active={active}
              unread={isCommentUnread(thread)}
              label={first.text}
              onClick={() => {
                if (pending) onPendingDone();
                openComment(active ? null : { threadId: thread.id });
              }}
            />
            {active && (
              <CommentThreadCard
                thread={thread}
                userInitial={userInitial}
                onClose={() => openComment(null)}
              />
            )}
          </div>
        );
      })}
      {pending && pendingPoint && (
        <div className="absolute z-10" style={pinStyle(pendingPoint)}>
          <CommentPin author={{ kind: "user" }} userInitial={userInitial} />
          <NewCommentComposer pending={pending} onDone={onPendingDone} />
        </div>
      )}
    </div>
  );
}

/** Comment changes shared by the canvas cards and the comments list. */
export function useCanvasCommentActions() {
  const { t } = useTranslation();
  const editor = useCanvasEditor();
  const client = useQueryClient();
  const fail = (cause: unknown) =>
    toastManager.add({
      type: "error",
      title: t("workspace:canvasOperationFailed"),
      description: cause instanceof Error ? cause.message : undefined,
    });
  /** Saves one change and publishes the new work; throws on failure. */
  const change = async (operation: CommentOperation) => {
    await runCanvasWrite(client, editor.work.id, () =>
      ensureNativeApi().canvas.changeComments({
        workId: editor.work.id,
        pageId: editor.page.id,
        operation,
      }),
    );
  };
  /** Saves one change, reporting a failure in a toast; resolves whether it was saved. */
  const run = async (operation: CommentOperation) => {
    try {
      await change(operation);
      return true;
    } catch (cause) {
      fail(cause);
      return false;
    }
  };
  const setStatus = (thread: CanvasCommentThread, status: "open" | "resolved") =>
    run({ type: "set_status", threadId: thread.id, status });
  return {
    change,
    run,
    fail,
    editMessage: (thread: CanvasCommentThread, messageId: string, text: string) =>
      run({ type: "edit_message", threadId: thread.id, messageId, text }),
    /** Deletes one reply after a confirmation. */
    deleteMessage: async (thread: CanvasCommentThread, messageId: string) => {
      if (
        !(await ensureNativeApi().dialogs.confirm(t("workspace:canvasCommentDeleteMessageConfirm")))
      )
        return false;
      return run({ type: "delete_message", threadId: thread.id, messageId });
    },
    markRead: (thread: CanvasCommentThread) => run({ type: "mark_read", threadId: thread.id }),
    reopen: (thread: CanvasCommentThread) => setStatus(thread, "open"),
    /** Resolves a thread and offers an Undo for 8 seconds. */
    resolve: async (thread: CanvasCommentThread) => {
      if (!(await setStatus(thread, "resolved"))) return false;
      toastManager.add({
        title: t("workspace:canvasCommentResolved"),
        timeout: 8000,
        actionProps: {
          children: t("workspace:canvasUndo"),
          onClick: () => void setStatus(thread, "open"),
        },
      });
      return true;
    },
    /** Deletes a thread after the same native confirmation "Delete page" asks for. */
    remove: async (thread: CanvasCommentThread) => {
      if (!(await ensureNativeApi().dialogs.confirm(t("workspace:canvasCommentDeleteConfirm"))))
        return false;
      return run({ type: "delete", threadId: thread.id });
    },
  };
}

/** What a thread is pinned to: its layer's name, else its frame's title. */
export function canvasCommentTarget(editor: CanvasEditorApi, thread: CanvasCommentThread) {
  const frameTitle = editor.frame(thread.frameId)?.title ?? "frame";
  const index = editor.layers(thread.frameId);
  return thread.layerId && index?.nodes.has(thread.layerId)
    ? layerLabel(index, thread.layerId)
    : frameTitle;
}

/** Unread state is per thread: a reply by someone else since the user last read it. */
export const isCommentUnread = (thread: CanvasCommentThread) =>
  thread.messages.some(
    (message) => message.author.kind === "agent" && message.createdAt > (thread.readAt ?? ""),
  );

/** Asks before unsent comment text is thrown away; resolves whether to go ahead. */
async function confirmDiscard(text: string, question: string) {
  if (!text.trim()) return true;
  return ensureNativeApi().dialogs.confirm(question);
}

/** Seeds the canvas chat composer with a comment, its target and the IDs the agent needs. */
function askAgent(
  editor: CanvasEditorApi,
  threadId: string,
  anchor: Pick<Pending, "frameId" | "layerId">,
  text: string,
) {
  const frame = editor.frame(anchor.frameId);
  const index = editor.layers(anchor.frameId);
  const target =
    anchor.layerId && index
      ? `"${layerLabel(index, anchor.layerId)}" in "${frame?.title ?? "frame"}"`
      : `"${frame?.title ?? "frame"}"`;
  editor.onAskAgent?.(
    `Canvas comment on ${target}: ${text}\n\n(workId=${editor.work.id}, pageId=${editor.page.id}, frameId=${anchor.frameId}${anchor.layerId ? `, layerId=${anchor.layerId}` : ""}, commentThreadId=${threadId}. Make the change, then reply in the comment thread and resolve it.)`,
  );
}

/**
 * Opens a thread and pans the canvas when its pin is out of view, leaving room for the card
 * that opens to the right of the pin.
 */
export function revealCanvasComment(editor: CanvasEditorApi, thread: CanvasCommentThread) {
  editor.openComment({ threadId: thread.id });
  const frame = editor.frame(thread.frameId);
  const root = editor.elementFor({ kind: "frame", frameId: thread.frameId });
  if (!frame || !root) return;
  const owner = root.getRootNode();
  const host = owner instanceof ShadowRoot ? owner.host : root;
  const element = host.closest<HTMLElement>("[data-canvas-viewport]");
  if (!element) return;
  const { x, y, zoom } = editor.camera.get();
  const layer = thread.layerId
    ? editor.elementFor({ kind: "layer", frameId: thread.frameId, layerId: thread.layerId })
    : null;
  let anchorX = frame.x + thread.x;
  let anchorY = frame.y + thread.y;
  if (layer) {
    const box = layer.getBoundingClientRect();
    const origin = root.getBoundingClientRect();
    anchorX += (box.left - origin.left) / zoom;
    anchorY += (box.top - origin.top) / zoom;
  }
  const width = element.clientWidth;
  const height = element.clientHeight;
  const screenX = x + anchorX * zoom;
  const screenY = y + anchorY * zoom;
  const cardRoom = THREAD_CARD_WIDTH + PIN + CARD_GAP;
  if (
    screenX >= PIN &&
    screenX <= width - cardRoom &&
    screenY >= PIN * 2 &&
    screenY <= height - PIN
  )
    return;
  // The camera centres on the pin; the move is animated like the other camera commands.
  animateCanvasCamera(
    editor.camera,
    {
      zoom,
      x: Math.max(PIN, (width - cardRoom) / 2) - anchorX * zoom,
      y: height / 2 - anchorY * zoom,
    },
    editor.setViewport,
  );
}

/**
 * Closes a comment card on Escape, and on a press on the canvas outside it and its pin.
 * Presses in panels, menus, dialogs and toasts leave it open.
 */
function useCommentDismiss(
  ref: RefObject<HTMLElement | null>,
  { onEscape, onOutsidePress }: { onEscape: () => void; onOutsidePress: () => void },
) {
  const escape = useEffectEvent(onEscape);
  const outside = useEffectEvent(onOutsidePress);
  useEffect(() => {
    const within = (target: Element) =>
      ref.current?.contains(target) === true ||
      target.closest("[data-canvas-comment-pin]") !== null;
    const press = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || within(target)) return;
      if (target.closest("[data-canvas-viewport]")) outside();
    };
    const key = (event: globalThis.KeyboardEvent) => {
      const target = event.target;
      if (event.key !== "Escape" || event.isComposing || !(target instanceof Element)) return;
      // An open "…" menu closes first.
      if (target.closest('[role="menu"]')) return;
      if (within(target) || target.closest("[data-canvas-viewport]")) escape();
    };
    document.addEventListener("pointerdown", press, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", press, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [ref]);
}

/**
 * The floating surface of a comment card, positioned beside its pin. Pointer, key and wheel
 * input stays with the card instead of reaching the canvas underneath.
 */
function CommentSurface({
  label,
  className,
  style,
  onEscape,
  onOutsidePress,
  children,
}: {
  label: string;
  className?: string;
  style: CSSProperties;
  onEscape: () => void;
  onOutsidePress: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useCommentDismiss(ref, { onEscape, onOutsidePress });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // The canvas zooms on wheel; here it scrolls the card (and pinch never zooms the page).
    const wheel = (event: WheelEvent) => {
      event.stopPropagation();
      if (event.ctrlKey || event.metaKey) event.preventDefault();
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      data-canvas-ui=""
      className={cn(
        // The app's popover, filled solid: the card floats over the user's design, whose
        // colors would otherwise show through.
        APP_TRANSLUCENT_POPUP_SURFACE_CLASS_NAME,
        "pointer-events-auto absolute flex text-ui-sm [--app-overlay-surface:var(--popover)]",
        className,
      )}
      style={style}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // Canvas shortcuts must not fire from the card; Escape still reaches open menus.
        if (event.key !== "Escape") event.stopPropagation();
      }}
    >
      {children}
    </div>
  );
}

/** A one-line field that grows with its text, without a box of its own. */
const COMMENT_FIELD_CLASS_NAME =
  "min-w-0 flex-1 [&_textarea]:max-h-32 [&_textarea]:min-h-0 [&_textarea]:px-0 [&_textarea]:py-0.5 [&_textarea]:text-ui-sm [&_textarea]:placeholder:text-muted-foreground";

/** Enter sends, Mod+Enter sends and asks the agent, Shift+Enter breaks the line. */
function onCommentFieldKeyDown(
  event: KeyboardEvent<HTMLTextAreaElement>,
  submit: (ask: boolean) => void,
) {
  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
  event.preventDefault();
  submit(isMacNavigatorPlatform() ? event.metaKey : event.ctrlKey);
}

function SendButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <IconButton
      label={label}
      tooltip={label}
      variant="prominent"
      size="icon-xs"
      className="shrink-0"
      disabled={disabled}
      onClick={onClick}
    >
      <ComposerSendArrowIcon aria-hidden="true" className="size-4 shrink-0" />
    </IconButton>
  );
}

function AskAgentChip({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      variant="outline"
      size="xs"
      shape="capsule"
      className="shrink-0"
      disabled={disabled}
      onClick={onClick}
    >
      {t("workspace:canvasCommentAskAgent")}
    </Button>
  );
}

/** The comment bubble: one line beside the pending pin, with Ask agent and send. */
function NewCommentComposer({ pending, onDone }: { pending: Pending; onDone: () => void }) {
  const { t } = useTranslation();
  const editor = useCanvasEditor();
  const { change, fail } = useCanvasCommentActions();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (ask: boolean) => {
    const value = text.trim();
    if (!value || busy || (ask && !editor.onAskAgent)) return;
    setBusy(true);
    const threadId = canvasId("comment");
    try {
      await change({
        type: "create",
        threadId,
        messageId: canvasId("message"),
        frameId: pending.frameId,
        layerId: pending.layerId,
        x: Math.round(pending.x),
        y: Math.round(pending.y),
        text: value,
      });
      if (ask) askAgent(editor, threadId, pending, value);
      editor.openComment({ threadId });
      onDone();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };
  const empty = !text.trim();
  return (
    <CommentSurface
      label={t("workspace:canvasComment")}
      // As wide as the text, so a short comment stays one line.
      className="min-h-9 w-max max-w-104 min-w-72 items-center gap-1.5 rounded-bl-sm py-1.25 ps-3 pe-1.25"
      // Vertically centred on the pin.
      style={{ left: PIN + CARD_GAP, top: -PIN - 5 }}
      // Unsent text asks first ("Discard changes?").
      onEscape={() =>
        void confirmDiscard(text, t("workspace:canvasCommentDiscardConfirm")).then((discard) => {
          if (discard) onDone();
        })
      }
      // A click away drops an empty comment; a written one stays until Escape or a new spot.
      onOutsidePress={() => {
        if (!text.trim()) onDone();
      }}
    >
      <Textarea
        unstyled
        autoFocus
        rows={1}
        value={text}
        placeholder={t("workspace:canvasCommentPlaceholder")}
        className={COMMENT_FIELD_CLASS_NAME}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => onCommentFieldKeyDown(event, (ask) => void submit(ask))}
      />
      {editor.onAskAgent && (
        <AskAgentChip disabled={empty || busy} onClick={() => void submit(true)} />
      )}
      <SendButton
        label={t("workspace:canvasCommentPost")}
        disabled={empty || busy}
        onClick={() => void submit(false)}
      />
    </CommentSurface>
  );
}

function CommentThreadCard({
  thread,
  userInitial,
  onClose,
}: {
  thread: CanvasCommentThread;
  userInitial: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const editor = useCanvasEditor();
  const actions = useCanvasCommentActions();
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const open = thread.status === "open";
  // Opening a thread reads it.
  const unread = isCommentUnread(thread);
  useEffect(() => {
    if (unread && !editor.readOnly) void actions.markRead(thread);
    // Once per opening, and again only when something new arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.id, unread]);
  const close = () =>
    void confirmDiscard(
      editing ? editing.text : reply,
      t("workspace:canvasCommentDiscardConfirm"),
    ).then((discard) => {
      if (discard) onClose();
    });
  const canAsk = editor.onAskAgent !== null && open;
  const title = canvasCommentTarget(editor, thread);
  const ask = (extra?: string) =>
    askAgent(
      editor,
      thread.id,
      thread,
      [...thread.messages.map((message) => message.text), ...(extra ? [extra] : [])].join("\n"),
    );
  const send = async (withAgent: boolean) => {
    const text = reply.trim();
    if (busy || (withAgent ? !canAsk : !text)) return;
    setBusy(true);
    try {
      if (text) {
        const saved = await actions.run({
          type: "reply",
          threadId: thread.id,
          messageId: canvasId("message"),
          text,
        });
        if (!saved) return;
        setReply("");
      }
      if (withAgent) ask(text || undefined);
    } finally {
      setBusy(false);
    }
  };
  const mac = isMacNavigatorPlatform();
  return (
    <CommentSurface
      label={title}
      className="w-68 flex-col"
      style={{ left: PIN + CARD_GAP, top: -PIN }}
      onEscape={close}
      onOutsidePress={close}
    >
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-border ps-3 pe-1">
        <span className="min-w-0 flex-1 truncate text-ui-sm font-medium text-foreground">
          {title}
        </span>
        {open ? (
          <IconButton
            label={t("workspace:canvasCommentResolve")}
            tooltip={t("workspace:canvasCommentResolve")}
            onClick={() =>
              void actions.resolve(thread).then((resolved) => {
                if (resolved) onClose();
              })
            }
          >
            <CircleCheckIcon className="size-3.5" />
          </IconButton>
        ) : (
          <IconButton
            label={t("workspace:canvasCommentReopen")}
            tooltip={t("workspace:canvasCommentReopen")}
            onClick={() => void actions.reopen(thread)}
          >
            <RotateCcwIcon className="size-3.5" />
          </IconButton>
        )}
        <Menu>
          <MenuTrigger
            render={
              <IconButton label={t("common:more")} tooltip={t("common:more")}>
                <MoreHorizontalIcon className="size-3.5" />
              </IconButton>
            }
          >
            <MoreHorizontalIcon className="size-3.5" />
          </MenuTrigger>
          <ComposerPickerMenuPopup align="start">
            {canAsk && (
              <>
                <MenuItem onClick={() => void send(true)}>
                  {t("workspace:canvasCommentAskAgent")}
                  <MenuShortcut>{mac ? "⌘↵" : "Ctrl ↵"}</MenuShortcut>
                </MenuItem>
                <MenuSeparator />
              </>
            )}
            <MenuItem
              variant="destructive"
              onClick={() =>
                void actions.remove(thread).then((removed) => {
                  if (removed) onClose();
                })
              }
            >
              {t("workspace:canvasDelete")}
            </MenuItem>
          </ComposerPickerMenuPopup>
        </Menu>
        <IconButton
          label={t("workspace:canvasClose")}
          tooltip={t("workspace:canvasClose")}
          onClick={close}
        >
          <XIcon className="size-3.5" />
        </IconButton>
      </div>
      <ol className="flex max-h-64 flex-col gap-3 overflow-y-auto p-3">
        {thread.messages.map((message, at) => (
          <li key={message.id} className="group/message flex gap-2">
            <CommentAvatar author={message.author} userInitial={userInitial} shape="circle" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex min-w-0 items-center gap-1">
                <span className="min-w-0 flex-1">
                  <CommentMeta author={message.author} createdAt={message.createdAt} />
                </span>
                {/* Each message has Edit and Delete, for its author. */}
                {message.author.kind === "user" &&
                  !editor.readOnly &&
                  editing?.id !== message.id && (
                    <Menu>
                      <MenuTrigger
                        render={
                          <IconButton
                            label={t("workspace:canvasCommentMessageActions")}
                            tooltip={t("workspace:canvasCommentMessageActions")}
                            className="opacity-0 group-hover/message:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
                          >
                            <MoreHorizontalIcon className="size-3" />
                          </IconButton>
                        }
                      >
                        <MoreHorizontalIcon className="size-3" />
                      </MenuTrigger>
                      <ComposerPickerMenuPopup align="end">
                        <MenuItem
                          onClick={() => setEditing({ id: message.id, text: message.text })}
                        >
                          {t("workspace:canvasCommentEdit")}
                        </MenuItem>
                        <MenuItem
                          variant="destructive"
                          onClick={() =>
                            void (at === 0
                              ? actions.remove(thread).then((removed) => {
                                  if (removed) onClose();
                                })
                              : actions.deleteMessage(thread, message.id))
                          }
                        >
                          {t("workspace:canvasDelete")}
                        </MenuItem>
                      </ComposerPickerMenuPopup>
                    </Menu>
                  )}
              </div>
              {editing?.id === message.id ? (
                <div className="flex flex-col gap-1.5">
                  <Textarea
                    autoFocus
                    rows={2}
                    value={editing.text}
                    aria-label={t("workspace:canvasCommentEdit")}
                    onChange={(event) => setEditing({ id: message.id, text: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.stopPropagation();
                        setEditing(null);
                      }
                    }}
                  />
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="xs" onClick={() => setEditing(null)}>
                      {t("workspace:canvasCancel")}
                    </Button>
                    <Button
                      size="xs"
                      disabled={!editing.text.trim() || editing.text.trim() === message.text}
                      onClick={() =>
                        void actions
                          .editMessage(thread, message.id, editing.text.trim())
                          .then((saved) => {
                            if (saved) setEditing(null);
                          })
                      }
                    >
                      {t("workspace:canvasCommentSave")}
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-ui-sm break-words whitespace-pre-wrap text-foreground">
                  {message.text}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
      <div className="flex items-center gap-1.5 border-t border-border py-2 ps-3 pe-2">
        <Textarea
          unstyled
          rows={1}
          value={reply}
          placeholder={t("workspace:canvasCommentReply")}
          className={COMMENT_FIELD_CLASS_NAME}
          onChange={(event) => setReply(event.target.value)}
          onKeyDown={(event) => onCommentFieldKeyDown(event, (withAgent) => void send(withAgent))}
        />
        {canAsk && <AskAgentChip disabled={busy} onClick={() => void send(true)} />}
        <SendButton
          label={t("workspace:canvasCommentReply")}
          disabled={!reply.trim() || busy}
          onClick={() => void send(false)}
        />
      </div>
    </CommentSurface>
  );
}

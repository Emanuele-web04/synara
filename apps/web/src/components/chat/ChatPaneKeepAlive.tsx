// FILE: ChatPaneKeepAlive.tsx
// Purpose: Keep a chat pane's React subtree (and its DOM) alive while the surface that hosts
//          it changes, so going between the single chat surface and a split view does not
//          remount the chat.
// Layer: Chat surface primitive
// Exports: ChatPaneKeepAliveProvider, KeptChatPane, ChatPaneBody

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { type WorkspaceFileOpener, WorkspaceFileOpenerContext } from "~/lib/workspaceFileOpener";
import { ChatPaneDropOverlay } from "../chat-drop-overlay/ChatPaneDropOverlay";
import { SidebarInset } from "../ui/sidebar";

// A released pane waits this long for another slot to adopt it before it is unmounted. The
// single/split swap happens inside one commit; the grace only covers a swap that takes two.
const ORPHAN_GRACE_MS = 50;

interface KeptPane {
  id: number;
  slotKey: string;
  threadId: string | null;
  host: HTMLDivElement;
  content: ReactNode;
  listeners: Set<() => void>;
  orphanTimer: number | null;
  // Scroll positions taken when the pane left its slot, put back once it sits in the next
  // one. Chromium drops them when a node is moved twice before a layout (slot to parking to
  // slot within one commit), and a plain append drops them always.
  scrollOffsets: ScrollOffsets | null;
  focus: {
    element: HTMLElement;
    selection: {
      anchorNode: Node;
      anchorOffset: number;
      focusNode: Node;
      focusOffset: number;
    } | null;
    inputSelection: {
      start: number;
      end: number;
      direction: "forward" | "backward" | "none";
    } | null;
  } | null;
}

interface ChatPaneKeepAlive {
  claim: (slotKey: string, threadId: string | null) => KeptPane;
  place: (pane: KeptPane, placeholder: HTMLElement) => void;
  release: (pane: KeptPane) => void;
}

const ChatPaneKeepAliveContext = createContext<ChatPaneKeepAlive | null>(null);

type ScrollOffsets = [element: Element, scrollTop: number, scrollLeft: number][];

function captureScrollOffsets(root: HTMLElement): ScrollOffsets {
  const offsets: ScrollOffsets = [];
  for (const element of root.querySelectorAll("*")) {
    if (element.scrollTop !== 0 || element.scrollLeft !== 0) {
      offsets.push([element, element.scrollTop, element.scrollLeft]);
    }
  }
  return offsets;
}

// Moves `node` under `parent` without resetting it: `moveBefore` keeps focus, iframes and
// running animations across the move. Scroll offsets are not safe either way (see
// `scrollOffsets` on KeptPane), so the callers carry them.
function moveInto(parent: HTMLElement, node: HTMLElement) {
  if (node.parentNode === parent) {
    return;
  }
  const moveBefore = (parent as { moveBefore?: (node: Node, child: Node | null) => void })
    .moveBefore;
  if (moveBefore && node.isConnected && parent.isConnected) {
    try {
      moveBefore.call(parent, node, null);
      return;
    } catch {
      // Fall through to a plain append.
    }
  }
  parent.append(node);
}

function KeptPaneContent({ pane }: { pane: KeptPane }) {
  return useSyncExternalStore(
    (listener) => {
      pane.listeners.add(listener);
      return () => pane.listeners.delete(listener);
    },
    () => pane.content,
  );
}

/**
 * Owns the chat panes rendered through {@link KeptChatPane} below it. Each pane is rendered
 * into its own host element through a portal from here, so its React identity belongs to
 * this provider rather than to the surface showing it. Mount it above the point where the
 * single chat surface and the split surface swap.
 */
export function ChatPaneKeepAliveProvider({ children }: { children: ReactNode }) {
  const panesRef = useRef<KeptPane[]>([]);
  const nextIdRef = useRef(0);
  const parkingRef = useRef<HTMLDivElement>(null);
  const [panes, setPanes] = useState<readonly KeptPane[]>([]);

  const keepAlive = useMemo<ChatPaneKeepAlive>(() => {
    const publish = () => setPanes([...panesRef.current]);
    const cancelDisposal = (pane: KeptPane) => {
      if (pane.orphanTimer !== null) {
        window.clearTimeout(pane.orphanTimer);
        pane.orphanTimer = null;
      }
    };
    return {
      claim: (slotKey, threadId) => {
        const existing =
          panesRef.current.find((pane) => pane.slotKey === slotKey) ??
          // A pane another slot just let go of, showing the same thread: the surface around
          // this chat changed, the chat did not.
          (threadId === null
            ? undefined
            : panesRef.current.find(
                (pane) => pane.orphanTimer !== null && pane.threadId === threadId,
              ));
        if (existing) {
          cancelDisposal(existing);
          existing.slotKey = slotKey;
          return existing;
        }
        const host = document.createElement("div");
        host.className = "contents";
        const pane: KeptPane = {
          id: (nextIdRef.current += 1),
          slotKey,
          threadId,
          host,
          content: null,
          listeners: new Set(),
          orphanTimer: null,
          scrollOffsets: null,
          focus: null,
        };
        panesRef.current.push(pane);
        publish();
        return pane;
      },
      place: (pane, placeholder) => {
        moveInto(placeholder, pane.host);
        // After the commit, so a slot that is released again right away costs no layout.
        queueMicrotask(() => {
          if (pane.host.parentNode !== placeholder) return;
          const focus = pane.focus;
          pane.focus = null;
          // Parking is inert, and append also blurs on browsers without moveBefore.
          // Restore only our former focus, without overriding a new focus elsewhere.
          if (
            focus &&
            pane.host.contains(focus.element) &&
            document.activeElement === document.body
          ) {
            focus.element.focus({ preventScroll: true });
            if (
              focus.inputSelection &&
              (focus.element instanceof HTMLInputElement ||
                focus.element instanceof HTMLTextAreaElement)
            ) {
              const { start, end, direction } = focus.inputSelection;
              focus.element.setSelectionRange(start, end, direction);
            }
            if (
              !focus.inputSelection &&
              focus.selection &&
              pane.host.contains(focus.selection.anchorNode) &&
              pane.host.contains(focus.selection.focusNode)
            ) {
              const { anchorNode, anchorOffset, focusNode, focusOffset } = focus.selection;
              document
                .getSelection()
                ?.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
            }
          }
          for (const [element, scrollTop, scrollLeft] of pane.scrollOffsets ?? []) {
            element.scrollTop = scrollTop;
            element.scrollLeft = scrollLeft;
          }
          pane.scrollOffsets = null;
        });
      },
      release: (pane) => {
        // Runs before React removes the surface's DOM, so the host is still attached and
        // can be moved out intact for the next slot to pick up.
        pane.scrollOffsets ??= captureScrollOffsets(pane.host);
        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLElement && pane.host.contains(activeElement)) {
          const currentSelection = document.getSelection();
          // Range objects are live and append retargets them to the old parent.
          // Carry the nodes and offsets instead, including backward selections.
          const selection =
            currentSelection?.anchorNode &&
            currentSelection.focusNode &&
            pane.host.contains(currentSelection.anchorNode) &&
            pane.host.contains(currentSelection.focusNode)
              ? {
                  anchorNode: currentSelection.anchorNode,
                  anchorOffset: currentSelection.anchorOffset,
                  focusNode: currentSelection.focusNode,
                  focusOffset: currentSelection.focusOffset,
                }
              : null;
          const inputSelection =
            (activeElement instanceof HTMLInputElement ||
              activeElement instanceof HTMLTextAreaElement) &&
            activeElement.selectionStart !== null &&
            activeElement.selectionEnd !== null
              ? {
                  start: activeElement.selectionStart,
                  end: activeElement.selectionEnd,
                  direction: activeElement.selectionDirection ?? "none",
                }
              : null;
          pane.focus = { element: activeElement, selection, inputSelection };
        }
        if (parkingRef.current) {
          moveInto(parkingRef.current, pane.host);
        }
        cancelDisposal(pane);
        pane.orphanTimer = window.setTimeout(() => {
          pane.orphanTimer = null;
          panesRef.current = panesRef.current.filter((entry) => entry !== pane);
          publish();
          pane.host.remove();
        }, ORPHAN_GRACE_MS);
      },
    };
  }, []);

  useEffect(
    () => () => {
      for (const pane of panesRef.current) {
        if (pane.orphanTimer !== null) {
          window.clearTimeout(pane.orphanTimer);
        }
      }
    },
    [],
  );

  return (
    <ChatPaneKeepAliveContext.Provider value={keepAlive}>
      {children}
      {/* Where a released pane waits, laid out at window size so nothing in it reflows. */}
      <div
        ref={parkingRef}
        aria-hidden
        inert
        className="pointer-events-none invisible fixed inset-0 flex"
      />
      {panes.map((pane) => createPortal(<KeptPaneContent pane={pane} />, pane.host, pane.id))}
    </ChatPaneKeepAliveContext.Provider>
  );
}

/**
 * A slot showing a kept chat pane. `children` render inside the pane's host, so they keep
 * their state when a slot with another key takes the pane over; that happens when the new
 * slot mounts in the commit the old one unmounts and shows the same thread. Children get
 * React context and event bubbling from the provider, not from this slot, so everything a
 * pane needs from its surface has to be passed in through them (see {@link ChatPaneBody}).
 * Without a provider the children render in place.
 */
export function KeptChatPane({
  slotKey,
  threadId,
  children,
}: {
  slotKey: string;
  threadId: string | null;
  children: ReactNode;
}) {
  const keepAlive = useContext(ChatPaneKeepAliveContext);
  const placeholderRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<KeptPane | null>(null);
  const threadIdRef = useRef(threadId);

  useLayoutEffect(() => {
    if (!keepAlive || !placeholderRef.current) {
      return;
    }
    const pane = keepAlive.claim(slotKey, threadIdRef.current);
    paneRef.current = pane;
    keepAlive.place(pane, placeholderRef.current);
    return () => {
      paneRef.current = null;
      keepAlive.release(pane);
    };
  }, [keepAlive, slotKey]);

  // Every render: hand the latest children to the pane, which re-renders them in its host.
  useLayoutEffect(() => {
    threadIdRef.current = threadId;
    const pane = paneRef.current;
    if (!pane) {
      return;
    }
    pane.threadId = threadId;
    pane.content = children;
    for (const listener of pane.listeners) {
      listener();
    }
  });

  if (!keepAlive) {
    return <>{children}</>;
  }
  return <div ref={placeholderRef} className="contents" />;
}

/**
 * The part of a chat pane that both surfaces render inside a {@link KeptChatPane}. One
 * component with one element structure, so the chat under it is the same React subtree
 * whichever surface supplies the props.
 */
export function ChatPaneBody({
  fileOpener,
  dropOverlay,
  inset,
  children,
}: {
  fileOpener: WorkspaceFileOpener | null;
  dropOverlay: Omit<ComponentProps<typeof ChatPaneDropOverlay>, "children">;
  inset: Omit<ComponentProps<typeof SidebarInset>, "children">;
  children: ReactNode;
}) {
  return (
    <WorkspaceFileOpenerContext.Provider value={fileOpener}>
      <ChatPaneDropOverlay {...dropOverlay}>
        <SidebarInset {...inset}>{children}</SidebarInset>
      </ChatPaneDropOverlay>
    </WorkspaceFileOpenerContext.Provider>
  );
}

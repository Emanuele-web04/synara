// FILE: BrowserPanel.tsx
// Purpose: Renders the in-app browser chrome and mirrors the native Electron view.
// Layer: Desktop-only React component
// Depends on: browserStateStore, nativeApi browser bridge, DiffPanelShell

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { type ThreadId } from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LoaderCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";

import { readNativeApi } from "~/nativeApi";
import { cn } from "~/lib/utils";

import {
  useBrowserStateStore,
  selectThreadBrowserHistory,
  selectThreadBrowserState,
} from "../browserStateStore";
import {
  browserAddressDisplayValue,
  buildBrowserAddressSuggestions,
  normalizeBrowserAddressInput,
  resolveBrowserAddressSync,
  type BrowserAddressSuggestion,
} from "./BrowserPanel.logic";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

interface BrowserPanelProps {
  mode: DiffPanelMode;
  threadId: ThreadId;
  onClosePanel: () => void;
}

function closeButtonClassName(isActive: boolean) {
  return cn(
    "ml-1 size-5 shrink-0 rounded-sm p-0 text-muted-foreground/70 hover:bg-background/80 hover:text-foreground",
    isActive ? "hover:bg-background" : "hover:bg-card",
  );
}

function formatBrowserActionError(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return "Couldn't complete that browser action.";
  }
  if (/ERR_ABORTED|\(-3\)/i.test(error.message)) {
    return null;
  }
  return "Couldn't complete that browser action.";
}

export function BrowserPanel({ mode, threadId, onClosePanel }: BrowserPanelProps) {
  const api = readNativeApi();
  const threadBrowserState = useStore(useBrowserStateStore, selectThreadBrowserState(threadId));
  const recentHistory = useStore(useBrowserStateStore, selectThreadBrowserHistory(threadId));
  const upsertThreadState = useBrowserStateStore((store) => store.upsertThreadState);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const browserViewportRef = useRef<HTMLDivElement>(null);
  const addressDraftsByTabIdRef = useRef(new Map<string, string>());
  const lastSyncedAddressByTabIdRef = useRef(new Map<string, string>());
  const previousActiveTabIdRef = useRef<string | null>(null);
  const lastSentBoundsRef = useRef<string | null>(null);
  const isAddressEditingRef = useRef(false);
  const resizeFrameRef = useRef<number | null>(null);
  const boundsBurstFrameRef = useRef<number | null>(null);
  const [addressValue, setAddressValue] = useState("");
  const [isAddressFocused, setIsAddressFocused] = useState(false);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const activeTab =
    threadBrowserState?.tabs.find((tab) => tab.id === threadBrowserState.activeTabId) ??
    threadBrowserState?.tabs[0] ??
    null;
  const loading = activeTab?.isLoading ?? false;
  const activeTabStatus = activeTab?.status ?? "suspended";
  const activeTabDisplayUrl = browserAddressDisplayValue(activeTab);
  const browserAddressSuggestions = buildBrowserAddressSuggestions({
    query: addressValue,
    activeTabId: activeTab?.id ?? null,
    tabs: threadBrowserState?.tabs ?? [],
    recentHistory,
  });
  const showBrowserAddressSuggestions =
    isAddressFocused && browserAddressSuggestions.length > 0 && workspaceReady;

  const runBrowserAction = useCallback(async <T,>(action: () => Promise<T>): Promise<T | null> => {
    try {
      const result = await action();
      setLocalError(null);
      return result;
    } catch (error) {
      setLocalError(formatBrowserActionError(error));
      return null;
    }
  }, []);

  useEffect(() => {
    if (!api) {
      return;
    }

    return api.browser.onState((state) => {
      upsertThreadState(state);
    });
  }, [api, upsertThreadState]);

  useEffect(() => {
    if (!api) {
      return;
    }

    let cancelled = false;
    setWorkspaceReady(false);
    setLocalError(null);

    void runBrowserAction(() => api.browser.open({ threadId })).then((state) => {
      if (cancelled) {
        return;
      }
      if (!state) {
        setWorkspaceReady(true);
        return;
      }
      upsertThreadState(state);
      setWorkspaceReady(true);
    });

    return () => {
      cancelled = true;
      void api.browser.hide({ threadId });
    };
  }, [api, runBrowserAction, threadId, upsertThreadState]);

  useEffect(() => {
    const activeTabId = activeTab?.id ?? null;
    const nextDisplayValue = browserAddressDisplayValue(activeTab);
    const decision = resolveBrowserAddressSync({
      activeTabId,
      previousActiveTabId: previousActiveTabIdRef.current,
      savedDraft: activeTabId ? addressDraftsByTabIdRef.current.get(activeTabId) : undefined,
      nextDisplayValue,
      lastSyncedValue: activeTabId
        ? lastSyncedAddressByTabIdRef.current.get(activeTabId)
        : undefined,
      isEditing: isAddressEditingRef.current,
    });

    if (decision.type === "replace") {
      setAddressValue(decision.value);
      if (activeTabId) {
        addressDraftsByTabIdRef.current.set(activeTabId, decision.value);
        if (decision.syncedValue !== undefined) {
          lastSyncedAddressByTabIdRef.current.set(activeTabId, decision.syncedValue);
        }
      }
    }

    previousActiveTabIdRef.current = activeTabId;
  }, [activeTab]);

  useEffect(() => {
    const liveTabIds = new Set(threadBrowserState?.tabs.map((tab) => tab.id) ?? []);
    for (const tabId of addressDraftsByTabIdRef.current.keys()) {
      if (!liveTabIds.has(tabId)) {
        addressDraftsByTabIdRef.current.delete(tabId);
        lastSyncedAddressByTabIdRef.current.delete(tabId);
      }
    }
  }, [threadBrowserState?.tabs]);

  useLayoutEffect(() => {
    if (!api) {
      return;
    }

    const element = browserViewportRef.current;
    if (!element) {
      return;
    }

    const syncBounds = () => {
      const rect = element.getBoundingClientRect();
      const bounds =
        rect.width > 0 && rect.height > 0
          ? {
              x: rect.left,
              y: rect.top,
              width: rect.width,
              height: rect.height,
            }
          : null;
      const nextKey = bounds
        ? `${Math.round(bounds.x)}:${Math.round(bounds.y)}:${Math.round(bounds.width)}:${Math.round(bounds.height)}`
        : "hidden";
      if (lastSentBoundsRef.current === nextKey) {
        return;
      }
      lastSentBoundsRef.current = nextKey;
      void runBrowserAction(() => api.browser.setPanelBounds({ threadId, bounds }));
    };

    // The right panel opens with an off-canvas slide animation, so the viewport's
    // x/y position changes for a few frames without triggering ResizeObserver.
    const syncBoundsBurst = (frames = 18) => {
      if (boundsBurstFrameRef.current !== null) {
        cancelAnimationFrame(boundsBurstFrameRef.current);
      }

      let framesRemaining = frames;
      const tick = () => {
        syncBounds();
        framesRemaining -= 1;
        if (framesRemaining > 0) {
          boundsBurstFrameRef.current = window.requestAnimationFrame(tick);
          return;
        }
        boundsBurstFrameRef.current = null;
      };

      boundsBurstFrameRef.current = window.requestAnimationFrame(tick);
    };

    const scheduleSyncBounds = () => {
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
      }
      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        syncBounds();
      });
    };

    const transitionTargets = [
      element.closest<HTMLElement>("[data-slot='sidebar-container']"),
      element.closest<HTMLElement>("[data-slot='sheet-popup']"),
    ].filter((target): target is HTMLElement => target !== null);
    const handleTransitionBounds = () => {
      scheduleSyncBounds();
      syncBoundsBurst();
    };

    scheduleSyncBounds();
    syncBoundsBurst();
    const observer = new ResizeObserver(() => {
      scheduleSyncBounds();
    });
    observer.observe(element);
    window.addEventListener("resize", scheduleSyncBounds);
    for (const target of transitionTargets) {
      target.addEventListener("transitionrun", handleTransitionBounds);
      target.addEventListener("transitionend", handleTransitionBounds);
      target.addEventListener("transitioncancel", handleTransitionBounds);
    }

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", scheduleSyncBounds);
      for (const target of transitionTargets) {
        target.removeEventListener("transitionrun", handleTransitionBounds);
        target.removeEventListener("transitionend", handleTransitionBounds);
        target.removeEventListener("transitioncancel", handleTransitionBounds);
      }
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      if (boundsBurstFrameRef.current !== null) {
        cancelAnimationFrame(boundsBurstFrameRef.current);
        boundsBurstFrameRef.current = null;
      }
      void api.browser.hide({ threadId });
    };
  }, [api, runBrowserAction, threadId]);

  const onSubmitAddress = useCallback(() => {
    if (!api || !activeTab) {
      return;
    }
    isAddressEditingRef.current = false;
    setIsAddressFocused(false);
    const normalizedAddress = normalizeBrowserAddressInput(addressValue);
    addressDraftsByTabIdRef.current.set(activeTab.id, normalizedAddress);
    setAddressValue(normalizedAddress);
    void runBrowserAction(() =>
      api.browser.navigate({ threadId, tabId: activeTab.id, url: normalizedAddress }),
    ).then((state) => {
      if (state) {
        upsertThreadState(state);
      }
    });
  }, [activeTab, addressValue, api, runBrowserAction, threadId, upsertThreadState]);

  const onChooseSuggestion = useCallback(
    (suggestion: BrowserAddressSuggestion) => {
      if (!api) {
        return;
      }

      isAddressEditingRef.current = false;
      setIsAddressFocused(false);
      setAddressValue(suggestion.url);

      const tabId = suggestion.tabId;
      if (suggestion.kind === "tab" && typeof tabId === "string") {
        void runBrowserAction(() => api.browser.selectTab({ threadId, tabId })).then((state) => {
          if (state) {
            upsertThreadState(state);
          }
          window.requestAnimationFrame(() => {
            addressInputRef.current?.focus();
            addressInputRef.current?.select();
          });
        });
        return;
      }

      if (activeTab) {
        addressDraftsByTabIdRef.current.set(activeTab.id, suggestion.url);
      }

      void runBrowserAction(() =>
        api.browser.navigate({
          threadId,
          url: suggestion.url,
          ...(activeTab ? { tabId: activeTab.id } : {}),
        }),
      ).then((state) => {
        if (state) {
          upsertThreadState(state);
        }
      });
    },
    [activeTab, api, runBrowserAction, threadId, upsertThreadState],
  );

  const onCreateTab = useCallback(() => {
    if (!api) {
      return;
    }
    void runBrowserAction(() => api.browser.newTab({ threadId, activate: true })).then((state) => {
      if (state) {
        upsertThreadState(state);
      }
      window.requestAnimationFrame(() => {
        addressInputRef.current?.focus();
        addressInputRef.current?.select();
      });
    });
  }, [api, runBrowserAction, threadId, upsertThreadState]);

  const onCloseTab = useCallback(
    (tabId: string) => {
      if (!api) {
        return;
      }
      void runBrowserAction(() => api.browser.closeTab({ threadId, tabId })).then((state) => {
        if (!state) {
          return;
        }
        upsertThreadState(state);
        if (!state.open && state.tabs.length === 0) {
          onClosePanel();
        }
      });
    },
    [api, onClosePanel, runBrowserAction, threadId, upsertThreadState],
  );

  const header = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div className="relative flex min-w-0 flex-1 items-center gap-2">
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 shrink-0"
            disabled={!activeTab?.canGoBack}
            onClick={() => {
              if (!api || !activeTab) return;
              void runBrowserAction(() =>
                api.browser.goBack({ threadId, tabId: activeTab.id }),
              ).then((state) => {
                if (state) {
                  upsertThreadState(state);
                }
              });
            }}
          >
            <ArrowLeftIcon className="size-3.5" />
            <span className="sr-only">Go back</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 shrink-0"
            disabled={!activeTab?.canGoForward}
            onClick={() => {
              if (!api || !activeTab) return;
              void runBrowserAction(() =>
                api.browser.goForward({ threadId, tabId: activeTab.id }),
              ).then((state) => {
                if (state) {
                  upsertThreadState(state);
                }
              });
            }}
          >
            <ArrowRightIcon className="size-3.5" />
            <span className="sr-only">Go forward</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 shrink-0"
            disabled={!activeTab}
            onClick={() => {
              if (!api || !activeTab) return;
              void runBrowserAction(() =>
                api.browser.reload({ threadId, tabId: activeTab.id }),
              ).then((state) => {
                if (state) {
                  upsertThreadState(state);
                }
              });
            }}
          >
            {loading ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3.5" />
            )}
            <span className="sr-only">Reload</span>
          </Button>
        </div>
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmitAddress();
          }}
        >
          <Input
            ref={addressInputRef}
            value={addressValue}
            onChange={(event) => {
              const nextValue = event.target.value;
              isAddressEditingRef.current = true;
              setAddressValue(nextValue);
              if (activeTab) {
                addressDraftsByTabIdRef.current.set(activeTab.id, nextValue);
              }
            }}
            onFocus={() => {
              isAddressEditingRef.current = true;
            }}
            onBlur={() => {
              isAddressEditingRef.current = false;
              setIsAddressFocused(false);
            }}
            placeholder="Search or enter a URL"
            className="font-mono h-8 min-w-0 bg-background/70 text-xs tracking-tight"
          />
        </form>
        {showBrowserAddressSuggestions ? (
          <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
            <div className="max-h-64 overflow-auto p-1">
              {browserAddressSuggestions.map((suggestion) => (
                <button
                  key={suggestion.id}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onChooseSuggestion(suggestion);
                  }}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center rounded-sm bg-background/80">
                    {suggestion.kind === "navigate" ? (
                      <ExternalLinkIcon className="size-3 text-muted-foreground" />
                    ) : suggestion.faviconUrl ? (
                      <img alt="" src={suggestion.faviconUrl} className="size-3 rounded-[2px]" />
                    ) : (
                      <GlobeIcon className="size-3 text-muted-foreground" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{suggestion.title}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {suggestion.detail}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7"
          onClick={onCreateTab}
        >
          <PlusIcon className="size-3.5" />
          <span className="sr-only">New tab</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7"
          disabled={!activeTab}
          onClick={() => {
            if (!api || !activeTab) return;
            void api.shell.openExternal(activeTab.url);
          }}
        >
          <ExternalLinkIcon className="size-3.5" />
          <span className="sr-only">Open in external browser</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7"
          onClick={onClosePanel}
        >
          <XIcon className="size-3.5" />
          <span className="sr-only">Close browser panel</span>
        </Button>
      </div>
    </div>
  );

  if (!api) {
    return (
      <DiffPanelShell mode={mode} header={header}>
        <DiffPanelLoadingState label="Browser is unavailable." />
      </DiffPanelShell>
    );
  }

  return (
    <DiffPanelShell mode={mode} header={header}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
          {threadBrowserState?.tabs.map((tab) => {
            const isActive = tab.id === activeTab?.id;
            return (
              <div
                key={tab.id}
                className={cn(
                  "group flex h-8 min-w-0 max-w-[14rem] items-center rounded-md border px-2 text-left text-xs transition-colors",
                  isActive
                    ? "border-border bg-card text-foreground shadow-sm"
                    : "border-transparent bg-background/40 text-muted-foreground hover:bg-card/60",
                  tab.status === "suspended" ? "opacity-75" : "",
                )}
              >
                <span className="mr-2 flex size-4 shrink-0 items-center justify-center rounded-sm bg-background/80">
                  {tab.faviconUrl ? (
                    <img alt="" src={tab.faviconUrl} className="size-3 rounded-[2px]" />
                  ) : (
                    <GlobeIcon className="size-3 text-muted-foreground" />
                  )}
                </span>
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left"
                  onClick={() => {
                    void runBrowserAction(() =>
                      api.browser.selectTab({ threadId, tabId: tab.id }),
                    ).then((state) => {
                      if (state) {
                        upsertThreadState(state);
                      }
                    });
                  }}
                >
                  {tab.title || "Untitled"}
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className={closeButtonClassName(isActive)}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                >
                  <XIcon className="size-3" />
                  <span className="sr-only">Close tab</span>
                </Button>
              </div>
            );
          })}
        </div>
        <div className="border-b border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground">
          {localError ? (
            <span className="text-destructive">{localError}</span>
          ) : threadBrowserState?.lastError ? (
            <span className="text-destructive">{threadBrowserState.lastError}</span>
          ) : activeTabStatus === "suspended" ? (
            "Restoring tab..."
          ) : activeTab ? (
            activeTabDisplayUrl || "New tab"
          ) : workspaceReady ? (
            "No tabs open"
          ) : (
            "Starting browser..."
          )}
        </div>
        <div className="relative min-h-0 flex-1 bg-background">
          {!workspaceReady ? (
            <div className="absolute inset-0 z-10">
              <DiffPanelLoadingState label="Starting browser..." />
            </div>
          ) : null}
          <div ref={browserViewportRef} className="absolute inset-0" />
        </div>
      </div>
    </DiffPanelShell>
  );
}

export default BrowserPanel;

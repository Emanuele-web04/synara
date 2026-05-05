// FILE: CodexPetLayer.tsx
// Purpose: Renders local Codex Pet sprites as an isolated draggable Electron/web overlay.
// Layer: Global UI overlay
// Depends on: pet domain helpers, local /codex-pets HTTP assets, and desktop pet overlay IPC

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type MutableRefObject,
  type PointerEvent,
} from "react";

import { cn } from "~/lib/utils";
import { activityLabel, ActivityIcon } from "~/backgroundThreadActivityPresentation";
import { MessageCircleIcon } from "~/lib/icons";
import { readNativeApi } from "~/nativeApi";

import {
  PET_COLUMNS,
  PET_RENDER_HEIGHT,
  PET_RENDER_WIDTH,
  PET_ROWS,
  PET_STATE_ROWS,
  shouldLoopPetAnimation,
  type CodexPetAnimation,
} from "./petModel";
import {
  clampPosition,
  defaultPosition,
  readStoredPosition,
  storePosition,
  type PetPosition,
} from "./petPosition";
import { useCodexPets } from "./useCodexPets";
import { useGlobalPetAnimation } from "./useGlobalPetAnimation";
import { usePetActivity } from "./usePetActivity";
import {
  dispatchPetVisibilityChanged,
  PET_VISIBILITY_CHANGED_EVENT,
  readPetEnabled,
  storePetEnabled,
} from "./petVisibility";

const TAP_MOVEMENT_THRESHOLD = 8;
const PET_REACTION_DURATION_MS = 900;

interface DragState {
  readonly pointerId: number;
  readonly startClientX: number;
  readonly startClientY: number;
  readonly startPosition: PetPosition;
  readonly lastClientX: number;
  readonly lastClientY: number;
}

interface PetReaction {
  readonly animation: Extract<CodexPetAnimation, "jumping" | "waving">;
  readonly until: number;
}

type PetSpriteStyle = CSSProperties & {
  "--codex-pet-duration"?: string;
  "--codex-pet-steps"?: number;
  "--codex-pet-iterations"?: number | "infinite";
  "--codex-pet-fill-mode"?: "none" | "forwards";
  "--codex-pet-sprite-x-end"?: string;
};

function useReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(media.matches);
    const onChange = () => setReducedMotion(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return reducedMotion;
}

function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(() =>
    typeof document === "undefined" ? false : document.visibilityState !== "visible",
  );

  useEffect(() => {
    if (typeof document === "undefined") return;
    const updateHidden = () => setHidden(document.visibilityState !== "visible");
    updateHidden();
    document.addEventListener("visibilitychange", updateHidden);
    return () => document.removeEventListener("visibilitychange", updateHidden);
  }, []);

  return hidden;
}

function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() =>
    typeof document === "undefined" ? true : document.hasFocus(),
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const updateFocused = () => setFocused(document.hasFocus());
    updateFocused();
    window.addEventListener("focus", updateFocused);
    window.addEventListener("blur", updateFocused);
    document.addEventListener("visibilitychange", updateFocused);
    return () => {
      window.removeEventListener("focus", updateFocused);
      window.removeEventListener("blur", updateFocused);
      document.removeEventListener("visibilitychange", updateFocused);
    };
  }, []);

  return focused;
}

function usePetEnabled(): readonly [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabledState] = useState(readPetEnabled);

  useEffect(() => {
    const onVisibilityChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ enabled?: unknown }>).detail;
      if (typeof detail?.enabled === "boolean") {
        setEnabledState(detail.enabled);
        return;
      }
      setEnabledState(readPetEnabled());
    };
    window.addEventListener(PET_VISIBILITY_CHANGED_EVENT, onVisibilityChanged);
    return () => window.removeEventListener(PET_VISIBILITY_CHANGED_EVENT, onVisibilityChanged);
  }, []);

  const setEnabled = useCallback((nextEnabled: boolean) => {
    storePetEnabled(nextEnabled);
    setEnabledState(nextEnabled);
    dispatchPetVisibilityChanged(nextEnabled);
  }, []);

  return [enabled, setEnabled];
}

function usePetPosition(): {
  readonly position: PetPosition;
  readonly positionRef: MutableRefObject<PetPosition>;
  readonly setLivePosition: (position: PetPosition) => void;
  readonly commitPosition: (position: PetPosition) => void;
} {
  const [position, setPosition] = useState(() =>
    clampPosition(readStoredPosition() ?? defaultPosition()),
  );
  const positionRef = useRef(position);

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  useEffect(() => {
    const onResize = () => {
      setPosition((current) => {
        const next = clampPosition(current);
        positionRef.current = next;
        storePosition(next);
        return next;
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const setLivePosition = useCallback((nextPosition: PetPosition) => {
    const clamped = clampPosition(nextPosition);
    positionRef.current = clamped;
    setPosition(clamped);
  }, []);

  const commitPosition = useCallback((nextPosition: PetPosition) => {
    const clamped = clampPosition(nextPosition);
    positionRef.current = clamped;
    setPosition(clamped);
    storePosition(clamped);
  }, []);

  return { position, positionRef, setLivePosition, commitPosition };
}

export default function CodexPetLayer() {
  const pets = useCodexPets();
  const contextAnimation = useGlobalPetAnimation();
  const reducedMotion = useReducedMotion();
  const documentHidden = useDocumentHidden();
  const windowFocused = useWindowFocused();
  const [petEnabled, setPetEnabled] = usePetEnabled();
  const { position, positionRef, setLivePosition, commitPosition } = usePetPosition();
  const [dragging, setDragging] = useState(false);
  const [dragDirection, setDragDirection] = useState<"left" | "right">("right");
  const [reaction, setReaction] = useState<PetReaction | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const desktopOverlayActive =
    typeof window !== "undefined" &&
    Boolean(window.desktopBridge?.petOverlay) &&
    (documentHidden || !windowFocused);
  const desktopOverlayActiveRef = useRef(desktopOverlayActive);
  const { activitySummary, openPrimaryActivity, primaryActivity } =
    usePetActivity(desktopOverlayActive);
  const closePet = useCallback(() => {
    setPetEnabled(false);
    void window.desktopBridge?.petOverlay?.close();
  }, [setPetEnabled]);
  const showPetMenu = useCallback(
    async (position?: { x: number; y: number }) => {
      const clicked = await readNativeApi()?.contextMenu.show(
        [{ id: "close-pet", label: "Close Pet", destructive: true }],
        position,
      );
      if (clicked === "close-pet") {
        closePet();
      }
    },
    [closePet],
  );

  const pet = pets.find((candidate) => candidate.id === "icarus") ?? pets[0] ?? null;
  const animation = useMemo<CodexPetAnimation>(() => {
    const now = Date.now();
    if (dragging) {
      return dragDirection === "left" ? "runningLeft" : "runningRight";
    }
    if (reaction && reaction.until > now) {
      return reaction.animation;
    }
    return contextAnimation;
  }, [contextAnimation, dragDirection, dragging, reaction]);
  const animationSpec = PET_STATE_ROWS[animation];

  useEffect(() => {
    desktopOverlayActiveRef.current = desktopOverlayActive;
  }, [desktopOverlayActive]);

  const triggerTapReaction = useCallback(() => {
    setReaction({
      animation: Math.random() > 0.45 ? "jumping" : "waving",
      until: Date.now() + PET_REACTION_DURATION_MS,
    });
  }, []);

  const applyDragMove = useCallback(
    (clientX: number, clientY: number, pointerId: number) => {
      const dragState = dragStateRef.current;
      if (!dragState || dragState.pointerId !== pointerId) return;
      if (Math.abs(clientX - dragState.lastClientX) > 1) {
        setDragDirection(clientX < dragState.lastClientX ? "left" : "right");
      }
      const nextPosition = {
        x: dragState.startPosition.x + clientX - dragState.startClientX,
        y: dragState.startPosition.y + clientY - dragState.startClientY,
      };
      dragStateRef.current = {
        ...dragState,
        lastClientX: clientX,
        lastClientY: clientY,
      };
      setLivePosition(nextPosition);
    },
    [setLivePosition],
  );

  const finishDrag = useCallback(
    (clientX: number, clientY: number, pointerId: number) => {
      const dragState = dragStateRef.current;
      if (!dragState || dragState.pointerId !== pointerId) return;
      const nextPosition = {
        x: dragState.startPosition.x + clientX - dragState.startClientX,
        y: dragState.startPosition.y + clientY - dragState.startClientY,
      };
      const movedDistance = Math.hypot(
        clientX - dragState.startClientX,
        clientY - dragState.startClientY,
      );
      dragStateRef.current = null;
      setDragging(false);
      commitPosition(nextPosition);
      if (movedDistance <= TAP_MOVEMENT_THRESHOLD) {
        triggerTapReaction();
      } else {
        setReaction({
          animation: "jumping",
          until: Date.now() + PET_REACTION_DURATION_MS,
        });
      }
    },
    [commitPosition, triggerTapReaction],
  );

  useEffect(() => {
    if (!dragging) return;

    const onWindowPointerMove = (event: globalThis.PointerEvent) => {
      applyDragMove(event.clientX, event.clientY, event.pointerId);
    };
    const onWindowPointerUp = (event: globalThis.PointerEvent) => {
      finishDrag(event.clientX, event.clientY, event.pointerId);
    };

    window.addEventListener("pointermove", onWindowPointerMove);
    window.addEventListener("pointerup", onWindowPointerUp);
    window.addEventListener("pointercancel", onWindowPointerUp);
    return () => {
      window.removeEventListener("pointermove", onWindowPointerMove);
      window.removeEventListener("pointerup", onWindowPointerUp);
      window.removeEventListener("pointercancel", onWindowPointerUp);
    };
  }, [applyDragMove, dragging, finishDrag]);

  useEffect(() => {
    if (!reaction) return;
    const remainingMs = reaction.until - Date.now();
    if (remainingMs <= 0) {
      setReaction(null);
      return;
    }
    const timeout = window.setTimeout(() => setReaction(null), remainingMs);
    return () => window.clearTimeout(timeout);
  }, [reaction]);

  useEffect(() => {
    const petOverlay = window.desktopBridge?.petOverlay;
    if (!petOverlay) return;

    return petOverlay.onMoved((screenPosition) => {
      const nextPosition = clampPosition({
        x: screenPosition.x - window.screenX,
        y: screenPosition.y - window.screenY,
      });
      positionRef.current = nextPosition;
      storePosition(nextPosition);
      // Background drags are already applied by the native overlay; avoid waking React per move.
      if (!desktopOverlayActiveRef.current) {
        setLivePosition(nextPosition);
      }
    });
  }, [positionRef, setLivePosition]);

  useEffect(() => {
    if (desktopOverlayActive) return;
    setLivePosition(positionRef.current);
  }, [desktopOverlayActive, positionRef, setLivePosition]);

  useEffect(() => {
    const petOverlay = window.desktopBridge?.petOverlay;
    if (!petOverlay) return;

    return () => {
      void petOverlay.hide();
    };
  }, []);

  useEffect(() => {
    const petOverlay = window.desktopBridge?.petOverlay;
    if (!petOverlay) return;

    if (!pet || !petEnabled) {
      void petOverlay.close();
      return;
    }

    void petOverlay.setState({
      visible: desktopOverlayActive,
      spritesheetUrl: pet.spritesheetUrl,
      displayName: pet.displayName,
      description: pet.description,
      animation,
      activity: activitySummary,
      row: animationSpec.row,
      frames: animationSpec.frames,
      durationMs: reducedMotion ? 0 : animationSpec.durationMs,
      width: PET_RENDER_WIDTH,
      height: PET_RENDER_HEIGHT,
      columns: PET_COLUMNS,
      rows: PET_ROWS,
      x: Math.round(window.screenX + position.x),
      y: Math.round(window.screenY + position.y),
    });
  }, [
    animation,
    animationSpec,
    activitySummary,
    desktopOverlayActive,
    pet,
    petEnabled,
    position.x,
    position.y,
    reducedMotion,
  ]);

  const spriteStyle = useMemo<PetSpriteStyle>(() => {
    const row = animationSpec.row;
    const frames = animationSpec.frames;
    const frameDurationMs = animationSpec.durationMs;
    const loops = shouldLoopPetAnimation(animation);
    const animatedSteps = loops ? frames : Math.max(1, frames - 1);
    return {
      width: PET_RENDER_WIDTH,
      height: PET_RENDER_HEIGHT,
      contain: "layout paint style",
      overflow: "hidden",
      isolation: "isolate",
      transform: "translateZ(0)",
      "--codex-pet-duration": `${frames * frameDurationMs}ms`,
      "--codex-pet-steps": animatedSteps,
      "--codex-pet-iterations": loops ? "infinite" : 1,
      "--codex-pet-fill-mode": loops ? "none" : "forwards",
      "--codex-pet-sprite-x-end": `${-(loops ? frames : frames - 1) * PET_RENDER_WIDTH}px`,
    };
  }, [animation, animationSpec, pet]);

  const stripStyle = useMemo<CSSProperties>(
    () => ({
      width: PET_RENDER_WIDTH * PET_COLUMNS,
      height: PET_RENDER_HEIGHT,
      backgroundImage: pet ? `url("${pet.spritesheetUrl}")` : undefined,
      backgroundRepeat: "no-repeat",
      backgroundSize: `${PET_RENDER_WIDTH * PET_COLUMNS}px ${PET_RENDER_HEIGHT * PET_ROWS}px`,
      backgroundPosition: `0px ${-animationSpec.row * PET_RENDER_HEIGHT}px`,
      imageRendering: "pixelated",
      transform: "translate3d(0, 0, 0)",
    }),
    [animationSpec.row, pet],
  );

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") return;
    return onMenuAction((action) => {
      if (action === "show-pet") {
        setPetEnabled(true);
      } else if (action === "close-pet") {
        closePet();
      }
    });
  }, [closePet, setPetEnabled]);

  if (!pet || !petEnabled) {
    return null;
  }

  if (desktopOverlayActive) {
    return null;
  }

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStateRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPosition: position,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
    };
    setReaction(null);
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    applyDragMove(event.clientX, event.clientY, event.pointerId);
  };

  const onPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    finishDrag(event.clientX, event.clientY, event.pointerId);
  };

  const isInputNeeded = primaryActivity?.kind === "input-needed";
  const onPetMenu = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void showPetMenu({ x: event.clientX, y: event.clientY });
  };

  return (
    <div
      data-codex-pet-layer="true"
      className="pointer-events-none fixed z-40"
      style={{ left: position.x, top: position.y }}
      aria-live="off"
    >
      <button
        type="button"
        data-pet-animation={animation}
        aria-label={`${pet.displayName}: ${pet.description}`}
        title={pet.displayName}
        className={cn(
          "pointer-events-auto relative block cursor-grab select-none rounded-md outline-none transition-[filter,transform,opacity]",
          "[-webkit-app-region:no-drag] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          dragging ? "cursor-grabbing scale-[1.03]" : "hover:scale-[1.02]",
        )}
        style={{ touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={onPetMenu}
        onDoubleClick={onPetMenu}
      >
        <span
          aria-hidden="true"
          className="block drop-shadow-[0_10px_18px_rgba(0,0,0,0.32)]"
          style={spriteStyle}
        >
          <span
            className={cn(
              "block",
              !reducedMotion && animationSpec.frames > 1 ? "codex-pet-sprite--animated" : "",
            )}
            key={animation}
            style={stripStyle}
          />
        </span>
        <span
          aria-hidden="true"
          className="codex-pet-ground pointer-events-none absolute left-1/2 -translate-x-1/2 rounded-[50%]"
          style={{
            bottom: -6,
            width: PET_RENDER_WIDTH * 0.7,
            height: 10,
          }}
        />
      </button>
      {primaryActivity ? (
        <button
          aria-label={`Open ${primaryActivity.title}`}
          className={cn(
            "codex-pet-dock pointer-events-auto absolute left-1/2 flex min-h-9 w-[min(240px,calc(100vw-1rem))] -translate-x-1/2 items-center gap-2 rounded-2xl border px-2.5 py-1.5 text-left text-popover-foreground backdrop-blur-md transition-[background-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            isInputNeeded ? "border-amber-400/55" : "border-border/70",
          )}
          onClick={openPrimaryActivity}
          onContextMenu={onPetMenu}
          style={
            {
              top: PET_RENDER_HEIGHT + 10,
              ["--codex-pet-dock-notch-border" as string]: isInputNeeded
                ? "color-mix(in srgb, oklch(0.78 0.18 75) 55%, transparent)"
                : undefined,
            } as CSSProperties
          }
          title={`${activityLabel(primaryActivity.kind)}: ${primaryActivity.title}`}
          type="button"
        >
          <span aria-hidden="true" className="codex-pet-dock-notch" />
          {isInputNeeded ? (
            <ActivityIcon kind={primaryActivity.kind} />
          ) : (
            <MessageCircleIcon className="size-3.5 shrink-0 text-sky-500" />
          )}
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {activitySummary?.label}
            </span>
            <span className="block truncate text-xs font-semibold">{activitySummary?.title}</span>
          </span>
          {!isInputNeeded ? <ActivityIcon kind={primaryActivity.kind} /> : null}
        </button>
      ) : null}
    </div>
  );
}

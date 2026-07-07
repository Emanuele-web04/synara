// FILE: WorldCup2026View.tsx
// Purpose: World Cup 2026 playground — a top-down pitch with a draggable, throwable
//          soccer ball that obeys friction, wall bounces, and rolling/free-spin rotation.
// Layer: World Cup 2026 view
// Exports: WorldCup2026View (default)

import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { IoIosArrowRoundBack, IoIosArrowRoundForward } from "react-icons/io";

import { SidebarHeaderNavigationControls } from "../SidebarHeaderNavigationControls";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { RotateCcwIcon } from "~/lib/icons";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { cn } from "~/lib/utils";
import { SoccerBall } from "./SoccerBall";
import {
  type BallBounds,
  type BallState,
  type PointerSample,
  advanceBall,
  clampSpin,
  SPIN_IMPULSE,
  throwVelocityFromSamples,
} from "./ballPhysics";

const BALL_RADIUS = 38;
// The shadow is a touch wider than the ball so its soft gradient edge reads as a
// halo around the ball rather than being fully hidden underneath it.
const SHADOW_RADIUS = BALL_RADIUS * 1.28;
const RAD_TO_DEG = 180 / Math.PI;
/** Cap per-frame dt so a backgrounded tab can't fling the ball on resume. */
const MAX_FRAME_DT = 0.05;
/** Drag samples older than this (ms) are dropped before computing throw velocity. */
const SAMPLE_WINDOW_MS = 110;

function createInitialState(bounds: BallBounds): BallState {
  return {
    x: bounds.width > 0 ? bounds.width / 2 : 0,
    y: bounds.height > 0 ? bounds.height / 2 : 0,
    vx: 0,
    vy: 0,
    angle: 0,
    spin: 0,
  };
}

export function WorldCup2026View() {
  const { t } = useTranslation();
  const trafficLightGutter = useDesktopTopBarTrafficLightGutterClassName();
  const windowControlsGutter = useDesktopTopBarWindowControlsGutterClassName();

  const fieldRef = useRef<HTMLDivElement | null>(null);
  const ballRef = useRef<HTMLDivElement | null>(null);
  const shadowRef = useRef<HTMLDivElement | null>(null);

  const boundsRef = useRef<BallBounds>({ width: 0, height: 0, radius: BALL_RADIUS });
  const stateRef = useRef<BallState>(createInitialState(boundsRef.current));
  const initializedRef = useRef(false);

  const draggingRef = useRef(false);
  const pointerOffsetRef = useRef({ x: 0, y: 0 });
  const samplesRef = useRef<PointerSample[]>([]);

  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef(0);

  // Promote the ball/shadow to their own compositor layer only while they move, so
  // the transform animation stays off the main thread without holding the extra
  // layer memory once the ball is parked.
  const setLayerHint = useCallback((active: boolean) => {
    const hint = active ? "transform" : "auto";
    if (ballRef.current) ballRef.current.style.willChange = hint;
    if (shadowRef.current) shadowRef.current.style.willChange = hint;
  }, []);

  const renderBall = useCallback(() => {
    const state = stateRef.current;
    const r = boundsRef.current.radius;
    if (ballRef.current) {
      ballRef.current.style.transform = `translate3d(${state.x - r}px, ${state.y - r}px, 0) rotate(${state.angle}deg)`;
    }
    if (shadowRef.current) {
      shadowRef.current.style.transform = `translate3d(${state.x - SHADOW_RADIUS}px, ${state.y - SHADOW_RADIUS}px, 0)`;
    }
  }, []);

  const isResting = useCallback(() => {
    const { vx, vy, spin } = stateRef.current;
    return vx === 0 && vy === 0 && spin === 0;
  }, []);

  const tick = useCallback(
    (now: number) => {
      const dt = Math.min((now - lastFrameRef.current) / 1000, MAX_FRAME_DT);
      lastFrameRef.current = now;

      if (!draggingRef.current) {
        advanceBall(stateRef.current, boundsRef.current, dt);
        renderBall();
      }

      if (!draggingRef.current && isResting()) {
        rafRef.current = null;
        setLayerHint(false);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    },
    [isResting, renderBall, setLayerHint],
  );

  const ensureLoop = useCallback(() => {
    if (rafRef.current !== null) {
      return;
    }
    setLayerHint(true);
    lastFrameRef.current = performance.now();
    rafRef.current = requestAnimationFrame(tick);
  }, [setLayerHint, tick]);

  const clampToBounds = useCallback(() => {
    const { width, height, radius } = boundsRef.current;
    if (width <= 0 || height <= 0) return;
    const state = stateRef.current;
    state.x = Math.min(Math.max(state.x, radius), width - radius);
    state.y = Math.min(Math.max(state.y, radius), height - radius);
  }, []);

  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      boundsRef.current = { width, height, radius: BALL_RADIUS };
      if (!initializedRef.current && width > 0 && height > 0) {
        initializedRef.current = true;
        stateRef.current = createInitialState(boundsRef.current);
      }
      clampToBounds();
      renderBall();
    });

    observer.observe(field);
    return () => observer.disconnect();
  }, [clampToBounds, renderBall]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  const pointerToField = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const field = fieldRef.current;
    if (!field) return { x: 0, y: 0 };
    const rect = field.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }, []);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const ball = ballRef.current;
      ball?.setPointerCapture(event.pointerId);

      setLayerHint(true);
      draggingRef.current = true;
      const point = pointerToField(event);
      const state = stateRef.current;
      state.vx = 0;
      state.vy = 0;
      pointerOffsetRef.current = { x: point.x - state.x, y: point.y - state.y };
      samplesRef.current = [{ t: performance.now(), x: point.x, y: point.y }];
    },
    [pointerToField, setLayerHint],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      event.preventDefault();

      const point = pointerToField(event);
      const offset = pointerOffsetRef.current;
      const { width, height, radius } = boundsRef.current;
      const state = stateRef.current;

      const previousX = state.x;
      const nextX = Math.min(Math.max(point.x - offset.x, radius), width - radius);
      const nextY = Math.min(Math.max(point.y - offset.y, radius), height - radius);
      state.x = nextX;
      state.y = nextY;
      // Roll the ball under the cursor so dragging itself spins it.
      if (radius > 0) {
        state.angle += ((nextX - previousX) / radius) * RAD_TO_DEG;
      }

      const now = performance.now();
      const samples = samplesRef.current;
      samples.push({ t: now, x: point.x, y: point.y });
      const cutoff = now - SAMPLE_WINDOW_MS;
      while (samples.length > 2 && samples[0]!.t < cutoff) {
        samples.shift();
      }

      renderBall();
    },
    [pointerToField, renderBall],
  );

  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      ballRef.current?.releasePointerCapture(event.pointerId);

      const { vx, vy } = throwVelocityFromSamples(samplesRef.current, SAMPLE_WINDOW_MS);
      samplesRef.current = [];
      const state = stateRef.current;
      state.vx = vx;
      state.vy = vy;
      ensureLoop();
    },
    [ensureLoop],
  );

  const applySpin = useCallback(
    (direction: -1 | 1) => {
      const state = stateRef.current;
      state.spin = clampSpin(state.spin + direction * SPIN_IMPULSE);
      ensureLoop();
    },
    [ensureLoop],
  );

  const resetBall = useCallback(() => {
    initializedRef.current = true;
    stateRef.current = createInitialState(boundsRef.current);
    renderBall();
  }, [renderBall]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        applySpin(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        applySpin(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applySpin]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden isolate">
      <div className="flex h-full flex-col">
        <div
          className={cn(
            "drag-region flex h-12 shrink-0 items-center gap-3 border-b border-border px-4 sm:px-6",
            trafficLightGutter,
            windowControlsGutter,
          )}
        >
          <SidebarHeaderNavigationControls />
          <div className="flex items-center gap-2">
            <SoccerBall className="size-5" />
            <span className="text-sm font-semibold tracking-tight text-foreground">
              {t("app.worldCup2026")}
            </span>
          </div>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden p-4 sm:p-6">
          <div
            ref={fieldRef}
            className="relative h-full w-full touch-none overflow-hidden rounded-2xl border border-emerald-900/40 shadow-inner select-none"
            style={{
              background:
                "repeating-linear-gradient(0deg, #2f8f4e 0px, #2f8f4e 56px, #2a8347 56px, #2a8347 112px)",
            }}
          >
            <PitchMarkings />

            {/* Gradient-based contact shadow: a soft falloff without a filter blur,
                so there is no per-frame re-rasterization while the ball travels. */}
            <div
              ref={shadowRef}
              aria-hidden
              className="pointer-events-none absolute top-0 left-0 rounded-full"
              style={{
                width: SHADOW_RADIUS * 2,
                height: SHADOW_RADIUS * 2,
                background:
                  "radial-gradient(closest-side, rgba(0,0,0,0.38), rgba(0,0,0,0.2) 62%, transparent 80%)",
                transform: "translate3d(-1000px, -1000px, 0)",
              }}
            />
            <div
              ref={ballRef}
              role="button"
              tabIndex={0}
              aria-label={t("accessibility.dragAndThrowBall")}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              className="absolute top-0 left-0 cursor-grab touch-none active:cursor-grabbing"
              style={{
                width: BALL_RADIUS * 2,
                height: BALL_RADIUS * 2,
                transform: "translate3d(-1000px, -1000px, 0)",
              }}
            >
              <SoccerBall className="h-full w-full" />
            </div>

            <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
              <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-white/15 bg-black/35 px-2 py-1.5 backdrop-blur-sm">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-9 rounded-full text-white/90 hover:bg-white/15 hover:text-white"
                  aria-label={t("accessibility.spinCounterClockwise")}
                  onClick={() => applySpin(-1)}
                >
                  <IoIosArrowRoundBack className="size-7" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-9 rounded-full text-white/90 hover:bg-white/15 hover:text-white"
                  aria-label={t("accessibility.resetBallToCenter")}
                  onClick={resetBall}
                >
                  <RotateCcwIcon className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-9 rounded-full text-white/90 hover:bg-white/15 hover:text-white"
                  aria-label={t("accessibility.spinClockwise")}
                  onClick={() => applySpin(1)}
                >
                  <IoIosArrowRoundForward className="size-7" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

function PitchMarkings() {
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
      preserveAspectRatio="none"
      viewBox="0 0 1000 600"
    >
      <g fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth={3}>
        <rect x={16} y={16} width={968} height={568} rx={6} />
        <line x1={500} y1={16} x2={500} y2={584} />
        <circle cx={500} cy={300} r={70} />
        <circle cx={500} cy={300} r={4} fill="rgba(255,255,255,0.7)" stroke="none" />
        <rect x={16} y={170} width={130} height={260} />
        <rect x={16} y={240} width={54} height={120} />
        <rect x={854} y={170} width={130} height={260} />
        <rect x={930} y={240} width={54} height={120} />
      </g>
    </svg>
  );
}

export default WorldCup2026View;

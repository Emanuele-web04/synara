// FILE: governor.ts
// Purpose: One clock for every moving liquid metal (HoloBot's packages/ui rim/governor.ts).
//          Paper's own loop is an uncapped requestAnimationFrame per canvas; every metal here
//          runs at speed 0 and this one interval steps the moving ones at METAL_FPS, only while
//          the window is frontmost and visible, Reduce Motion is off and at least one moving
//          metal is mounted. A still metal draws the shared frame once and is never stepped.
// Layer: SynBot kit (metal)
// Exports: currentFrame, registerMoving

/** Steps per second, and how far one second moves the shader's own clock (Paper's `frame`
 * units: 400 per second is HoloBot's speed 0.4). */
const METAL_FPS = 15;
const METAL_FRAMES_PER_SECOND = 400;
/** The shader's first frame (HoloBot's). */
const METAL_FIRST_FRAME = 8000;
const REDUCED = "(prefers-reduced-motion: reduce)";

/** The canvases the clock steps: a moving metal's Paper mount. */
const MOVING_SHADER = ".hb-metal--shader[data-moving] [data-paper-shader]";

type Mount = HTMLElement & { paperShaderMount?: { setFrame(frame: number): void } };

let frame = METAL_FIRST_FRAME;
let moving = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let listening = false;

function step() {
  frame += METAL_FRAMES_PER_SECOND / METAL_FPS;
  for (const mount of document.querySelectorAll<Mount>(MOVING_SHADER)) {
    mount.paperShaderMount?.setFrame(frame);
  }
}

/** Runs the clock while a metal moves and the window may show it moving. */
function sync() {
  const run = moving > 0 && document.hasFocus() && !document.hidden && !matchMedia(REDUCED).matches;
  if (run && timer === null) timer = setInterval(step, 1000 / METAL_FPS);
  else if (!run && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener("focus", sync);
  window.addEventListener("blur", sync);
  document.addEventListener("visibilitychange", sync);
  matchMedia(REDUCED).addEventListener("change", sync);
}

/** The shared frame: where a metal mounting now starts, so all of them stay in phase. */
export function currentFrame(): number {
  return frame;
}

/** A moving metal mounted (returns its unmount). */
export function registerMoving(): () => void {
  listen();
  moving += 1;
  sync();
  return () => {
    moving -= 1;
    sync();
  };
}

// FILE: LiquidMetal.tsx
// Purpose: The app's liquid metal (ported from HoloBot's rim/ShaderMetal.tsx and rim/Rim.tsx):
//          Paper's LiquidMetal shader in a WebGL canvas at speed 0, stepped by one shared clock
//          (governor.ts). It fills its parent: a capsule button whose dark core leaves a thin
//          moving ring of it, or MetalRing under a round control's icon (pass it as the
//          composer's `composerSendUnderlay`). With Reduce Motion on, or when not `moving`, it
//          draws one still frame; past LIVE_METALS (budget.ts) the oldest become a still picture
//          of their last frame and give their WebGL context back. Colors: metal.css tokens.
// Layer: UI primitive (liquid metal)
// Exports: LiquidMetal, MetalRing

import { LiquidMetal as PaperLiquidMetal } from "@paper-design/shaders-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";

import { useLiveMetal } from "./budget";
import { currentFrame, registerMoving } from "./governor";
import "./metal.css";

type Mount = HTMLElement & { paperShaderMount?: { setFrame(frame: number): void } };

/** The canvas as a picture: drawn once more at the shared frame and read in the same task (the
 * drawing buffer is not cleared before it is composited); "" when it cannot be read. */
function picture(root: HTMLElement | null): string {
  const mount = root?.querySelector<Mount>("[data-paper-shader]");
  const canvas = root?.querySelector("canvas");
  if (!mount || !canvas) return "";
  try {
    mount.paperShaderMount?.setFrame(currentFrame());
    return canvas.toDataURL("image/png");
  } catch {
    return "";
  }
}

/** HoloBot's look, tuned against its logo: a silver ring with amber-orange and blue bands
 * drifting through it (the red and blue channels shifted against green across a dark band;
 * `angle` 25 keeps red ahead and blue behind all the way round; a faint cool tint turns the
 * steel toward the logo's azure; transparent back, so the dark core shows where it thins). */
const LOOK = {
  shape: "none",
  worldWidth: 0,
  worldHeight: 0,
  colorBack: "#00000000",
  colorTint: "#e8f6ff",
  repetition: 1.5,
  softness: 0.5,
  shiftRed: 0.75,
  shiftBlue: 0.55,
  distortion: 0.1,
  contour: 0.4,
  angle: 25,
} as const;

/** Paper's sheet fades at its bevelled border: `scale` > 1 shows only its middle, further on a
 * circle so its bands are about as long as a capsule's. */
const SCALE = { capsule: 1.6, circle: 3.5 } as const;

/** The moving metal, filling its parent (a primary button, the ghost's mask). */
export function LiquidMetal({
  moving,
  round = false,
}: {
  readonly moving: boolean;
  readonly round?: boolean | undefined;
}) {
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const moves = moving && !reduced;
  // The frame at mount only: afterwards the clock moves it.
  const [frame] = useState(currentFrame);
  const live = useLiveMetal();
  const root = useRef<HTMLSpanElement>(null);
  // The still picture that stands in while this metal is over the budget (null: the shader
  // draws), taken from the canvas still on screen before it unmounts.
  const [still, setStill] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!live && still === null) setStill(picture(root.current));
    else if (live && still !== null) setStill(null);
  }, [live, still]);
  const shader = still === null;
  useEffect(() => (moves && shader ? registerMoving() : undefined), [moves, shader]);
  if (!shader) {
    return (
      <span className="ui-metal" aria-hidden>
        {still ? <img className="ui-metal__canvas" src={still} alt="" /> : null}
      </span>
    );
  }
  return (
    <span
      ref={root}
      className="ui-metal ui-metal--shader"
      data-moving={moves || undefined}
      aria-hidden
    >
      <PaperLiquidMetal
        className="ui-metal__canvas"
        {...LOOK}
        scale={round ? SCALE.circle : SCALE.capsule}
        speed={0}
        frame={frame}
        minPixelRatio={1}
      />
    </span>
  );
}

/** A round control's ring (the composer's Send in a bot chat): the moving metal, and over it
 * the dark core that leaves a thin ring of it showing. Its control lays the icon on top. */
export function MetalRing() {
  return (
    <span className="ui-metal-ring" aria-hidden>
      <LiquidMetal moving round />
      <span className="ui-metal-ring__core" />
    </span>
  );
}

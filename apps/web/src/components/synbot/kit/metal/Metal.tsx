// FILE: Metal.tsx
// Purpose: The main SynBot's face (HoloBot's RimSurface.tsx MetalMark): HoloBot's ghost in white
//          with the app's liquid metal (ui/metal) as a pearl sheen under a mask of its outline,
//          and the logo's own leaning, slightly bent eyes on top, alive like every bot.
// Layer: SynBot kit (metal)
// Exports: MetalMark

import type { CSSProperties } from "react";

import { LiquidMetal } from "~/components/ui/metal/LiquidMetal";

import { HOLOBOT, HOLOBOT_EYES } from "../holobotMark";
import type { MascotMood } from "../mood";

/** The ghost's outline as a mask image (100 x 100 box, scaled to the mark). */
const MARK_MASK = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="${HOLOBOT}"/></svg>`,
)}")`;
const MASK_STYLE: CSSProperties = { maskImage: MARK_MASK, WebkitMaskImage: MARK_MASK };

/** The main SynBot: HoloBot's ghost with the moving pearl sheen and the logo's eyes. `mood`
 * makes it alive like a bot (it breathes, blinks, glances and turns its head); none holds it
 * still. */
export function MetalMark({
  className,
  style,
  moving,
  mood,
}: {
  readonly className: string;
  readonly style: CSSProperties;
  readonly moving: boolean;
  readonly mood: MascotMood | undefined;
}) {
  return (
    <span
      className={`${className} hb-mark${mood ? " hb-bot hb-bot--alive" : ""}`}
      data-mood={mood}
      style={style}
      aria-hidden
    >
      <span className="hb-mark__body hb-bot__body">
        <span className="hb-mark__metal" style={MASK_STYLE}>
          <LiquidMetal moving={moving} />
        </span>
        <svg className="hb-mark__eyes" viewBox="0 0 100 100">
          <g className="hb-bot__eyes">
            <path d={HOLOBOT_EYES} />
          </g>
        </svg>
      </span>
    </span>
  );
}

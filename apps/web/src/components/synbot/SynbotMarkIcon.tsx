// FILE: SynbotMarkIcon.tsx
// Purpose: SynBot's glyph in the app rail: HoloBot's logo (the speech-bubble ghost with its two
//          eye pills cut out), the same mark as the iPhone's Bot tab, in the current text color.
// Layer: SynBot UI primitive
// Exports: SynbotMarkIcon

import { HOLOBOT, HOLOBOT_EYES } from "./kit/holobotMark";

/** The ghost spans about 88 x 90 of its 100 box; this frame pads it like the rail's other
 * glyphs. */
const VIEW_BOX = "-2.5 -3.65 105 105";

export function SynbotMarkIcon({ className }: { readonly className?: string | undefined }) {
  return (
    <svg className={className} viewBox={VIEW_BOX} fill="currentColor" aria-hidden>
      <path fillRule="evenodd" d={`${HOLOBOT} ${HOLOBOT_EYES}`} />
    </svg>
  );
}

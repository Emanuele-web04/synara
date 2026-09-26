/**
 * First-send landing→dock choreography. One shared clock + curve so the
 * composer slide, user-bubble rise, working-row reveal, and hero exit read as
 * a single motion instead of independent pops. All pieces are transform /
 * opacity only, skipped under prefers-reduced-motion, and cancelled on thread
 * switch or unmount.
 */
export const FIRST_SEND_MOTION_DURATION_MS = 700;
export const FIRST_SEND_MOTION_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
/** Bubble text fades in over the first part of its rise. */
export const FIRST_SEND_BUBBLE_FADE_MS = 400;
/** Working header + shimmer row get a delayed rise so they arrive after the
 * bubble has visibly left the composer. */
export const FIRST_SEND_WORKING_REVEAL_DELAY_MS = 250;
export const FIRST_SEND_WORKING_REVEAL_MS = 320;
/** Landing hero fades and drifts up instead of unmounting instantly. */
export const FIRST_SEND_HERO_EXIT_MS = 200;

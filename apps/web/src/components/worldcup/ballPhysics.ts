// FILE: ballPhysics.ts
// Purpose: Pure 2D top-down ball dynamics (friction, wall restitution, rolling + free spin).
// Layer: World Cup 2026 view
// Exports: BallState, BallBounds, physics constants, advanceBall, throwVelocityFromSamples

const RAD_TO_DEG = 180 / Math.PI;

/** Exponential linear-velocity decay rate (1/s). Higher = the ball stops sooner. */
export const LINEAR_FRICTION = 0.85;
/** Fraction of speed kept after a wall bounce. */
export const WALL_RESTITUTION = 0.78;
/** Exponential decay rate (1/s) for the manual (arrow/button) free spin. */
export const SPIN_FRICTION = 1.1;
/** Below this speed (px/s) the ball is snapped to rest to avoid endless creep. */
export const MIN_SPEED = 6;
/** Below this angular speed (deg/s) the free spin is snapped to zero. */
export const MIN_SPIN = 2;
/** Hard cap on launch speed (px/s) so a violent flick cannot teleport the ball. */
export const MAX_THROW_SPEED = 4200;
/** Free-spin impulse (deg/s) applied per rotate-left / rotate-right input. */
export const SPIN_IMPULSE = 620;
/** Hard cap on accumulated free spin (deg/s). */
export const MAX_SPIN = 1800;

export interface BallState {
  /** Center X in container pixels. */
  x: number;
  /** Center Y in container pixels. */
  y: number;
  /** Velocity X in px/s. */
  vx: number;
  /** Velocity Y in px/s. */
  vy: number;
  /** Visual rotation in degrees (positive = clockwise). */
  angle: number;
  /** Manual free spin in deg/s, decays over time (positive = clockwise). */
  spin: number;
}

export interface BallBounds {
  width: number;
  height: number;
  radius: number;
}

export function clampSpin(spin: number): number {
  if (spin > MAX_SPIN) return MAX_SPIN;
  if (spin < -MAX_SPIN) return -MAX_SPIN;
  return spin;
}

/**
 * Advances the ball one timestep, mutating {@link state} in place. Mutation (rather
 * than returning a fresh object) keeps the per-frame animation loop allocation-free,
 * so the GC stays quiet while the ball is in motion.
 *
 * Rotation blends the rolling contribution (tied to horizontal velocity, so the ball
 * visibly rolls as it travels) with the decaying manual free spin.
 */
export function advanceBall(state: BallState, bounds: BallBounds, dt: number): void {
  if (dt <= 0 || bounds.width <= 0 || bounds.height <= 0) {
    return;
  }

  const { width, height, radius } = bounds;

  state.x += state.vx * dt;
  state.y += state.vy * dt;

  const friction = Math.exp(-LINEAR_FRICTION * dt);
  state.vx *= friction;
  state.vy *= friction;

  const maxX = width - radius;
  const maxY = height - radius;

  if (state.x < radius) {
    state.x = radius;
    state.vx = Math.abs(state.vx) * WALL_RESTITUTION;
  } else if (state.x > maxX) {
    state.x = maxX;
    state.vx = -Math.abs(state.vx) * WALL_RESTITUTION;
  }

  if (state.y < radius) {
    state.y = radius;
    state.vy = Math.abs(state.vy) * WALL_RESTITUTION;
  } else if (state.y > maxY) {
    state.y = maxY;
    state.vy = -Math.abs(state.vy) * WALL_RESTITUTION;
  }

  if (state.vx * state.vx + state.vy * state.vy < MIN_SPEED * MIN_SPEED) {
    state.vx = 0;
    state.vy = 0;
  }

  state.spin *= Math.exp(-SPIN_FRICTION * dt);
  if (state.spin < MIN_SPIN && state.spin > -MIN_SPIN) {
    state.spin = 0;
  }

  const rollDegPerSec = radius > 0 ? (state.vx / radius) * RAD_TO_DEG : 0;
  state.angle += (rollDegPerSec + state.spin) * dt;
}

export interface PointerSample {
  t: number;
  x: number;
  y: number;
}

/**
 * Derives a launch velocity (px/s) from recent drag samples. Uses the oldest
 * sample within {@link windowMs} of the latest so a brief pause before release
 * still throws along the final flick rather than a stale average.
 */
export function throwVelocityFromSamples(
  samples: readonly PointerSample[],
  windowMs = 90,
): { vx: number; vy: number } {
  if (samples.length < 2) {
    return { vx: 0, vy: 0 };
  }

  const latest = samples[samples.length - 1]!;
  let reference = samples[0]!;
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    reference = samples[i]!;
    if (latest.t - reference.t >= windowMs) {
      break;
    }
  }

  const dt = (latest.t - reference.t) / 1000;
  if (dt <= 0) {
    return { vx: 0, vy: 0 };
  }

  let vx = (latest.x - reference.x) / dt;
  let vy = (latest.y - reference.y) / dt;

  const speed = Math.hypot(vx, vy);
  if (speed > MAX_THROW_SPEED) {
    const scale = MAX_THROW_SPEED / speed;
    vx *= scale;
    vy *= scale;
  }

  return { vx, vy };
}

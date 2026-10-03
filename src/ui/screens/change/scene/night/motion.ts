// The clock the night effects share (ADR-026): uniforms the strip pulse, the
// reading path's packets and the tier 1 breathing read. Under reduced motion
// the time never advances and `still` is 1, so every effect draws its static
// form (a steady glow instead of the pulse, a path without moving packets).

export interface Motion {
  /** True under `prefers-reduced-motion`. */
  readonly reduced: boolean;
  /** Seconds, set by the render loop on each frame; stays 0 when `reduced`. */
  readonly time: { value: number };
  /** 1 under reduced motion, else 0. */
  readonly still: { value: number };
}

export function createMotion(reduced: boolean): Motion {
  return { reduced, time: { value: 0 }, still: { value: reduced ? 1 : 0 } };
}

/** The tier 1 outline's opacity at `seconds`: breathes between 0.3 and 1. */
export const breathe = (seconds: number): number => 0.65 + 0.35 * Math.sin(seconds * 1.6);

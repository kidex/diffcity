// The quality setting of the city (ADR-026, DC-90): chosen once at mount from
// a short probe of the real frame rate, never toggled afterwards. The
// fallbacks are cumulative and apply in this order: MSAA 4x -> 2x, bloom at
// quarter resolution, glass without the environment map. Pure: the stage
// applies the chosen level, tests read it back through the debug hook.

/** A level of the ladder: what the renderer is allowed to spend. */
export interface QualityLevel {
  /** 0 is full quality; each step adds one fallback. */
  level: 0 | 1 | 2 | 3;
  /** MSAA samples of the HDR target. */
  msaa: 4 | 2;
  /** Bloom resolution as a fraction of the drawing buffer: 0.5 (half, ADR-026) or 0.25. */
  bloomScale: 0.5 | 0.25;
  /** The glass reflects the environment map. */
  environment: boolean;
}

/** The ladder, best first. */
export const QUALITY_LEVELS: readonly QualityLevel[] = [
  { level: 0, msaa: 4, bloomScale: 0.5, environment: true },
  { level: 1, msaa: 2, bloomScale: 0.5, environment: true },
  { level: 2, msaa: 2, bloomScale: 0.25, environment: true },
  { level: 3, msaa: 2, bloomScale: 0.25, environment: false },
];

/** The probe measures this long, drawing every frame. */
export const PROBE_MS = 500;

/**
 * The first frames after mount pay for one-time work (the post passes' shaders
 * and render targets reach the GPU, buffers upload): they say nothing about the
 * steady frame rate. The probe draws WARMUP_FRAMES frames first, for at most
 * WARMUP_MS (a CPU renderer never gets that far), then measures PROBE_MS.
 */
export const WARMUP_FRAMES = 30;
export const WARMUP_MS = 2000;

/**
 * Median frame rate (fps) at or above which the full level is kept. Below it,
 * the first fallback applies; each further 8 fps short of it adds the next
 * one, in the ladder's order (58, 50, 42).
 */
export const TARGET_FPS = 58;
export const STEP_FPS = 8;

/** Frame intervals the probe needs to say anything: fewer means the frames are far too slow. */
export const MIN_INTERVALS = 3;

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : (((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

/** Median frame rate of frame intervals in ms; 0 when there are too few to tell. */
export function medianFps(intervals: readonly number[]): number {
  if (intervals.length < MIN_INTERVALS) return 0;
  const ms = median(intervals);
  return ms > 0 ? 1000 / ms : 0;
}

/** The level a probe's median frame rate picks. */
export function levelFor(fps: number): QualityLevel {
  if (fps >= TARGET_FPS) return QUALITY_LEVELS[0] as QualityLevel;
  const steps = 1 + Math.floor((TARGET_FPS - Math.max(0, fps) - 1e-9) / STEP_FPS);
  return QUALITY_LEVELS[Math.min(QUALITY_LEVELS.length - 1, steps)] as QualityLevel;
}

/** What the debug hook reports (read-only). */
export interface QualityState extends QualityLevel {
  /** The probe has finished and the level is final. */
  settled: boolean;
  /** Probes run since mount: never more than one. */
  probes: number;
  /** Median frame rate the probe measured, or null before it ended. */
  fps: number | null;
}

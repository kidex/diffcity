// Batched fat lines (LineSegments2): one draw call for any number of boxes'
// outlines, each segment with its own colour. Their width is in CSS pixels,
// so the materials need the viewport size on every resize.

import type { Color, InstancedInterleavedBuffer, InterleavedBufferAttribute } from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';

/** Segments per box outline. */
export const BOX_SEGMENTS = 12;

/**
 * Appends the 12 edges of an axis-aligned box (centre, half sizes) to
 * `out` as segment pairs, 6 floats per segment.
 */
export function pushBoxEdges(out: number[], cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): void {
  const x = [cx - hx, cx + hx];
  const y = [cy - hy, cy + hy];
  const z = [cz - hz, cz + hz];
  const corner = (i: number, j: number, k: number): [number, number, number] => [x[i] ?? 0, y[j] ?? 0, z[k] ?? 0];
  const edges: [[number, number, number], [number, number, number]][] = [];
  for (const j of [0, 1]) {
    for (const k of [0, 1]) edges.push([corner(0, j, k), corner(1, j, k)]);
    for (const i of [0, 1]) edges.push([corner(i, j, 0), corner(i, j, 1)]);
  }
  for (const i of [0, 1]) for (const k of [0, 1]) edges.push([corner(i, 0, k), corner(i, 1, k)]);
  for (const [a, b] of edges) out.push(...a, ...b);
}

/** Appends a flat rectangle outline at height `y` (4 segments). */
export function pushRect(out: number[], x0: number, z0: number, x1: number, z1: number, y: number): void {
  out.push(x0, y, z0, x1, y, z0, x1, y, z0, x1, y, z1, x1, y, z1, x0, y, z1, x0, y, z1, x0, y, z0);
}

/** Appends `segments` copies of `color` (start and end). */
export function pushColor(out: number[], color: Color, segments: number): void {
  for (let i = 0; i < segments; i += 1) out.push(color.r, color.g, color.b, color.r, color.g, color.b);
}

export interface FatLines {
  object: LineSegments2;
  material: LineMaterial;
  /** Rewrites the colour of segments [first, first + count) and uploads them. */
  setColor(first: number, count: number, color: Color): void;
  dispose(): void;
}

export function fatLines(positions: readonly number[], colors: readonly number[] | Color, width: number, transparent = false): FatLines {
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(positions as number[]);
  const vertexColors = !('isColor' in colors);
  if (vertexColors) geometry.setColors(colors as number[]);
  const material = new LineMaterial({
    linewidth: width,
    vertexColors,
    worldUnits: false,
    transparent,
    ...(vertexColors ? {} : { color: colors }),
  });
  const object = new LineSegments2(geometry, material);
  object.frustumCulled = false;
  return {
    object,
    material,
    setColor(first, count, color) {
      const start = geometry.getAttribute('instanceColorStart') as InterleavedBufferAttribute | undefined;
      if (start === undefined) return;
      const buffer = start.data as InstancedInterleavedBuffer;
      const array = buffer.array as Float32Array;
      for (let s = first; s < first + count; s += 1) {
        array.set([color.r, color.g, color.b, color.r, color.g, color.b], s * 6);
      }
      buffer.addUpdateRange(first * 6, count * 6);
      buffer.needsUpdate = true;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

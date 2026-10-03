// Towers (ADR-026): every building of the city in a fixed number of draw
// calls, whatever the size of the change.
//
// - Glass floors: three instanced meshes (touched, untouched, removed), one
//   instance per floor; a per-instance opacity lets a checked floor's glass
//   drop to 0.6.
// - Status strips: one instanced mesh, an LED band at the top of each floor in
//   its status colour; changed floors glow above the bloom threshold, others
//   are faint. A per-instance `aPulse` (on, phase) makes a critical floor's
//   gain run between 1.0x and 2.4x on a 1.6 s sine (DC-50); under reduced
//   motion the same floors hold 1.8x and get a halo strip (one more instanced
//   mesh, made only then).
// - Verdict outlines: one batched LineSegments2, a box outline per tower in
//   its verdict colour (full for eyes, risky and outside the spec, half for
//   reviewed-fine, neutral for untouched). Hover brightens a tower's outline,
//   a checked file halves it.
// - The selection: one more LineSegments2, violet and wider, around the
//   selected tower.
// - Removed floors: one merged dashed LineSegments skeleton in --del.
// - Beams: one instanced, camera-facing plane above the tag of eyes and risky
//   towers.
//
// The towers never decide what is dimmed, hovered, pulsing or checked:
// setPaint takes the PaintState of every building and floor (model/view.ts)
// and maps it to instance attributes: a dimmed part fades toward the scene's
// void colour, hover and selection lift the strips, hover doubles the
// outline, a checked floor's strip drops to 0.35x.
//
// The instanced buffers are laid out in place by update() while the number of
// instances stays the same (a live-update tween), and rebuilt otherwise.

import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LineDashedMaterial,
  LineSegments,
  Matrix4,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  PlaneGeometry,
  ShaderMaterial,
} from 'three';
import type { Material, WebGLProgramParametersWithUniforms } from 'three';

import type { Status } from '../../../../../core/report/types.js';
import type { City, CityBuilding } from '../../model/city.js';
import { FLOOR_H, INSET } from '../../model/city.js';
import type { PulseColor } from '../../model/critical.js';
import { phaseOf, PULSE_MAX, PULSE_MIN, PULSE_PERIOD, PULSE_STILL } from '../../model/critical.js';
import type { CityPaint, PaintState } from '../../model/view.js';
import { colorToken, statusToken, verdictColor } from '../tokens.js';
import type { FatLines } from './lines.js';
import { BOX_SEGMENTS, fatLines, pushBoxEdges, pushColor } from './lines.js';
import type { Motion } from './motion.js';

/** HDR gain of the strips: above 1 they bloom. */
const STRIP_GAIN = 1.9;
const STRIP_GAIN_QUIET = 0.35;
/** A checked floor's strip (ADR-026, DC-50). */
const CHECKED_GAIN = 0.35;
/** A checked floor's glass opacity, and the opacities of the glass it replaces. */
const CHECKED_GLASS = 0.6;
const GLASS_TOUCHED = 0.94;
const GLASS_QUIET = 0.82;
const GLASS_GHOST = 0.12;
const HOVER_LIFT = 1.6;
const SELECTED_LIFT = 1.35;
/** The strip of the floor a click or the reading panel focused. */
const FOCUS_LIFT = 2.1;
const OUTLINE_WIDTH = 1.3;
const SELECTION_WIDTH = 2.2;
/** The halo around a pulsing strip under reduced motion: how much wider than the glass, how tall, how bright. */
const HALO_GROW = 0.1;
const HALO_HEIGHT = 0.11;
const HALO_OPACITY = 0.45;
/** How far a dimmed part fades toward the void colour. */
const DIM_STRIP = 0.92;
const DIM_GLASS = 0.85;
const DIM_OUTLINE = 0.88;
/** Vertices of one removed floor's dashed box (12 edges, 2 ends). */
const SKELETON_VERTICES = BOX_SEGMENTS * 2;

const BEAM_VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    vUv = uv;
    vec3 center = vec3(0.0);
    vColor = vec3(1.0);
    #ifdef USE_INSTANCING
      center = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    #endif
    #ifdef USE_INSTANCING_COLOR
      vColor = instanceColor;
    #endif
    vec3 world = (modelMatrix * vec4(center, 1.0)).xyz;
    vec2 toCamera = normalize(cameraPosition.xz - world.xz);
    vec3 across = vec3(toCamera.y, 0.0, -toCamera.x);
    world += across * position.x + vec3(0.0, position.y, 0.0);
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

// Bright at the roof, gone at the top, soft at the sides.
const BEAM_FRAGMENT = /* glsl */ `
  uniform float uOpacity;
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    float across = 1.0 - abs(vUv.x - 0.5) * 2.0;
    float alpha = pow(across, 3.0) * (1.0 - vUv.y) * uOpacity;
    gl_FragColor = vec4(vColor * alpha, alpha);
  }
`;

export function isLoud(building: CityBuilding): boolean {
  return building.verdict === 'eyes' || building.verdict === 'risky' || building.verdict === 'spec';
}

export function hasBeam(building: CityBuilding): boolean {
  return building.verdict === 'eyes' || building.verdict === 'risky';
}

/** What the towers drew for a Report, for the debug hook: read-only. */
export interface TowersState {
  /** Strips that pulse right now (not dimmed). */
  pulsing: number;
  /** Halo strips drawn (reduced motion only). */
  halos: number;
  /** By file id: the floors whose strip pulses, the roof strip's floor among them, and the building's phase. */
  pulse: Record<string, { floors: number[]; phase: number }>;
  /** By file id: the floors drawn as checked (strip at 0.35x, glass at 0.6). */
  checked: Record<string, number[]>;
  /** By file id: the floors whose strip gain is not the status default. */
  gains: Record<string, { floor: number; gain: number }[]>;
}

export interface Towers {
  group: Group;
  lines: FatLines[];
  /** Floor instances drawn, for the debug stats. */
  floors: number;
  /** Strips that pulse right now: the loop runs continuously while any does. */
  readonly pulsing: number;
  /** Maps the paint states (by building index, then floor index) to the instances. Call it after every change of filters, hover, selection, pulse or marks. */
  setPaint(paint: CityPaint): void;
  /**
   * Lays `next` out in the existing buffers (a tween frame, a moved building).
   * Returns false, touching nothing, when it needs a different number of
   * instances: the caller then builds new towers. Call setPaint again after.
   */
  update(next: City): boolean;
  state(): TowersState;
  dispose(): void;
}

/** How many instances each mesh of the towers needs: the buffers are rebuilt only when this changes. */
interface Shape {
  buildings: number;
  touched: number;
  quiet: number;
  ghost: number;
  strips: number;
  beams: number;
}

function shapeOf(city: City): Shape {
  const shape: Shape = { buildings: city.buildings.length, touched: 0, quiet: 0, ghost: 0, strips: 0, beams: 0 };
  for (const building of city.buildings) {
    if (hasBeam(building)) shape.beams += 1;
    for (const floor of building.floors) {
      if (floor.status === 'del') shape.ghost += 1;
      else {
        shape.strips += 1;
        if (building.touched) shape.touched += 1;
        else shape.quiet += 1;
      }
    }
  }
  return shape;
}

const sameShape = (a: Shape, b: Shape): boolean =>
  a.buildings === b.buildings && a.touched === b.touched && a.quiet === b.quiet && a.ghost === b.ghost && a.strips === b.strips && a.beams === b.beams;

/** White: each instance carries its own colour, so a dimmed floor can fade without a second material; `aOpacity` scales the opacity per instance. */
function glassMaterial(opacity: number): MeshPhysicalMaterial {
  const material = new MeshPhysicalMaterial({
    color: new Color(1, 1, 1),
    metalness: 0.25,
    roughness: 0.14,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    transparent: true,
    opacity,
  });
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', 'attribute float aOpacity;\nvarying float vInstanceOpacity;\n#include <common>')
      .replace('void main() {', 'void main() {\n  vInstanceOpacity = aOpacity;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', 'varying float vInstanceOpacity;\n#include <common>')
      .replace('#include <alphamap_fragment>', '#include <alphamap_fragment>\n  diffuseColor.a *= vInstanceOpacity;');
  };
  material.customProgramCacheKey = () => 'diffcity-glass';
  return material;
}

// The strip's gain, read from the per-instance aPulse (x: pulses, y: phase).
const PULSE_GLSL = /* glsl */ `
  float pulseGain(vec2 pulse) {
    if (pulse.x < 0.5) return 1.0;
    if (uStill > 0.5) return ${PULSE_STILL.toFixed(2)};
    float wave = 0.5 + 0.5 * sin(6.28318530718 * uTime / ${PULSE_PERIOD.toFixed(2)} + pulse.y);
    return mix(${PULSE_MIN.toFixed(2)}, ${PULSE_MAX.toFixed(2)}, wave);
  }
`;

function stripMaterial(motion: Motion): MeshBasicMaterial {
  const material = new MeshBasicMaterial({ color: new Color(1, 1, 1) });
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms['uTime'] = motion.time;
    shader.uniforms['uStill'] = motion.still;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `attribute vec2 aPulse;\nuniform float uTime;\nuniform float uStill;\n#include <common>\n${PULSE_GLSL}`)
      .replace('#include <color_vertex>', '#include <color_vertex>\n  #ifdef USE_INSTANCING_COLOR\n  vColor.rgb *= pulseGain(aPulse);\n  #endif');
  };
  material.customProgramCacheKey = () => 'diffcity-strip-pulse';
  return material;
}

const PULSE_KINDS: PulseColor[] = ['eyes', 'risky', 'high'];

export function createTowers(first: City, motion: Motion): Towers {
  const group = new Group();
  const disposables: { dispose(): void }[] = [];
  const matrix = new Matrix4();
  let city = first;
  const shape = shapeOf(first);

  const instanced = (geometry: BoxGeometry, material: Material, count: number): InstancedMesh => {
    const mesh = new InstancedMesh(geometry, material, Math.max(count, 1));
    mesh.count = 0;
    disposables.push(geometry, mesh, material);
    return mesh;
  };
  /** A unit box with a per-instance attribute of `size` floats, `fill` to begin with. */
  const unitBox = (name: string, size: number, count: number, fill: number): { geometry: BoxGeometry; attribute: InstancedBufferAttribute } => {
    const geometry = new BoxGeometry(1, 1, 1);
    const attribute = new InstancedBufferAttribute(new Float32Array(Math.max(count, 1) * size).fill(fill), size);
    geometry.setAttribute(name, attribute);
    return { geometry, attribute };
  };

  // ---------- glass ----------
  const ghostGlass = glassMaterial(GLASS_GHOST);
  ghostGlass.depthWrite = false;
  const touchedBox = unitBox('aOpacity', 1, shape.touched, 1);
  const quietBox = unitBox('aOpacity', 1, shape.quiet, 1);
  const ghostBox = unitBox('aOpacity', 1, shape.ghost, 1);
  const touchedMesh = instanced(touchedBox.geometry, glassMaterial(GLASS_TOUCHED), shape.touched);
  const quietMesh = instanced(quietBox.geometry, glassMaterial(GLASS_QUIET), shape.quiet);
  const ghostMesh = instanced(ghostBox.geometry, ghostGlass, shape.ghost);
  const glassOpacity = new Map<InstancedMesh, { attribute: InstancedBufferAttribute; base: number }>([
    [touchedMesh, { attribute: touchedBox.attribute, base: GLASS_TOUCHED }],
    [quietMesh, { attribute: quietBox.attribute, base: GLASS_QUIET }],
    [ghostMesh, { attribute: ghostBox.attribute, base: GLASS_GHOST }],
  ]);
  const touchedGlass = colorToken('--c-glass');
  const quietGlass = colorToken('--c-glass-quiet');
  const voidColor = colorToken('--c-void');

  // ---------- strips ----------
  const stripBox = unitBox('aPulse', 2, shape.strips, 0);
  const stripMesh = instanced(stripBox.geometry, stripMaterial(motion), shape.strips);
  const pulseAttribute = stripBox.attribute;
  /** Per strip instance: the status colour without gain and the gain it has. */
  const stripHue: Color[] = [];
  const stripGain: number[] = [];
  /** Per strip instance: its box (x, top y, z, width, floor scale), whether it is a changed floor's, and whether it is drawn bold now. */
  const stripBoxes = new Float32Array(Math.max(shape.strips, 1) * 5);
  const stripChanged = new Uint8Array(Math.max(shape.strips, 1));
  const stripBold = new Uint8Array(Math.max(shape.strips, 1));
  /** Pulse colour kind per strip (index into PULSE_KINDS + 1), 0 when it does not pulse. */
  const stripPulse = new Uint8Array(Math.max(shape.strips, 1));
  /** Whose strip it is, and what the last paint made of it. */
  const stripOwner: { id: string; floor: number; gain: number; checked: boolean }[] = [];
  /** Per building and floor: the glass instance (mesh and index) and the strip instance, or -1 for a removed floor's strip. */
  interface Slot {
    glass: InstancedMesh;
    glassIndex: number;
    glassBase: Color;
    strip: number;
    /** Index among the removed floors, or -1. */
    ghost: number;
  }
  let slots: Slot[][] = [];
  /** Per building: the floor whose strip is the roof strip (the highest one that has a strip), or -1. */
  let roofFloor = new Int32Array(0);
  let halo: InstancedMesh | null = null;
  let pulsingNow = 0;

  // ---------- outlines, skeletons, beams ----------
  const neutral = colorToken('--line');
  const delColor = colorToken('--del').multiplyScalar(1.6);

  const beamMaterial = new ShaderMaterial({
    vertexShader: BEAM_VERTEX,
    fragmentShader: BEAM_FRAGMENT,
    uniforms: { uOpacity: { value: 0.9 } },
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  });
  const beamGeometry = new PlaneGeometry(0.5, 1.1);
  const beams = new InstancedMesh(beamGeometry, beamMaterial, Math.max(shape.beams, 1));
  beams.count = 0;
  beams.frustumCulled = false;
  disposables.push(beamMaterial, beamGeometry, beams);
  let beamOf = new Int32Array(0);
  const beamBase: Color[] = [];

  const statusColors = new Map<Status, Color>();
  const colorOf = (status: Status): Color => {
    let colour = statusColors.get(status);
    if (colour === undefined) {
      colour = colorToken(statusToken(status));
      statusColors.set(status, colour);
    }
    return colour;
  };
  const pulseColors = new Map<PulseColor, Color>();
  const pulseColorOf = (kind: PulseColor): Color => {
    let colour = pulseColors.get(kind);
    if (colour === undefined) {
      colour = kind === 'high' ? colorToken('--sev-high') : verdictColor(kind);
      pulseColors.set(kind, colour);
    }
    return colour;
  };

  // Created by the first layout, rewritten in place by every later one.
  const lines: FatLines[] = [];
  let outlines: FatLines | null = null;
  let skeleton: { positions: BufferAttribute; distances: BufferAttribute } | null = null;
  let skeletonColors: BufferAttribute | null = null;
  let outlineBase: Color[] = [];
  let painted: CityPaint | null = null;

  const selectionBox: number[] = [];
  pushBoxEdges(selectionBox, 0, 0.5, 0, 0.5, 0.5, 0.5);
  const selection = fatLines(selectionBox, colorToken('--sig').multiplyScalar(2.2), SELECTION_WIDTH);
  selection.object.visible = false;

  /** Writes strip `i`'s box: the thin band of a quiet floor, the bold one of a changed or pulsing floor. */
  const placeStrip = (i: number, bold: boolean): void => {
    const x = stripBoxes[i * 5] ?? 0;
    const top = stripBoxes[i * 5 + 1] ?? 0;
    const z = stripBoxes[i * 5 + 2] ?? 0;
    const w = stripBoxes[i * 5 + 3] ?? 1;
    const k = stripBoxes[i * 5 + 4] ?? 1;
    matrix.makeScale(w + 0.025, (bold ? 0.07 : 0.03) * k, w + 0.025).setPosition(x, top - 0.06 * k, z);
    stripMesh.setMatrixAt(i, matrix);
    stripBold[i] = bold ? 1 : 0;
  };

  /** Writes `target` into the buffers, from the first instance of each mesh. */
  const layout = (target: City): void => {
    city = target;
    for (const mesh of [touchedMesh, quietMesh, ghostMesh, stripMesh, beams]) mesh.count = 0;
    stripHue.length = 0;
    stripGain.length = 0;
    stripOwner.length = 0;
    beamBase.length = 0;
    outlineBase = [];
    slots = [];
    beamOf = new Int32Array(city.buildings.length).fill(-1);
    roofFloor = new Int32Array(city.buildings.length).fill(-1);
    const outlinePositions: number[] = [];
    const outlineColors: number[] = [];
    const delPositions: number[] = [];

    for (const building of city.buildings) {
      const w = building.side - INSET * 2;
      const buildingSlots: Slot[] = [];
      slots[building.index] = buildingSlots;
      for (const floor of building.floors) {
        const y = (floor.y0 + floor.y1) / 2;
        // A floor is FLOOR_H thick, less while its building grows or sinks (live update).
        const thick = floor.y1 - floor.y0;
        const k = thick / FLOOR_H;
        matrix.makeScale(w, thick, w).setPosition(building.x, y, building.z);
        if (floor.status === 'del') {
          ghostMesh.setMatrixAt(ghostMesh.count, matrix);
          ghostMesh.setColorAt(ghostMesh.count, touchedGlass);
          buildingSlots.push({ glass: ghostMesh, glassIndex: ghostMesh.count, glassBase: touchedGlass, strip: -1, ghost: ghostMesh.count });
          ghostMesh.count += 1;
          pushBoxEdges(delPositions, building.x, y, building.z, w / 2, thick / 2, w / 2);
          continue;
        }
        const glass = building.touched ? touchedMesh : quietMesh;
        const glassBase = building.touched ? touchedGlass : quietGlass;
        glass.setMatrixAt(glass.count, matrix);
        glass.setColorAt(glass.count, glassBase);
        const changed = floor.status !== 'same';
        const gain = changed ? STRIP_GAIN : building.touched ? STRIP_GAIN_QUIET : STRIP_GAIN_QUIET * 0.5;
        const strip = stripMesh.count;
        stripBoxes.set([building.x, floor.y1, building.z, w, k], strip * 5);
        stripChanged[strip] = changed ? 1 : 0;
        placeStrip(strip, changed);
        stripMesh.setColorAt(strip, colorOf(floor.status).clone().multiplyScalar(gain));
        stripHue.push(colorOf(floor.status));
        stripGain.push(gain);
        stripOwner.push({ id: building.id, floor: floor.index, gain, checked: false });
        roofFloor[building.index] = floor.index;
        buildingSlots.push({ glass, glassIndex: glass.count, glassBase, strip, ghost: -1 });
        glass.count += 1;
        stripMesh.count += 1;
      }

      const edge = building.touched ? verdictColor(building.verdict).multiplyScalar(isLoud(building) ? 1.3 : 0.5) : neutral.clone();
      outlineBase.push(edge);
      pushBoxEdges(outlinePositions, building.x, building.height / 2, building.z, w / 2 + 0.005, building.height / 2, w / 2 + 0.005);
      pushColor(outlineColors, edge, BOX_SEGMENTS);

      if (hasBeam(building)) {
        const colour = verdictColor(building.verdict).multiplyScalar(1.5);
        matrix.makeTranslation(building.x, building.height + 0.55, building.z);
        beams.setMatrixAt(beams.count, matrix);
        beams.setColorAt(beams.count, colour);
        beamOf[building.index] = beams.count;
        beamBase.push(colour);
        beams.count += 1;
      }
    }
    for (const mesh of [touchedMesh, quietMesh, ghostMesh, stripMesh, beams]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
      if (mesh.count > 0) mesh.computeBoundingSphere();
    }
    // The per-instance attributes start over with the paint that follows.
    stripPulse.fill(0);
    pulseAttribute.array.fill(0);
    pulseAttribute.needsUpdate = true;
    for (const { attribute } of glassOpacity.values()) {
      attribute.array.fill(1);
      attribute.needsUpdate = true;
    }

    if (outlines === null) {
      if (outlinePositions.length > 0) {
        outlines = fatLines(outlinePositions, outlineColors, OUTLINE_WIDTH);
        lines.push(outlines);
        group.add(outlines.object);
      }
    } else {
      outlines.setPositions(outlinePositions);
    }

    if (skeleton === null) {
      if (delPositions.length > 0) {
        const geometry = new BufferGeometry();
        const positions = new BufferAttribute(new Float32Array(delPositions), 3);
        const distances = new BufferAttribute(new Float32Array(delPositions.length / 3), 1);
        const colors = new BufferAttribute(new Float32Array(delPositions.length), 3);
        geometry.setAttribute('position', positions);
        geometry.setAttribute('lineDistance', distances);
        for (let i = 0; i < delPositions.length / 3; i += 1) colors.setXYZ(i, delColor.r, delColor.g, delColor.b);
        geometry.setAttribute('color', colors);
        skeletonColors = colors;
        const material = new LineDashedMaterial({ vertexColors: true, dashSize: 0.12, gapSize: 0.08 });
        group.add(new LineSegments(geometry, material));
        disposables.push(geometry, material);
        skeleton = { positions, distances };
      }
    }
    if (skeleton !== null) {
      (skeleton.positions.array as Float32Array).set(delPositions);
      skeleton.positions.needsUpdate = true;
      // What LineSegments.computeLineDistances writes, in the buffer that is already there.
      const out = skeleton.distances.array as Float32Array;
      const at = (i: number): number => delPositions[i] ?? 0;
      for (let v = 0; v + 1 < out.length; v += 2) {
        out[v] = 0;
        out[v + 1] = Math.hypot(at(v * 3 + 3) - at(v * 3), at(v * 3 + 4) - at(v * 3 + 1), at(v * 3 + 5) - at(v * 3 + 2));
      }
      skeleton.distances.needsUpdate = true;
    }
    painted = null;
  };

  for (const mesh of [touchedMesh, quietMesh, ghostMesh, stripMesh]) group.add(mesh);
  group.add(beams);
  group.add(selection.object);
  lines.push(selection);
  layout(first);
  // A mesh with no instance is left out of the draw list.
  for (const mesh of [touchedMesh, quietMesh, ghostMesh, stripMesh, beams]) mesh.visible = mesh.count > 0;

  const scratch = new Color();
  const fade = (colour: Color, amount: number): Color => scratch.copy(colour).lerp(voidColor, amount);
  const sameFloor = (a: PaintState | undefined, b: PaintState | undefined): boolean =>
    a !== undefined &&
    b !== undefined &&
    a.dimmed === b.dimmed &&
    a.hovered === b.hovered &&
    a.selected === b.selected &&
    a.focused === b.focused &&
    a.pulse === b.pulse &&
    a.pulseColor === b.pulseColor &&
    a.checked === b.checked;
  const isMarked = (state: PaintState | undefined): boolean => state?.checked === 'checked' || state?.checked === 'good' || state?.checked === 'rewrite';

  const paintBuilding = (building: CityBuilding, state: PaintState, floors: readonly PaintState[]): void => {
    const lift = state.hovered ? HOVER_LIFT : state.selected ? SELECTED_LIFT : 1;
    const touchedMeshes = new Set<InstancedMesh>();
    const buildingSlots = slots[building.index] ?? [];
    const phase = phaseOf(building.id);
    buildingSlots.forEach((slot, i) => {
      const floor = floors[i];
      const dim = floor?.dimmed ?? state.dimmed;
      const marked = isMarked(floor);
      const glass = glassOpacity.get(slot.glass);
      if (glass !== undefined && slot.strip >= 0) {
        glass.attribute.setX(slot.glassIndex, marked && !dim ? CHECKED_GLASS / glass.base : 1);
        glass.attribute.needsUpdate = true;
      }
      slot.glass.setColorAt(slot.glassIndex, dim ? fade(slot.glassBase, DIM_GLASS) : slot.glassBase);
      touchedMeshes.add(slot.glass);
      if (slot.strip >= 0) {
        const hue = stripHue[slot.strip];
        const owner = stripOwner[slot.strip];
        const pulses = !dim && (floor?.pulse === true || (state.pulse && roofFloor[building.index] === i));
        const kind = floor?.pulseColor ?? state.pulseColor;
        if (hue !== undefined && owner !== undefined) {
          let gain = stripGain[slot.strip] ?? 1;
          if (pulses) gain = STRIP_GAIN;
          else if (marked) gain = CHECKED_GAIN;
          if (dim) stripMesh.setColorAt(slot.strip, fade(scratch.copy(hue).multiplyScalar(stripGain[slot.strip] ?? 1), DIM_STRIP));
          else stripMesh.setColorAt(slot.strip, scratch.copy(pulses ? pulseColorOf(kind) : hue).multiplyScalar(gain * (floor?.focused === true ? FOCUS_LIFT : lift)));
          owner.gain = gain;
          owner.checked = marked;
        }
        pulseAttribute.setXY(slot.strip, pulses ? 1 : 0, phase);
        pulseAttribute.needsUpdate = true;
        stripPulse[slot.strip] = pulses ? PULSE_KINDS.indexOf(kind) + 1 : 0;
        const bold = stripChanged[slot.strip] === 1 || pulses;
        if ((stripBold[slot.strip] === 1) !== bold) {
          placeStrip(slot.strip, bold);
          stripMesh.instanceMatrix.needsUpdate = true;
        }
        touchedMeshes.add(stripMesh);
      } else if (skeletonColors !== null) {
        const colour = dim ? fade(delColor, DIM_STRIP) : delColor;
        for (let v = slot.ghost * SKELETON_VERTICES; v < (slot.ghost + 1) * SKELETON_VERTICES; v += 1) skeletonColors.setXYZ(v, colour.r, colour.g, colour.b);
        skeletonColors.needsUpdate = true;
      }
    });
    for (const mesh of touchedMeshes) if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    const base = outlineBase[building.index];
    if (outlines !== null && base !== undefined) {
      const half = state.checked === 'checked' || state.checked === 'good' ? 0.5 : 1;
      outlines.setColor(
        building.index * BOX_SEGMENTS,
        BOX_SEGMENTS,
        state.dimmed ? fade(base, DIM_OUTLINE) : scratch.copy(base).multiplyScalar((state.hovered ? 2 : 1) * half),
      );
    }
    const beam = beamOf[building.index] ?? -1;
    const beamColour = beamBase[beam];
    if (beam >= 0 && beamColour !== undefined) {
      beams.setColorAt(beam, state.dimmed ? scratch.setRGB(0, 0, 0) : beamColour);
      if (beams.instanceColor !== null) beams.instanceColor.needsUpdate = true;
    }
  };

  /** Under reduced motion: one halo strip around every strip that holds the static glow. */
  const refreshHalo = (): void => {
    let count = 0;
    for (let i = 0; i < stripMesh.count; i += 1) if ((stripPulse[i] ?? 0) > 0) count += 1;
    if (count === 0 && halo === null) return;
    if (halo === null) {
      const geometry = new BoxGeometry(1, 1, 1);
      const material = new MeshBasicMaterial({ color: new Color(1, 1, 1), transparent: true, opacity: HALO_OPACITY, blending: AdditiveBlending, depthWrite: false });
      halo = new InstancedMesh(geometry, material, Math.max(stripMesh.count, 1));
      halo.frustumCulled = false;
      group.add(halo);
      disposables.push(geometry, material, halo);
    }
    halo.count = 0;
    for (let i = 0; i < stripMesh.count; i += 1) {
      const kind = stripPulse[i] ?? 0;
      if (kind === 0) continue;
      const k = stripBoxes[i * 5 + 4] ?? 1;
      const w = (stripBoxes[i * 5 + 3] ?? 1) + 0.025 + HALO_GROW;
      matrix.makeScale(w, HALO_HEIGHT * k, w).setPosition(stripBoxes[i * 5] ?? 0, (stripBoxes[i * 5 + 1] ?? 0) - 0.06 * k, stripBoxes[i * 5 + 2] ?? 0);
      halo.setMatrixAt(halo.count, matrix);
      halo.setColorAt(halo.count, pulseColorOf(PULSE_KINDS[kind - 1] ?? 'high').clone().multiplyScalar(PULSE_STILL));
      halo.count += 1;
    }
    halo.instanceMatrix.needsUpdate = true;
    if (halo.instanceColor !== null) halo.instanceColor.needsUpdate = true;
    halo.visible = halo.count > 0;
  };

  const select = (building: CityBuilding | null): void => {
    if (building === null) {
      selection.object.visible = false;
      return;
    }
    const w = building.side - INSET * 2 + 0.06;
    selection.object.scale.set(w, building.height + 0.04, w);
    selection.object.position.set(building.x, -0.02, building.z);
    selection.object.visible = true;
  };

  return {
    group,
    lines,
    floors: shape.touched + shape.quiet + shape.ghost,
    get pulsing() {
      return pulsingNow;
    },
    setPaint(paint) {
      let selected: CityBuilding | null = null;
      for (const building of city.buildings) {
        const state = paint.buildings[building.index];
        if (state === undefined) continue;
        if (state.selected) selected = building;
        const before = painted?.buildings[building.index];
        const floorsNow = paint.floors[building.index] ?? [];
        const floorsBefore = painted?.floors[building.index];
        const same = sameFloor(before, state) && floorsNow.every((floor, i) => sameFloor(floorsBefore?.[i], floor));
        if (!same) paintBuilding(building, state, floorsNow);
      }
      painted = paint;
      select(selected);
      pulsingNow = 0;
      for (let i = 0; i < stripMesh.count; i += 1) if ((stripPulse[i] ?? 0) > 0) pulsingNow += 1;
      if (motion.reduced) refreshHalo();
    },
    update(next) {
      if (!sameShape(shape, shapeOf(next))) return false;
      layout(next);
      return true;
    },
    state() {
      const pulse: TowersState['pulse'] = {};
      const checked: TowersState['checked'] = {};
      const gains: TowersState['gains'] = {};
      stripOwner.forEach((owner, i) => {
        if ((stripPulse[i] ?? 0) > 0) (pulse[owner.id] ??= { floors: [], phase: phaseOf(owner.id) }).floors.push(owner.floor);
        if (owner.checked) (checked[owner.id] ??= []).push(owner.floor);
        if (owner.gain !== stripGain[i]) (gains[owner.id] ??= []).push({ floor: owner.floor, gain: owner.gain });
      });
      return { pulsing: pulsingNow, halos: halo?.count ?? 0, pulse, checked, gains };
    },
    dispose() {
      for (const item of disposables) item.dispose();
      for (const fat of lines) fat.dispose();
    },
  };
}

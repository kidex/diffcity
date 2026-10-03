// Towers (ADR-026): every building of the city in a fixed number of draw
// calls, whatever the size of the change.
//
// - Glass floors: three instanced meshes (touched, untouched, removed), one
//   instance per floor.
// - Status strips: one instanced mesh, an LED band at the top of each floor in
//   its status colour; changed floors glow above the bloom threshold, others
//   are faint.
// - Verdict outlines: one batched LineSegments2, a box outline per tower in
//   its verdict colour (full for eyes, risky and outside the spec, half for
//   reviewed-fine, neutral for untouched). Hover brightens a tower's outline.
// - The selection: one more LineSegments2, violet and wider, around the
//   selected tower.
// - Removed floors: one merged dashed LineSegments skeleton in --del.
// - Beams: one instanced, camera-facing plane under the tag of eyes and
//   risky towers.
//
// The towers never decide what is dimmed, hovered or selected: setPaint takes
// the PaintState of every building and floor (model/view.ts) and maps it to
// instance colours: a dimmed part fades toward the scene's void colour (the
// glass cannot change its opacity per instance), hover and selection lift the
// strips, hover doubles the outline.

import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedMesh,
  LineDashedMaterial,
  LineSegments,
  Matrix4,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  PlaneGeometry,
  ShaderMaterial,
} from 'three';
import type { Material } from 'three';

import type { Status } from '../../../../../core/report/types.js';
import type { City, CityBuilding } from '../../model/city.js';
import { FLOOR_H, INSET } from '../../model/city.js';
import type { CityPaint, PaintState } from '../../model/view.js';
import { colorToken, statusToken, verdictColor } from '../tokens.js';
import type { FatLines } from './lines.js';
import { BOX_SEGMENTS, fatLines, pushBoxEdges, pushColor } from './lines.js';

/** HDR gain of the strips: above 1 they bloom. */
const STRIP_GAIN = 1.9;
const STRIP_GAIN_QUIET = 0.35;
const HOVER_LIFT = 1.6;
const SELECTED_LIFT = 1.35;
const OUTLINE_WIDTH = 1.3;
const SELECTION_WIDTH = 2.2;
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

export interface Towers {
  group: Group;
  lines: FatLines[];
  /** Floor instances drawn, for the debug stats. */
  floors: number;
  /** Maps the paint states (by building index, then floor index) to the instances. Call it after every change of filters, hover or selection. */
  setPaint(paint: CityPaint): void;
  dispose(): void;
}

/** White: each instance carries its own colour, so a dimmed floor can fade without a second material. */
function glassMaterial(opacity: number): MeshPhysicalMaterial {
  return new MeshPhysicalMaterial({
    color: new Color(1, 1, 1),
    metalness: 0.25,
    roughness: 0.14,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    transparent: true,
    opacity,
  });
}

export function createTowers(city: City): Towers {
  const group = new Group();
  const disposables: { dispose(): void }[] = [];
  const unitBox = new BoxGeometry(1, 1, 1);
  disposables.push(unitBox);
  const matrix = new Matrix4();

  let touchedCount = 0;
  let quietCount = 0;
  let ghostCount = 0;
  let stripCount = 0;
  for (const building of city.buildings) {
    for (const floor of building.floors) {
      if (floor.status === 'del') ghostCount += 1;
      else {
        stripCount += 1;
        if (building.touched) touchedCount += 1;
        else quietCount += 1;
      }
    }
  }
  const instanced = (material: Material, count: number): InstancedMesh => {
    const mesh = new InstancedMesh(unitBox, material, Math.max(count, 1));
    mesh.count = 0;
    disposables.push(mesh, material);
    return mesh;
  };

  // ---------- glass ----------
  const ghostGlass = glassMaterial(0.12);
  ghostGlass.depthWrite = false;
  const touchedMesh = instanced(glassMaterial(0.94), touchedCount);
  const quietMesh = instanced(glassMaterial(0.82), quietCount);
  const ghostMesh = instanced(ghostGlass, ghostCount);
  const touchedGlass = colorToken('--c-glass');
  const quietGlass = colorToken('--c-glass-quiet');
  const voidColor = colorToken('--c-void');

  // ---------- strips ----------
  const stripMesh = instanced(new MeshBasicMaterial({ color: new Color(1, 1, 1) }), stripCount);
  /** First strip instance of each building, its count, and the strips' base colours. */
  const stripFirst = new Int32Array(city.buildings.length);
  const stripTotal = new Int32Array(city.buildings.length);
  const stripBase: Color[] = [];
  /** Per building and floor: the glass instance (mesh and index) and the strip instance, or -1 for a removed floor's strip. */
  interface Slot {
    glass: InstancedMesh;
    glassIndex: number;
    glassBase: Color;
    strip: number;
    /** Index among the removed floors, or -1. */
    ghost: number;
  }
  const slots: Slot[][] = [];

  // ---------- outlines, skeletons, beams ----------
  const outlinePositions: number[] = [];
  const outlineColors: number[] = [];
  const outlineBase: Color[] = [];
  const delPositions: number[] = [];
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
  const beams = new InstancedMesh(beamGeometry, beamMaterial, Math.max(city.buildings.filter(hasBeam).length, 1));
  beams.count = 0;
  beams.frustumCulled = false;
  disposables.push(beamMaterial, beamGeometry, beams);
  const beamOf = new Int32Array(city.buildings.length).fill(-1);
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

  for (const building of city.buildings) {
    const w = building.side - INSET * 2;
    stripFirst[building.index] = stripMesh.count;
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
      const colour = colorOf(floor.status).clone().multiplyScalar(gain);
      matrix.makeScale(w + 0.025, (changed ? 0.07 : 0.03) * k, w + 0.025).setPosition(building.x, floor.y1 - 0.06 * k, building.z);
      stripMesh.setMatrixAt(stripMesh.count, matrix);
      stripMesh.setColorAt(stripMesh.count, colour);
      stripBase.push(colour);
      buildingSlots.push({ glass, glassIndex: glass.count, glassBase, strip: stripMesh.count, ghost: -1 });
      glass.count += 1;
      stripMesh.count += 1;
    }
    stripTotal[building.index] = stripMesh.count - (stripFirst[building.index] ?? 0);

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
  for (const mesh of [touchedMesh, quietMesh, ghostMesh, stripMesh]) {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    if (mesh.count === 0) continue;
    mesh.computeBoundingSphere();
    group.add(mesh);
  }
  if (beams.count > 0) group.add(beams);

  const lines: FatLines[] = [];
  let outlines: FatLines | null = null;
  if (outlinePositions.length > 0) {
    outlines = fatLines(outlinePositions, outlineColors, OUTLINE_WIDTH);
    lines.push(outlines);
    group.add(outlines.object);
  }
  const selectionBox: number[] = [];
  pushBoxEdges(selectionBox, 0, 0.5, 0, 0.5, 0.5, 0.5);
  const selection = fatLines(selectionBox, colorToken('--sig').multiplyScalar(2.2), SELECTION_WIDTH);
  selection.object.visible = false;
  lines.push(selection);
  group.add(selection.object);

  let skeletonColors: BufferAttribute | null = null;
  if (delPositions.length > 0) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(delPositions), 3));
    skeletonColors = new BufferAttribute(new Float32Array(delPositions.length), 3);
    for (let i = 0; i < delPositions.length / 3; i += 1) skeletonColors.setXYZ(i, delColor.r, delColor.g, delColor.b);
    geometry.setAttribute('color', skeletonColors);
    const material = new LineDashedMaterial({ vertexColors: true, dashSize: 0.12, gapSize: 0.08 });
    const skeleton = new LineSegments(geometry, material);
    skeleton.computeLineDistances();
    disposables.push(geometry, material);
    group.add(skeleton);
  }

  const scratch = new Color();
  const fade = (colour: Color, amount: number): Color => scratch.copy(colour).lerp(voidColor, amount);
  const sameState = (a: PaintState | undefined, b: PaintState | undefined): boolean =>
    a !== undefined && b !== undefined && a.dimmed === b.dimmed && a.hovered === b.hovered && a.selected === b.selected;

  const paintBuilding = (building: CityBuilding, state: PaintState, floors: readonly PaintState[]): void => {
    const lift = state.hovered ? HOVER_LIFT : state.selected ? SELECTED_LIFT : 1;
    const touchedMeshes = new Set<InstancedMesh>();
    const buildingSlots = slots[building.index] ?? [];
    buildingSlots.forEach((slot, i) => {
      const dim = floors[i]?.dimmed ?? state.dimmed;
      slot.glass.setColorAt(slot.glassIndex, dim ? fade(slot.glassBase, DIM_GLASS) : slot.glassBase);
      touchedMeshes.add(slot.glass);
      if (slot.strip >= 0) {
        const base = stripBase[slot.strip];
        if (base !== undefined) stripMesh.setColorAt(slot.strip, dim ? fade(base, DIM_STRIP) : scratch.copy(base).multiplyScalar(lift));
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
      outlines.setColor(building.index * BOX_SEGMENTS, BOX_SEGMENTS, state.dimmed ? fade(base, DIM_OUTLINE) : scratch.copy(base).multiplyScalar(state.hovered ? 2 : 1));
    }
    const beam = beamOf[building.index] ?? -1;
    const beamColour = beamBase[beam];
    if (beam >= 0 && beamColour !== undefined) {
      beams.setColorAt(beam, state.dimmed ? scratch.setRGB(0, 0, 0) : beamColour);
      if (beams.instanceColor !== null) beams.instanceColor.needsUpdate = true;
    }
  };

  let painted: CityPaint | null = null;
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
    floors: touchedMesh.count + quietMesh.count + ghostMesh.count,
    setPaint(paint) {
      let selection: CityBuilding | null = null;
      for (const building of city.buildings) {
        const state = paint.buildings[building.index];
        if (state === undefined) continue;
        if (state.selected) selection = building;
        const before = painted?.buildings[building.index];
        const floorsNow = paint.floors[building.index] ?? [];
        const floorsBefore = painted?.floors[building.index];
        const same = sameState(before, state) && floorsNow.every((floor, i) => floor.dimmed === floorsBefore?.[i]?.dimmed);
        if (!same) paintBuilding(building, state, floorsNow);
      }
      painted = paint;
      select(selection);
    },
    dispose() {
      for (const item of disposables) item.dispose();
      for (const fat of lines) fat.dispose();
    },
  };
}

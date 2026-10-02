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
  setHover(id: string | null): void;
  setSelected(id: string | null): void;
  dispose(): void;
}

function glassMaterial(colour: Color, opacity: number): MeshPhysicalMaterial {
  return new MeshPhysicalMaterial({
    color: colour,
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
  const ghostGlass = glassMaterial(colorToken('--c-glass'), 0.12);
  ghostGlass.depthWrite = false;
  const touchedMesh = instanced(glassMaterial(colorToken('--c-glass'), 0.94), touchedCount);
  const quietMesh = instanced(glassMaterial(colorToken('--c-glass-quiet'), 0.82), quietCount);
  const ghostMesh = instanced(ghostGlass, ghostCount);

  // ---------- strips ----------
  const stripMesh = instanced(new MeshBasicMaterial({ color: new Color(1, 1, 1) }), stripCount);
  /** First strip instance of each building, its count, and the strips' base colours. */
  const stripFirst = new Int32Array(city.buildings.length);
  const stripTotal = new Int32Array(city.buildings.length);
  const stripBase: Color[] = [];

  // ---------- outlines, skeletons, beams ----------
  const outlinePositions: number[] = [];
  const outlineColors: number[] = [];
  const outlineBase: Color[] = [];
  const delPositions: number[] = [];
  const neutral = colorToken('--line');

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
    for (const floor of building.floors) {
      const y = (floor.y0 + floor.y1) / 2;
      matrix.makeScale(w, FLOOR_H, w).setPosition(building.x, y, building.z);
      if (floor.status === 'del') {
        ghostMesh.setMatrixAt(ghostMesh.count, matrix);
        ghostMesh.count += 1;
        pushBoxEdges(delPositions, building.x, y, building.z, w / 2, FLOOR_H / 2, w / 2);
        continue;
      }
      const glass = building.touched ? touchedMesh : quietMesh;
      glass.setMatrixAt(glass.count, matrix);
      glass.count += 1;
      const changed = floor.status !== 'same';
      const gain = changed ? STRIP_GAIN : building.touched ? STRIP_GAIN_QUIET : STRIP_GAIN_QUIET * 0.5;
      const colour = colorOf(floor.status).clone().multiplyScalar(gain);
      matrix.makeScale(w + 0.025, changed ? 0.07 : 0.03, w + 0.025).setPosition(building.x, floor.y1 - 0.06, building.z);
      stripMesh.setMatrixAt(stripMesh.count, matrix);
      stripMesh.setColorAt(stripMesh.count, colour);
      stripBase.push(colour);
      stripMesh.count += 1;
    }
    stripTotal[building.index] = stripMesh.count - (stripFirst[building.index] ?? 0);

    const edge = building.touched ? verdictColor(building.verdict).multiplyScalar(isLoud(building) ? 1.3 : 0.5) : neutral.clone();
    outlineBase.push(edge);
    pushBoxEdges(outlinePositions, building.x, building.height / 2, building.z, w / 2 + 0.005, building.height / 2, w / 2 + 0.005);
    pushColor(outlineColors, edge, BOX_SEGMENTS);

    if (hasBeam(building)) {
      matrix.makeTranslation(building.x, building.height + 0.55, building.z);
      beams.setMatrixAt(beams.count, matrix);
      beams.setColorAt(beams.count, verdictColor(building.verdict).multiplyScalar(1.5));
      beams.count += 1;
    }
  }
  for (const mesh of [touchedMesh, quietMesh, ghostMesh, stripMesh]) {
    mesh.instanceMatrix.needsUpdate = true;
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

  if (delPositions.length > 0) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(delPositions), 3));
    const material = new LineDashedMaterial({ color: colorToken('--del').multiplyScalar(1.6), dashSize: 0.12, gapSize: 0.08 });
    const skeleton = new LineSegments(geometry, material);
    skeleton.computeLineDistances();
    disposables.push(geometry, material);
    group.add(skeleton);
  }

  let hovered: CityBuilding | null = null;
  let selected: CityBuilding | null = null;
  const scratch = new Color();
  const paint = (building: CityBuilding): void => {
    const lift = building === hovered ? HOVER_LIFT : building === selected ? SELECTED_LIFT : 1;
    const first = stripFirst[building.index] ?? 0;
    const total = stripTotal[building.index] ?? 0;
    for (let i = first; i < first + total; i += 1) {
      const base = stripBase[i];
      if (base !== undefined) stripMesh.setColorAt(i, scratch.copy(base).multiplyScalar(lift));
    }
    if (stripMesh.instanceColor !== null && total > 0) {
      stripMesh.instanceColor.addUpdateRange(first * 3, total * 3);
      stripMesh.instanceColor.needsUpdate = true;
    }
    const base = outlineBase[building.index];
    if (outlines !== null && base !== undefined) {
      outlines.setColor(building.index * BOX_SEGMENTS, BOX_SEGMENTS, scratch.copy(base).multiplyScalar(building === hovered ? 2 : 1));
    }
  };

  return {
    group,
    lines,
    floors: touchedMesh.count + quietMesh.count + ghostMesh.count,
    setHover(id) {
      const next = id === null ? null : (city.byId.get(id) ?? null);
      if (next === hovered) return;
      const previous = hovered;
      hovered = next;
      if (previous !== null) paint(previous);
      if (next !== null) paint(next);
    },
    setSelected(id) {
      const next = id === null ? null : (city.byId.get(id) ?? null);
      const previous = selected;
      selected = next;
      if (previous !== null) paint(previous);
      if (next === null) {
        selection.object.visible = false;
        return;
      }
      paint(next);
      const w = next.side - INSET * 2 + 0.06;
      selection.object.scale.set(w, next.height + 0.04, w);
      selection.object.position.set(next.x, -0.02, next.z);
      selection.object.visible = true;
    },
    dispose() {
      for (const item of disposables) item.dispose();
      for (const fat of lines) fat.dispose();
    },
  };
}

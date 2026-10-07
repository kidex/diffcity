// Markers (ADR-026, DC-52, DC-50): one instanced mesh per shape, whatever the
// number of findings or marks.
//
// - Pins: a stem and a bead on the roof, one per finding, sized and coloured by
//   severity (`--sev-*`). A finding whose source starts with `rule:` is an X
//   instead.
// - X markers: two crossed bars in the severity colour, standing on the front
//   face of the floor of the finding's symbol, or lying on the roof when it has
//   none. Change-level findings get no marker (model/markers.ts).
// - Check marks: on the roof of a fully checked file.
// - Needs-rewrite markers: a `--del` notch on the front face of a floor marked
//   for rewrite, and a plate on the roof of the file.
//
// Where findings go comes from the model; which marks are drawn comes from the
// PaintState (model/view.ts); an outdated mark draws nothing. The
// meshes follow the city they are given, so they move with a live-update
// tween; their buffers grow when a mark needs more instances than they have.

import type { BufferGeometry} from 'three';
import { BoxGeometry, Color, Group, InstancedMesh, Matrix4, MeshBasicMaterial, Quaternion, SphereGeometry, Vector3 } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import type { Finding } from '../../../../../core/report/types.js';
import type { City, CityBuilding } from '../../model/city.js';
import { FLOOR_H, INSET } from '../../model/city.js';
import type { FindingMarker } from '../../model/markers.js';
import type { CityPaint } from '../../model/view.js';
import { colorToken } from '../tokens.js';

export type MarkerKind = 'pin' | 'x' | 'check' | 'rewrite' | 'notch';

/** One marker as drawn, for the debug hook. */
export interface MarkerInfo {
  kind: MarkerKind;
  /** The building's file id. */
  file: string;
  /** The floor it is on; null on the roof. */
  floor: number | null;
  severity: Finding['severity'] | null;
  x: number;
  y: number;
  z: number;
  dimmed: boolean;
}

export interface Markers {
  group: Group;
  /** Follows the buildings of `city` (a tween frame); drawn again by the next setPaint. */
  update(city: City): void;
  /** The finding markers of a new Report of the same city; drawn again by the next setPaint. */
  setPlan(plan: readonly FindingMarker[]): void;
  /** Draws the markers for the paint of the city given to update. */
  setPaint(paint: CityPaint): void;
  list(): MarkerInfo[];
  dispose(): void;
}

const PIN_GAIN: Record<Finding['severity'], number> = { high: 3, med: 1.8, low: 1.8 };
const PIN_SCALE: Record<Finding['severity'], number> = { high: 1.3, med: 1, low: 0.8 };
const X_GAIN = 2.4;
const CHECK_GAIN = 2;
const REWRITE_GAIN = 1.6;
const DIM = 0.88;
/** Spacing of the markers sharing a roof or a floor face. */
const SLOT = 0.3;
const FACE_GAP = 0.02;

const bar = (length: number, thick: number, depth: number, x: number, y: number, angle: number): BoxGeometry => {
  const geometry = new BoxGeometry(length, thick, depth);
  geometry.rotateZ(angle);
  geometry.translate(x, y, 0);
  return geometry;
};

function merged(parts: BufferGeometry[]): BufferGeometry {
  const geometry = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  return geometry;
}

/** A growing instanced mesh for one marker shape. */
class Shape {
  mesh: InstancedMesh;
  constructor(
    private readonly geometry: BufferGeometry,
    private readonly material: MeshBasicMaterial,
    private readonly group: Group,
  ) {
    this.mesh = this.make(8);
  }

  private make(capacity: number): InstancedMesh {
    const mesh = new InstancedMesh(this.geometry, this.material, capacity);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.visible = false;
    this.group.add(mesh);
    return mesh;
  }

  /** Room for `count` instances; a bigger mesh replaces the old one. */
  reserve(count: number): void {
    if (count <= this.mesh.instanceMatrix.count) return;
    this.group.remove(this.mesh);
    this.mesh.dispose();
    this.mesh = this.make(Math.max(count, this.mesh.instanceMatrix.count * 2));
  }

  dispose(): void {
    this.group.remove(this.mesh);
    this.mesh.dispose();
  }
}

export function createMarkers(first: readonly FindingMarker[], firstCity: City): Markers {
  let plan = first;
  const group = new Group();
  const material = new MeshBasicMaterial({ color: new Color(1, 1, 1) });

  const pinGeometry = merged([new BoxGeometry(0.012, 0.5, 0.012).translate(0, 0.25, 0), new SphereGeometry(0.075, 16, 12).translate(0, 0.52, 0)]);
  const xGeometry = merged([bar(0.3, 0.05, 0.02, 0, 0, Math.PI / 4), bar(0.3, 0.05, 0.02, 0, 0, -Math.PI / 4)]);
  // A tick: a short arm down to the right, a long one up to the right.
  const checkGeometry = merged([bar(0.134, 0.05, 0.02, -0.095, -0.05, -0.84), bar(0.319, 0.05, 0.02, 0.055, 0.02, 0.85)]);
  const plateGeometry = new BoxGeometry(1, 1, 1);
  const pins = new Shape(pinGeometry, material, group);
  const crosses = new Shape(xGeometry, material, group);
  const checks = new Shape(checkGeometry, material, group);
  const plates = new Shape(plateGeometry, material, group);
  const shapes: Record<MarkerKind, Shape> = { pin: pins, x: crosses, check: checks, rewrite: plates, notch: plates };

  const severity = { high: colorToken('--sev-high'), med: colorToken('--sev-med'), low: colorToken('--sev-low') };
  const ok = colorToken('--verdict-ok');
  const del = colorToken('--del');
  const voidColor = colorToken('--c-void');

  let city = firstCity;
  let listed: MarkerInfo[] = [];
  const flat = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
  const identity = new Quaternion();
  const one = new Vector3(1, 1, 1);
  const scale = new Vector3();
  const position = new Vector3();

  interface Entry {
    kind: MarkerKind;
    info: MarkerInfo;
    matrix: Matrix4;
    color: Color;
  }

  const entryAt = (
    kind: MarkerKind,
    building: CityBuilding,
    floor: number | null,
    sev: Finding['severity'] | null,
    at: { x: number; y: number; z: number },
    turn: Quaternion,
    size: Vector3,
    color: Color,
    dimmed: boolean,
  ): Entry => {
    position.set(at.x, at.y, at.z);
    return {
      kind,
      info: { kind, file: building.id, floor, severity: sev, x: at.x, y: at.y, z: at.z, dimmed },
      matrix: new Matrix4().compose(position, turn, size),
      color: dimmed ? color.clone().lerp(voidColor, DIM) : color,
    };
  };

  /** Where slot `n` of a roof or a face goes: along the front-right edge, wrapping to the next row back. */
  const spot = (building: CityBuilding, n: number): { across: number; back: number } => {
    const half = building.side / 2 - INSET;
    const columns = Math.max(1, Math.floor((half * 2 - 0.1) / SLOT));
    return { across: half - 0.14 - (n % columns) * SLOT, back: Math.floor(n / columns) * SLOT };
  };

  let paint: CityPaint | null = null;
  const refresh = (): void => {
    const entries: Entry[] = [];
    for (const marker of plan) {
      const building = city.byId.get(marker.file);
      if (building === undefined) continue;
      const dimmed = paint?.buildings[building.index]?.dimmed ?? false;
      const half = building.side / 2 - INSET;
      const { across, back } = spot(building, marker.slot);
      if (marker.kind === 'pin') {
        const s = PIN_SCALE[marker.severity];
        entries.push(
          entryAt('pin', building, null, marker.severity, { x: building.x + across, y: building.height, z: building.z + half - 0.14 - back }, identity, scale.set(s, s, s), severity[marker.severity].clone().multiplyScalar(PIN_GAIN[marker.severity]), dimmed),
        );
        continue;
      }
      const color = severity[marker.severity].clone().multiplyScalar(X_GAIN);
      const floor = marker.floor === null ? undefined : building.floors[marker.floor];
      if (floor === undefined) {
        entries.push(entryAt('x', building, null, marker.severity, { x: building.x + across, y: building.height + 0.03, z: building.z + half - 0.14 - back }, flat, one, color, dimmed));
      } else {
        const s = Math.max(0.001, Math.min(1, (floor.y1 - floor.y0) / FLOOR_H));
        entries.push(entryAt('x', building, marker.floor, marker.severity, { x: building.x + across, y: (floor.y0 + floor.y1) / 2, z: building.z + half + FACE_GAP }, identity, scale.set(s, s, s), color, dimmed));
      }
    }
    if (paint !== null) {
      for (const building of city.buildings) {
        const state = paint.buildings[building.index];
        if (state === undefined) continue;
        const half = building.side / 2 - INSET;
        if (state.checked === 'checked' || state.checked === 'good') {
          entries.push(entryAt('check', building, null, null, { x: building.x, y: building.height + 0.3, z: building.z }, identity, one, ok.clone().multiplyScalar(CHECK_GAIN), state.dimmed));
        } else if (state.checked === 'rewrite') {
          entries.push(entryAt('rewrite', building, null, null, { x: building.x, y: building.height + 0.05, z: building.z }, identity, scale.set(0.34, 0.05, 0.34), del.clone().multiplyScalar(REWRITE_GAIN), state.dimmed));
        }
        building.floors.forEach((floor, i) => {
          const floorState = paint?.floors[building.index]?.[i];
          if (floorState?.checked !== 'rewrite') return;
          const k = Math.max(0.001, Math.min(1, (floor.y1 - floor.y0) / FLOOR_H));
          entries.push(
            entryAt('notch', building, i, null, { x: building.x, y: (floor.y0 + floor.y1) / 2, z: building.z + half + FACE_GAP }, identity, scale.set(0.22, 0.2 * k, 0.05), del.clone().multiplyScalar(REWRITE_GAIN), floorState.dimmed),
          );
        });
      }
    }

    const wanted = new Map<Shape, Entry[]>();
    for (const shape of new Set(Object.values(shapes))) wanted.set(shape, []);
    for (const entry of entries) wanted.get(shapes[entry.kind])?.push(entry);
    for (const [shape, list] of wanted) {
      shape.reserve(list.length);
      const { mesh } = shape;
      list.forEach((entry, i) => {
        mesh.setMatrixAt(i, entry.matrix);
        mesh.setColorAt(i, entry.color);
      });
      mesh.count = list.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
      mesh.visible = list.length > 0;
    }
    listed = entries.map((entry) => entry.info);
  };

  return {
    group,
    update(next) {
      city = next;
    },
    setPlan(next) {
      plan = next;
    },
    setPaint(next) {
      paint = next;
      refresh();
    },
    list: () => listed.map((info) => ({ ...info })),
    dispose() {
      for (const shape of new Set(Object.values(shapes))) shape.dispose();
      pinGeometry.dispose();
      xGeometry.dispose();
      checkGeometry.dispose();
      plateGeometry.dispose();
      material.dispose();
    },
  };
}

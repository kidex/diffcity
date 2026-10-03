// The reading path (ADR-026, SPEC.md section 6): the Report's steps as a tube
// of light through the buildings, in step order, with bright packets running
// along it, and a numbered ring on the ground at every stop. Drawn only when
// the Report has steps. One tube (one draw), the rings in one instanced mesh,
// the stop numbers in one mesh over a canvas atlas drawn at 4x. Under reduced
// motion the packets do not move: the tube holds a steady glow.
//
// The path is built for one city and not rebuilt per frame: while buildings
// tween it is hidden, and it comes back at their final place.

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  DoubleSide,
  Group,
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  RingGeometry,
  ShaderMaterial,
  SRGBColorSpace,
  TubeGeometry,
  Vector3,
} from 'three';
import type { WebGLRenderer } from 'three';

import { readToken } from '../../../../shared/tokens.js';
import type { PathStop } from '../../model/path.js';
import { pathPoints } from '../../model/path.js';
import { colorToken } from '../tokens.js';
import type { Motion } from './motion.js';

/** Height of the tube above the ground. */
const TUBE_Y = 0.06;
const TUBE_RADIUS = 0.03;
const RING_INNER = 0.22;
const RING_OUTER = 0.27;
const RING_Y = 0.02;
/** The number's quad, and the atlas cell it comes from (4x the CSS size of the number). */
const NUMBER_SIZE = 0.34;
const CELL = 128;
const ATLAS_COLUMNS = 8;

const TUBE_VERTEX = /* glsl */ `
  varying float vAlong;
  void main() {
    vAlong = uv.x;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// A dim base line with bright packets moving from the first stop to the last;
// a steady glow when reduced motion holds the clock.
const TUBE_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uStill;
  uniform float uLength;
  varying float vAlong;
  void main() {
    float d = vAlong * uLength;
    float packet = fract(d / 2.4 - uTime * 0.55);
    float head = smoothstep(0.78, 0.98, packet) * (1.0 - smoothstep(0.98, 1.0, packet));
    float intensity = uStill > 0.5 ? 1.1 : 0.55 + head * 3.2;
    gl_FragColor = vec4(uColor * intensity, 1.0);
  }
`;

export interface Path {
  group: Group;
  /** Packets run along the tube: the loop renders continuously while this is true. */
  readonly animated: boolean;
  setVisible(visible: boolean): void;
  /** What is drawn, for the debug hook. */
  state(): { stops: number[]; tube: boolean; animated: boolean };
  dispose(): void;
}

/** Stop numbers in one canvas, a cell each, drawn at 4x. */
function numberAtlas(stops: readonly PathStop[]): { canvas: HTMLCanvasElement; rows: number } {
  const columns = Math.min(stops.length, ATLAS_COLUMNS);
  const rows = Math.ceil(stops.length / columns);
  const canvas = document.createElement('canvas');
  canvas.width = columns * CELL;
  canvas.height = rows * CELL;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2D canvas unavailable');
  ctx.font = `600 ${String(CELL * 0.62)}px ${readToken('--mono')}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = readToken('--ink');
  stops.forEach((stop, i) => {
    ctx.fillText(String(stop.order), (i % columns) * CELL + CELL / 2, Math.floor(i / columns) * CELL + CELL / 2);
  });
  return { canvas, rows };
}

/** The ring's centre: at the building's front-left corner, side by side for stops on the same building. */
function ringAt(stop: PathStop): Vector3 {
  const offset = stop.building.side / 2 + 0.05;
  return new Vector3(stop.building.x - offset + stop.nth * 0.6, RING_Y, stop.building.z + offset);
}

export function createPath(stops: readonly PathStop[], motion: Motion, renderer: WebGLRenderer): Path | null {
  if (stops.length === 0) return null;
  const group = new Group();
  const disposables: { dispose(): void }[] = [];
  const sig = colorToken('--sig');

  // The tube needs two places to run between.
  let tube = false;
  const places = pathPoints(stops);
  if (places.length >= 2) {
    const curve = new CatmullRomCurve3(
      places.map((building) => new Vector3(building.x, TUBE_Y, building.z)),
      false,
      'centripetal',
      0.5,
    );
    const geometry = new TubeGeometry(curve, Math.min(320, Math.max(32, places.length * 48)), TUBE_RADIUS, 8, false);
    const material = new ShaderMaterial({
      vertexShader: TUBE_VERTEX,
      fragmentShader: TUBE_FRAGMENT,
      uniforms: { uColor: { value: sig }, uTime: motion.time, uStill: motion.still, uLength: { value: curve.getLength() } },
    });
    group.add(new Mesh(geometry, material));
    disposables.push(geometry, material);
    tube = true;
  }

  // Rings.
  const ringGeometry = new RingGeometry(RING_INNER, RING_OUTER, 48);
  const ringMaterial = new MeshBasicMaterial({ color: sig.clone().multiplyScalar(2), side: DoubleSide });
  const rings = new InstancedMesh(ringGeometry, ringMaterial, stops.length);
  const flat = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
  const matrix = new Matrix4();
  const one = new Vector3(1, 1, 1);
  stops.forEach((stop, i) => {
    rings.setMatrixAt(i, matrix.compose(ringAt(stop), flat, one));
  });
  rings.frustumCulled = false;
  group.add(rings);
  disposables.push(ringGeometry, ringMaterial, rings);

  // Numbers, lying on the ground inside the rings; the text's top is towards -z, as the lot names.
  const { canvas, rows } = numberAtlas(stops);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const columns = Math.min(stops.length, ATLAS_COLUMNS);
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const half = NUMBER_SIZE / 2;
  stops.forEach((stop, i) => {
    const at = ringAt(stop);
    const y = RING_Y + 0.005;
    positions.push(at.x - half, y, at.z - half, at.x + half, y, at.z - half, at.x - half, y, at.z + half, at.x + half, y, at.z + half);
    const u0 = (i % columns) / columns;
    const u1 = u0 + 1 / columns;
    const v0 = 1 - Math.floor(i / columns) / rows;
    const v1 = v0 - 1 / rows;
    uvs.push(u0, v0, u1, v0, u0, v1, u1, v1);
    const base = i * 4;
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  });
  const numberGeometry = new BufferGeometry();
  numberGeometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  numberGeometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  numberGeometry.setIndex(indices);
  const numberMaterial = new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false });
  const numbers = new Mesh(numberGeometry, numberMaterial);
  numbers.renderOrder = 2;
  group.add(numbers);
  disposables.push(numberGeometry, numberMaterial, texture);

  const animated = tube && !motion.reduced;
  return {
    group,
    animated,
    setVisible(visible) {
      group.visible = visible;
    },
    state: () => ({ stops: stops.map((stop) => stop.order), tube, animated }),
    dispose() {
      for (const item of disposables) item.dispose();
    },
  };
}

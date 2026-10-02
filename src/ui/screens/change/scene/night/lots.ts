// Lots (ADR-026): a dark plate per package (one instanced mesh), its outline
// (one batched fat-line draw for the ordinary lots, one for tier 1 lots in
// --tier), a static outer ring around tier 1 lots, and the package names
// lying on the ground, drawn into one texture atlas so every name is the same
// single draw call.

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  Group,
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  SRGBColorSpace,
} from 'three';
import type { WebGLRenderer } from 'three';

import { readToken } from '../../../../shared/tokens.js';
import type { City, CityLot } from '../../model/city.js';
import { colorToken } from '../tokens.js';
import type { FatLines } from './lines.js';
import { fatLines, pushBoxEdges, pushRect } from './lines.js';

const PLATE_H = 0.08;
/** Height of a lot name's em box, in world units. */
const NAME_SIZE = 0.28;
const NAME_INSET_X = 0.3;
const NAME_INSET_Z = 0.34;
const ATLAS_WIDTH = 4096;
const ATLAS_MAX_HEIGHT = 4096;

export function lotName(lot: CityLot): string {
  return `${lot.pkg.path}${lot.tier1 ? '   tier 1' : ''}`;
}

interface AtlasCell {
  lot: CityLot;
  x: number;
  y: number;
  w: number;
}

/** Draws every lot name into one canvas; the font shrinks until the atlas fits. */
function drawAtlas(lots: readonly CityLot[]): { canvas: HTMLCanvasElement; cells: AtlasCell[]; px: number; cellH: number; pad: number } {
  const family = readToken('--mono');
  const probe = document.createElement('canvas').getContext('2d');
  if (probe === null) throw new Error('2D canvas unavailable');
  let px = 64;
  for (;;) {
    probe.font = `500 ${String(px)}px ${family}`;
    const pad = Math.ceil(px * 0.3);
    const cellH = Math.ceil(px * 1.4);
    const cells: AtlasCell[] = [];
    let x = 0;
    let y = 0;
    for (const lot of lots) {
      const w = Math.min(ATLAS_WIDTH, Math.ceil(probe.measureText(lotName(lot)).width) + pad * 2);
      if (x + w > ATLAS_WIDTH) {
        x = 0;
        y += cellH;
      }
      cells.push({ lot, x, y, w });
      x += w;
    }
    const height = y + cellH;
    if (height <= ATLAS_MAX_HEIGHT || px <= 12) {
      const canvas = document.createElement('canvas');
      canvas.width = ATLAS_WIDTH;
      canvas.height = Math.min(ATLAS_MAX_HEIGHT, 2 ** Math.ceil(Math.log2(Math.max(height, 1))));
      const ctx = canvas.getContext('2d');
      if (ctx === null) throw new Error('2D canvas unavailable');
      ctx.font = probe.font;
      ctx.textBaseline = 'middle';
      const tier = readToken('--tier');
      const muted = readToken('--muted');
      for (const cell of cells) {
        ctx.fillStyle = cell.lot.tier1 ? tier : muted;
        ctx.fillText(lotName(cell.lot), cell.x + pad, cell.y + cellH / 2, cell.w - pad * 2);
      }
      return { canvas, cells, px, cellH, pad };
    }
    px = Math.floor(px * 0.8);
  }
}

function namesMesh(city: City, renderer: WebGLRenderer): { mesh: Mesh; dispose(): void } {
  const { canvas, cells, px, cellH, pad } = drawAtlas(city.lots);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  cells.forEach((cell, i) => {
    const { lot } = cell;
    let scale = NAME_SIZE / px;
    const room = lot.x1 - lot.x0 - NAME_INSET_X * 2;
    if ((cell.w - pad * 2) * scale > room) scale = room / (cell.w - pad * 2);
    const left = lot.x0 + NAME_INSET_X - pad * scale;
    const right = left + cell.w * scale;
    const zc = lot.z1 - NAME_INSET_Z;
    const half = (cellH * scale) / 2;
    const y = 0.003;
    // Text top towards -z, read from the home camera.
    positions.push(left, y, zc - half, right, y, zc - half, left, y, zc + half, right, y, zc + half);
    const u0 = cell.x / canvas.width;
    const u1 = (cell.x + cell.w) / canvas.width;
    const v0 = 1 - cell.y / canvas.height;
    const v1 = 1 - (cell.y + cellH) / canvas.height;
    uvs.push(u0, v0, u1, v0, u0, v1, u1, v1);
    const base = i * 4;
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  const material = new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false });
  const mesh = new Mesh(geometry, material);
  mesh.renderOrder = 1;
  return {
    mesh,
    dispose() {
      geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}

export interface Lots {
  group: Group;
  lines: FatLines[];
  dispose(): void;
}

export function createLots(city: City, renderer: WebGLRenderer): Lots {
  const group = new Group();
  const plateGeometry = new BoxGeometry(1, PLATE_H, 1);
  const plateMaterial = new MeshPhysicalMaterial({ color: colorToken('--c-lot'), roughness: 0.55, metalness: 0.2 });
  const plates = new InstancedMesh(plateGeometry, plateMaterial, Math.max(city.lots.length, 1));
  plates.count = city.lots.length;
  const matrix = new Matrix4();
  const plain: number[] = [];
  const tier: number[] = [];
  const ring: number[] = [];
  city.lots.forEach((lot, i) => {
    const w = lot.x1 - lot.x0;
    const d = lot.z1 - lot.z0;
    const cx = lot.x0 + w / 2;
    const cz = lot.z0 + d / 2;
    matrix.makeScale(w, 1, d).setPosition(cx, -PLATE_H / 2, cz);
    plates.setMatrixAt(i, matrix);
    pushBoxEdges(lot.tier1 ? tier : plain, cx, -PLATE_H / 2, cz, w / 2, PLATE_H / 2, d / 2);
    if (lot.tier1) pushRect(ring, lot.x0 - 0.15, lot.z0 - 0.15, lot.x1 + 0.15, lot.z1 + 0.15, 0.001);
  });
  plates.computeBoundingSphere();
  group.add(plates);

  const lines: FatLines[] = [];
  if (plain.length > 0) lines.push(fatLines(plain, colorToken('--plot-line'), 1));
  if (tier.length > 0) {
    lines.push(fatLines(tier, colorToken('--tier').multiplyScalar(1.8), 1.8));
    lines.push(fatLines(ring, colorToken('--tier').multiplyScalar(1.2), 1));
  }
  for (const line of lines) group.add(line.object);

  const names = namesMesh(city, renderer);
  group.add(names.mesh);

  return {
    group,
    lines,
    dispose() {
      plateGeometry.dispose();
      plateMaterial.dispose();
      plates.dispose();
      for (const line of lines) line.dispose();
      names.dispose();
    },
  };
}

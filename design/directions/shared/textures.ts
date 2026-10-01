// Canvas-drawn textures: crisp flat text for lot labels, soft blobs for
// contact shadows and halos. Text is drawn at four times its display size and
// sampled with anisotropic filtering, so it stays sharp at grazing angles.

import {
  CanvasTexture,
  DoubleSide,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
} from 'three';
import type { Texture, WebGLRenderer } from 'three';

const TEXT_SCALE = 4;

function canvas2d(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2D canvas unavailable');
  return { canvas, ctx };
}

function finish(canvas: HTMLCanvasElement, renderer: WebGLRenderer, srgb: boolean): CanvasTexture {
  const texture = new CanvasTexture(canvas);
  if (srgb) texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return texture;
}

export interface FlatTextOptions {
  weight: number;
  /** CSS font family list. */
  family: string;
  color: string;
  /** Height of the em box in world units. */
  size: number;
  /** Letter spacing in em. */
  letterSpacing?: number;
  anchor?: 'left' | 'center';
  opacity?: number;
}

const MAX_TEXTURE_WIDTH = 4096;

/** Text lying flat on the ground (rotated plane), anchored at its left or centre. */
export function flatText(text: string, options: FlatTextOptions, renderer: WebGLRenderer): Mesh {
  const probe = canvas2d(1, 1).ctx;
  const measure = (px: number): number => {
    probe.font = `${String(options.weight)} ${String(px)}px ${options.family}`;
    probe.letterSpacing = `${String((options.letterSpacing ?? 0) * px)}px`;
    return probe.measureText(text).width;
  };
  let px = 40 * TEXT_SCALE;
  const fits = MAX_TEXTURE_WIDTH / (measure(px) + px * 0.8);
  if (fits < 1) px = Math.floor(px * fits);
  const fontSpec = `${String(options.weight)} ${String(px)}px ${options.family}`;
  const pad = px * 0.4;
  const width = measure(px) + pad * 2;
  const height = px * 1.4;
  const { canvas, ctx } = canvas2d(width, height);
  ctx.font = fontSpec;
  ctx.letterSpacing = probe.letterSpacing;
  ctx.fillStyle = options.color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, pad, height / 2);
  const texture = finish(canvas, renderer, true);
  const worldPerPx = options.size / px;
  const geometry = new PlaneGeometry(canvas.width * worldPerPx, canvas.height * worldPerPx);
  if (options.anchor !== 'center') geometry.translate((canvas.width * worldPerPx) / 2 - pad * worldPerPx, 0, 0);
  const material = new MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    opacity: options.opacity ?? 1,
    side: DoubleSide,
    toneMapped: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

/**
 * A soft rounded-square blob, white on transparent: tint it with the material
 * colour. `softness` is the blur radius as a fraction of the texture size.
 */
export function softSquare(renderer: WebGLRenderer, softness = 0.12, corner = 0.12): Texture {
  const size = 256;
  const { canvas, ctx } = canvas2d(size, size);
  const blur = size * softness;
  const inset = blur * 1.6;
  ctx.filter = `blur(${String(blur)}px)`;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.roundRect(inset, inset, size - inset * 2, size - inset * 2, size * corner);
  ctx.fill();
  return finish(canvas, renderer, false);
}

/** A radial ring or disc, white on transparent, for halos on the ground. */
export function radialHalo(renderer: WebGLRenderer, stops: readonly [number, number][]): Texture {
  const size = 256;
  const { canvas, ctx } = canvas2d(size, size);
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [at, alpha] of stops) gradient.addColorStop(at, `rgba(255,255,255,${String(alpha)})`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return finish(canvas, renderer, false);
}

/** A vertical gradient for the scene background, between two CSS colours. */
export function verticalGradient(renderer: WebGLRenderer, top: string, bottom: string): Texture {
  const { canvas, ctx } = canvas2d(4, 512);
  const gradient = ctx.createLinearGradient(0, 0, 0, 512);
  gradient.addColorStop(0, top);
  gradient.addColorStop(1, bottom);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 4, 512);
  return finish(canvas, renderer, true);
}

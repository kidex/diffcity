// Small building blocks the three scenes share: a multisampled HDR composer,
// the reading-path curve, roof labels, finding-pin positions and the light
// rig's shadow frustum fitted to the city.

import { CatmullRomCurve3, HalfFloatType, Shape, ShapeGeometry, Vector2, Vector3, WebGLRenderTarget } from 'three';
import type { Camera, DirectionalLight, Scene, WebGLRenderer } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';

import type { City, CityBuilding } from './city.js';
import { VERDICT_LABEL } from './city.js';
import { h } from './labels.js';
import { verdictToken } from './tokens.js';

/** An HDR (half float), 4x multisampled composer that starts with a RenderPass. */
export function hdrComposer(renderer: WebGLRenderer, scene: Scene, camera: Camera): EffectComposer {
  const size = renderer.getDrawingBufferSize(new Vector2());
  const target = new WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), { type: HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  return composer;
}

/** A smooth curve through the reading-path stops, at height `y`. */
export function pathCurve(city: City, y: number): CatmullRomCurve3 | null {
  if (city.path.length < 2) return null;
  const points = city.path.map((stop) => new Vector3(stop.building.x, y, stop.building.z));
  return new CatmullRomCurve3(points, false, 'centripetal', 0.5);
}

/**
 * The label above a touched building: the verdict badge over the file name.
 * Each direction styles `.roof`, `.badge` and `.file` in its own CSS.
 */
export function roofLabel(building: CityBuilding): HTMLElement {
  const badge = h('div', 'badge', h('i', ''), h('span', '', VERDICT_LABEL[building.verdict]));
  const root = h('div', `roof v-${building.verdict}${building.tier1 ? ' tier1' : ''}`, badge, h('div', 'file', building.name));
  root.style.setProperty('--c', `var(${verdictToken(building.verdict)})`);
  return root;
}

/** Roof positions for the finding pins: along the front-right roof edge. */
export function pinSpots(building: CityBuilding, inset: number): Vector3[] {
  const half = building.side / 2 - inset;
  return building.findings.map((_, i) => new Vector3(building.x + half - 0.14 - i * 0.3, building.height, building.z + half - 0.14));
}

/** Fits a directional light's shadow camera around the whole city. */
export function fitShadow(light: DirectionalLight, city: City, mapSize = 2048): void {
  const { bounds } = city;
  const half = bounds.span * 0.75;
  light.castShadow = true;
  light.shadow.mapSize.set(mapSize, mapSize);
  const shadowCamera = light.shadow.camera;
  shadowCamera.left = -half;
  shadowCamera.right = half;
  shadowCamera.top = half;
  shadowCamera.bottom = -half;
  shadowCamera.near = 1;
  shadowCamera.far = bounds.span * 4;
  shadowCamera.updateProjectionMatrix();
  light.target.position.set(bounds.cx, 0, bounds.cz);
  light.target.updateMatrixWorld();
}

/** A flat rounded-rectangle outline (frame) of the given outer size and stroke. */
export function frameShape(width: number, depth: number, stroke: number, radius: number): ShapeGeometry {
  const rounded = (w: number, d: number, r: number): Shape => {
    const shape = new Shape();
    const x = -w / 2;
    const y = -d / 2;
    shape.moveTo(x + r, y);
    shape.lineTo(x + w - r, y);
    shape.quadraticCurveTo(x + w, y, x + w, y + r);
    shape.lineTo(x + w, y + d - r);
    shape.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
    shape.lineTo(x + r, y + d);
    shape.quadraticCurveTo(x, y + d, x, y + d - r);
    shape.lineTo(x, y + r);
    shape.quadraticCurveTo(x, y, x + r, y);
    return shape;
  };
  const outer = rounded(width, depth, radius);
  outer.holes.push(rounded(width - stroke * 2, depth - stroke * 2, Math.max(0.01, radius - stroke)));
  const geometry = new ShapeGeometry(outer, 6);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}


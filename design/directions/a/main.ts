// Direction A, "Glass & light": acrylic towers in a soft studio. Every floor
// is a slab of clear glass with a glowing inner band in its status colour;
// untouched files are frosted and unlit. Eyes and risky buildings carry a
// roof beacon that blooms softly.

import './style.css';

import type {
  Color,
  ShapeGeometry} from 'three';
import {
  ACESFilmicToneMapping,
  BoxGeometry,
  CylinderGeometry,
  DirectionalLight,
  EdgesGeometry,
  Group,
  HemisphereLight,
  LineDashedMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PCFShadowMap,
  PlaneGeometry,
  PMREMGenerator,
  ShadowMaterial,
  Sprite,
  SpriteMaterial,
  SphereGeometry,
  TubeGeometry,
  Vector3,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

import type { CityBuilding, CityLot, Status } from '../shared/city.js';
import { FLOOR_H } from '../shared/city.js';
import { fitShadow, frameShape, pathCurve, pinSpots, roofLabel } from '../shared/kit.js';
import { h } from '../shared/labels.js';
import type { DirectionContext, DirectionScene, PaintState } from '../shared/stage.js';
import { startDirection } from '../shared/stage.js';
import { colorToken, cssToken, severityToken, statusToken, verdictToken } from '../shared/tokens.js';
import { flatText, radialHalo, softSquare, verticalGradient } from '../shared/textures.js';

const INSET = 0.16;
/** Inner band glow: a touched floor, and one in an eyes or risky building (blooms). */
const GLOW = 1.15;
const GLOW_ALERT = 3.4;

interface FloorParts {
  status: Status;
  glass: Mesh<RoundedBoxGeometry, MeshPhysicalMaterial> | null;
  band: Mesh<RoundedBoxGeometry | BoxGeometry, MeshStandardMaterial | MeshBasicMaterial>;
  ghost: LineSegments<EdgesGeometry, LineDashedMaterial> | null;
  glow: number;
}

interface BuildingParts {
  floors: FloorParts[];
  frame: Mesh<ShapeGeometry, MeshBasicMaterial>;
  extras: Mesh<CylinderGeometry | SphereGeometry, MeshStandardMaterial | MeshBasicMaterial>[];
  beacon: Mesh<CylinderGeometry, MeshStandardMaterial> | null;
  halos: Sprite[];
}

function build({ city, scene, camera, renderer, labels }: DirectionContext): DirectionScene {
  const { bounds } = city;

  // ---------- studio ----------
  scene.background = verticalGradient(renderer, cssToken('--a-sky-top'), cssToken('--a-sky-bottom'));
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.6;
  pmrem.dispose();

  scene.add(new HemisphereLight(colorToken('--a-sky-top'), colorToken('--a-ground'), 0.9));
  const sun = new DirectionalLight(colorToken('--a-sun'), 2.6);
  sun.position.set(bounds.cx - bounds.span * 0.45, bounds.span * 1.1, bounds.cz + bounds.span * 0.35);
  fitShadow(sun, city);
  sun.shadow.radius = 7;
  sun.shadow.blurSamples = 16;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);
  // The city does not move: draw the shadow map once, not every frame.
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;

  const ground = new Mesh(new PlaneGeometry(bounds.span * 8, bounds.span * 8), new ShadowMaterial({ color: colorToken('--a-shadow'), opacity: 0.16 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(bounds.cx, -0.16, bounds.cz);
  ground.receiveShadow = true;
  scene.add(ground);

  const contact = softSquare(renderer, 0.11, 0.16);
  const white = colorToken('--a-sky-top');
  const glowTexture = radialHalo(renderer, [[0, 1], [0.25, 0.45], [0.6, 0.08], [1, 0]]);
  const shadowColor = colorToken('--a-shadow');

  // ---------- lots ----------
  const lotMaterial = new MeshPhysicalMaterial({
    color: colorToken('--a-lot'),
    roughness: 0.42,
    clearcoat: 0.7,
    clearcoatRoughness: 0.25,
  });
  const addLot = (lot: CityLot): void => {
    const w = lot.x1 - lot.x0;
    const d = lot.z1 - lot.z0;
    const slab = new Mesh(new RoundedBoxGeometry(w, 0.16, d, 4, 0.08), lotMaterial);
    slab.position.set(lot.x0 + w / 2, -0.08, lot.z0 + d / 2);
    slab.receiveShadow = true;
    slab.castShadow = true;
    scene.add(slab);
    // A soft shadow under the slab so it floats a little above the studio floor.
    const under = new Mesh(new PlaneGeometry(w * 1.12, d * 1.16), new MeshBasicMaterial({ map: contact, color: shadowColor, transparent: true, opacity: 0.22, depthWrite: false }));
    under.rotation.x = -Math.PI / 2;
    under.position.set(slab.position.x, -0.159, slab.position.z + 0.08);
    scene.add(under);
    if (lot.tier1) {
      const inlay = new Mesh(
        frameShape(w - 0.22, d - 0.22, 0.05, 0.12),
        new MeshBasicMaterial({ color: colorToken('--tier').multiplyScalar(1.6), toneMapped: false }),
      );
      inlay.position.set(slab.position.x, 0.003, slab.position.z);
      scene.add(inlay);
    }
    const label = flatText(
      `${lot.pkg.path}${lot.tier1 ? '   tier 1' : ''}`,
      { weight: 500, family: cssToken('--mono'), color: cssToken(lot.tier1 ? '--tier' : '--a-lot-ink'), size: 0.3, anchor: 'left' },
      renderer,
    );
    label.position.set(lot.x0 + 0.3, 0.004, lot.z1 - 0.36);
    scene.add(label);
  };
  city.lots.forEach(addLot);

  // ---------- buildings ----------
  const pickables: Mesh[] = [];
  const parts = new Map<string, BuildingParts>();
  const clear = (touched: boolean): MeshPhysicalMaterial =>
    new MeshPhysicalMaterial({
      color: colorToken(touched ? '--a-glass' : '--a-frost'),
      transmission: 1,
      thickness: 0.7,
      roughness: touched ? 0.06 : 0.42,
      ior: 1.48,
      clearcoat: 1,
      clearcoatRoughness: 0.04,
      specularIntensity: 1,
      iridescence: touched ? 0.35 : 0,
      iridescenceIOR: 1.25,
      dispersion: touched ? 0.4 : 0,
      attenuationColor: colorToken('--a-attenuation'),
      attenuationDistance: 3.5,
      transparent: true,
    });

  const addBuilding = (building: CityBuilding): void => {
    const group = new Group();
    const w = building.side - INSET * 2;
    const alert = building.verdict === 'eyes' || building.verdict === 'risky';
    const floors: FloorParts[] = [];
    for (const floor of building.floors) {
      const y = (floor.y0 + floor.y1) / 2;
      if (floor.status === 'del') {
        const ghostBox = new BoxGeometry(w, FLOOR_H, w);
        const ghost = new LineSegments(new EdgesGeometry(ghostBox), new LineDashedMaterial({ color: colorToken('--del'), dashSize: 0.14, gapSize: 0.09, transparent: true }));
        ghost.computeLineDistances();
        ghost.position.set(building.x, y, building.z);
        const band = new Mesh(new BoxGeometry(w * 0.82, FLOOR_H * 0.3, w * 0.82), new MeshBasicMaterial({ color: colorToken('--del'), transparent: true, opacity: 0.2, depthWrite: false }));
        band.position.copy(ghost.position);
        const hit = new Mesh(ghostBox, new MeshBasicMaterial({ visible: false }));
        hit.position.copy(ghost.position);
        hit.userData = { building: building.id, floor: floor.index };
        group.add(ghost, band, hit);
        pickables.push(hit);
        floors.push({ status: floor.status, glass: null, band, ghost, glow: 0 });
        continue;
      }
      const glass = new Mesh(new RoundedBoxGeometry(w, FLOOR_H, w, 3, 0.07), clear(building.touched));
      glass.position.set(building.x, y, building.z);
      glass.castShadow = true;
      glass.receiveShadow = true;
      glass.userData = { building: building.id, floor: floor.index };
      const changed = floor.status !== 'same';
      const bandColor = colorToken(changed ? statusToken(floor.status) : building.touched ? '--a-core' : '--a-core-quiet');
      const glow = changed ? (alert ? GLOW_ALERT : GLOW) : 0;
      // Unlit and outside tone mapping: the band shows the token colour as is.
      const band = new Mesh(
        new RoundedBoxGeometry(w - 0.26, FLOOR_H * (changed ? 0.44 : 0.22), w - 0.26, 2, 0.04),
        new MeshBasicMaterial({ color: bandColor, toneMapped: false }),
      );
      band.userData['color'] = bandColor.clone();
      band.position.copy(glass.position);
      group.add(glass, band);
      pickables.push(glass);
      floors.push({ status: floor.status, glass, band, ghost: null, glow });
    }

    // Contact shadow: a soft dark square hugging the footprint.
    const blob = new Mesh(
      new PlaneGeometry(building.side * 1.35, building.side * 1.35),
      new MeshBasicMaterial({ map: contact, color: shadowColor, transparent: true, opacity: building.touched ? 0.42 : 0.28, depthWrite: false }),
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.set(building.x, 0.002, building.z);
    group.add(blob);

    // Selection frame on the lot, in the selection colour.
    const frame = new Mesh(frameShape(building.side + 0.1, building.side + 0.1, 0.06, 0.16), new MeshBasicMaterial({ color: colorToken('--sig').multiplyScalar(1.4), toneMapped: false, transparent: true }));
    frame.position.set(building.x, 0.004, building.z);
    frame.visible = false;
    group.add(frame);

    const extras: BuildingParts['extras'] = [];
    let beacon: BuildingParts['beacon'] = null;
    const halos: Sprite[] = [];
    if (building.touched) {
      const top = building.height;
      if (alert) {
        const color = colorToken(verdictToken(building.verdict));
        beacon = new Mesh(new CylinderGeometry(0.16, 0.16, 0.05, 32), new MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 5 }));
        beacon.position.set(building.x - w / 2 + 0.3, top + 0.03, building.z - w / 2 + 0.3);
        group.add(beacon);
        // Bloom, but only where it means something: an additive glow around
        // the beacon and around the building's changed floors.
        const glowAt = (x: number, y: number, z: number, size: number, opacity: number): void => {
          const halo = new Sprite(new SpriteMaterial({ map: glowTexture, color, transparent: true, opacity, depthWrite: false }));
          halo.scale.set(size, size, 1);
          halo.position.set(x, y, z);
          halo.userData['base'] = opacity;
          group.add(halo);
          halos.push(halo);
        };
        glowAt(beacon.position.x, beacon.position.y + 0.05, beacon.position.z, 1.1, 0.55);
        for (const floor of building.floors) {
          if (floor.status !== 'same' && floor.status !== 'del') glowAt(building.x, (floor.y0 + floor.y1) / 2, building.z, building.side * 2.1, 0.16);
        }
      }
      labels.add(group, roofLabel(building), new Vector3(building.x, top + 0.22, building.z), { building: building.id, center: [0.5, 1], occlude: true });
      pinSpots(building, INSET).forEach((spot, i) => {
        const finding = building.findings[i];
        if (finding === undefined) return;
        const color = colorToken(severityToken(finding.severity));
        const stem = new Mesh(new CylinderGeometry(0.014, 0.014, 0.5, 8), new MeshBasicMaterial({ color: colorToken('--a-stem'), transparent: true }));
        stem.position.set(spot.x, spot.y + 0.25, spot.z);
        const head = new Mesh(
          new SphereGeometry(finding.severity === 'high' ? 0.1 : 0.08, 24, 16),
          new MeshStandardMaterial({ color, emissive: color, emissiveIntensity: finding.severity === 'high' ? 2.2 : 1.1, roughness: 0.2, transparent: true }),
        );
        head.position.set(spot.x, spot.y + 0.52, spot.z);
        group.add(stem, head);
        extras.push(stem, head);
      });
    }
    parts.set(building.id, { floors, frame, extras, beacon, halos });
    scene.add(group);
  };
  city.buildings.forEach(addBuilding);

  // ---------- reading path: a thin luminous thread with numbered stops ----------
  const curve = pathCurve(city, 0.05);
  if (curve !== null) {
    const thread = new Mesh(
      new TubeGeometry(curve, 240, 0.028, 8, false),
      new MeshStandardMaterial({ color: colorToken('--sig'), emissive: colorToken('--sig'), emissiveIntensity: 1.3, roughness: 0.3 }),
    );
    scene.add(thread);
    for (const stop of city.path) {
      const disc = new Mesh(
        new CylinderGeometry(0.26, 0.26, 0.05, 40),
        new MeshPhysicalMaterial({ color: colorToken('--sig'), emissive: colorToken('--sig'), emissiveIntensity: 0.6, roughness: 0.2, clearcoat: 1 }),
      );
      const offset = stop.building.side / 2 + 0.05;
      disc.position.set(stop.building.x - offset, 0.03, stop.building.z + offset);
      scene.add(disc);
      labels.add(scene, h('div', 'stop', String(stop.order)), disc.position.clone().setY(0.06));
    }
  }

  // No composer: rendering straight to the canvas keeps the sRGB background
  // and the unlit status bands out of tone mapping, so they match the tokens.

  return {
    pickables,
    animated: false,
    paint(building: CityBuilding, state: PaintState) {
      const p = parts.get(building.id);
      if (p === undefined) return;
      const lift = state.hovered ? 1.35 : state.selected ? 1.2 : 1;
      for (const floor of p.floors) {
        const dim = state.dimmed || (state.type !== null && floor.status !== state.type);
        if (floor.glass !== null) {
          floor.glass.material.opacity = dim ? 0.28 : 1;
          floor.glass.material.roughness = dim ? 0.5 : building.touched ? 0.06 : 0.42;
          floor.band.visible = !dim;
          const base = floor.band.userData['color'] as Color;
          floor.band.material.color.copy(base).lerp(white, floor.glow > 0 ? lift - 1 : 0);
        } else {
          floor.band.material.opacity = dim ? 0.04 : 0.2;
          if (floor.ghost !== null) floor.ghost.material.opacity = dim ? 0.15 : 1;
        }
      }
      p.frame.visible = state.selected || state.hovered;
      p.frame.material.opacity = state.selected ? 1 : 0.45;
      for (const extra of p.extras) {
        extra.material.opacity = state.dimmed ? 0.15 : 1;
      }
      if (p.beacon !== null) p.beacon.visible = !state.dimmed;
      for (const halo of p.halos) halo.material.opacity = state.dimmed ? 0 : (halo.userData['base'] as number) * (state.hovered ? 1.4 : 1);
    },
    render() {
      renderer.render(scene, camera);
    },
    setSize() {
      // The stage resizes the renderer and the camera.
    },
  };
}

void startDirection({
  id: 'a',
  name: 'Glass & light',
  tagline: 'Acrylic towers in a studio: every floor glows with its change.',
  toneMapping: ACESFilmicToneMapping,
  exposure: 1.0,
  shadows: PCFShadowMap,
  build,
});

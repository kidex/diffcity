// Direction B, "Architectural model": a matte clay maquette on a paper board.
// Everything is white except what matters: changed floors are painted slabs
// in their status colour, verdicts are halos on the board, and the labels are
// thin annotations on leader lines. Ambient occlusion and soft shadows carry
// the form; a gentle depth of field gives the scale-model feel.

import './style.css';

import {
  ACESFilmicToneMapping,
  BoxGeometry,
  CylinderGeometry,
  DirectionalLight,
  EdgesGeometry,
  Fog,
  Group,
  HemisphereLight,
  LineDashedMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SphereGeometry,
  TubeGeometry,
  Vector3,
  VSMShadowMap,
} from 'three';
import type { Color, ShapeGeometry } from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import type { CityBuilding, CityLot, Status } from '../shared/city.js';
import { FLOOR_GAP, FLOOR_H } from '../shared/city.js';
import { fitShadow, frameShape, hdrComposer, pathCurve, pinSpots, roofLabel } from '../shared/kit.js';
import { h } from '../shared/labels.js';
import type { DirectionContext, DirectionScene, PaintState } from '../shared/stage.js';
import { startDirection } from '../shared/stage.js';
import { colorToken, cssToken, severityToken, statusToken, verdictToken } from '../shared/tokens.js';
import { flatText, radialHalo } from '../shared/textures.js';

const INSET = 0.2;
const BOARD = 0.22;

interface FloorParts {
  status: Status;
  mesh: Mesh<RoundedBoxGeometry | BoxGeometry, MeshStandardMaterial>;
  ghost: LineSegments<EdgesGeometry, LineDashedMaterial> | null;
  base: Color;
}

interface BuildingParts {
  floors: FloorParts[];
  halo: Mesh<PlaneGeometry, MeshBasicMaterial> | null;
  haloOpacity: number;
  outline: Mesh<ShapeGeometry, MeshBasicMaterial>;
  pins: Mesh<CylinderGeometry | SphereGeometry, MeshStandardMaterial>[];
}

/** How loudly each verdict speaks on the board. */
const HALO_OPACITY: Record<string, number> = { eyes: 0.95, risky: 0.95, spec: 0.75, ok: 0.4, same: 0 };

function build({ city, scene, camera, renderer, labels, target }: DirectionContext): DirectionScene {
  const { bounds } = city;
  const paper = colorToken('--b-paper');
  scene.background = paper;
  scene.fog = new Fog(paper, bounds.span * 1.6, bounds.span * 4.2);

  // ---------- light: a big soft window and a bright sky ----------
  scene.add(new HemisphereLight(colorToken('--b-sky'), colorToken('--b-bounce'), 1.7));
  const sun = new DirectionalLight(colorToken('--b-sun'), 2.3);
  sun.position.set(bounds.cx - bounds.span * 0.55, bounds.span * 1.05, bounds.cz - bounds.span * 0.1);
  fitShadow(sun, city, 2048);
  sun.shadow.radius = 9;
  sun.shadow.blurSamples = 20;
  sun.shadow.bias = -0.0006;
  scene.add(sun, sun.target);
  // The city does not move: draw the shadow map once, not every frame.
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;

  // ---------- table and board ----------
  const table = new Mesh(new PlaneGeometry(bounds.span * 10, bounds.span * 10), new MeshStandardMaterial({ color: paper, roughness: 1 }));
  table.rotation.x = -Math.PI / 2;
  table.position.set(bounds.cx, -BOARD, bounds.cz);
  table.receiveShadow = true;
  scene.add(table);
  const margin = 1.4;
  const boardW = bounds.x1 - bounds.x0 + margin * 2;
  const boardD = bounds.z1 - bounds.z0 + margin * 2;
  const board = new Mesh(new RoundedBoxGeometry(boardW, BOARD, boardD, 2, 0.03), new MeshStandardMaterial({ color: colorToken('--b-board'), roughness: 0.95 }));
  board.position.set(bounds.cx, -BOARD / 2, bounds.cz);
  board.receiveShadow = true;
  board.castShadow = true;
  scene.add(board);

  const clay = colorToken('--b-clay');
  const foam = colorToken('--b-foam');
  const ink = cssToken('--b-ink');

  // ---------- lots: thin card plates ----------
  const lotMaterial = new MeshStandardMaterial({ color: colorToken('--b-lot'), roughness: 0.9 });
  const addLot = (lot: CityLot): void => {
    const w = lot.x1 - lot.x0;
    const d = lot.z1 - lot.z0;
    const plate = new Mesh(new BoxGeometry(w, 0.05, d), lotMaterial);
    plate.position.set(lot.x0 + w / 2, -0.025, lot.z0 + d / 2);
    plate.receiveShadow = true;
    plate.castShadow = true;
    scene.add(plate);
    if (lot.tier1) {
      const line = new Mesh(frameShape(w - 0.24, d - 0.24, 0.035, 0.02), new MeshBasicMaterial({ color: colorToken('--tier') }));
      line.position.set(plate.position.x, 0.002, plate.position.z);
      scene.add(line);
    }
    const label = flatText(`${lot.pkg.path}${lot.tier1 ? '   tier 1' : ''}`.toUpperCase(), { weight: 500, family: cssToken('--sans'), color: lot.tier1 ? cssToken('--tier') : ink, size: 0.26, letterSpacing: 0.16, anchor: 'left', opacity: 0.8 }, renderer);
    label.position.set(lot.x0 + 0.34, 0.003, lot.z1 - 0.36);
    scene.add(label);
  };
  city.lots.forEach(addLot);

  // ---------- buildings ----------
  const pickables: Mesh[] = [];
  const parts = new Map<string, BuildingParts>();
  const ring = radialHalo(renderer, [
    [0, 0],
    [0.5, 0],
    [0.56, 0.95],
    [0.64, 0.35],
    [0.8, 0.08],
    [1, 0],
  ]);

  const addBuilding = (building: CityBuilding): void => {
    const group = new Group();
    const w = building.side - INSET * 2;
    const floors: FloorParts[] = [];
    for (const floor of building.floors) {
      const y = (floor.y0 + floor.y1) / 2;
      if (floor.status === 'del') {
        // Vellum: a translucent sheet with a dashed red outline.
        const geometry = new BoxGeometry(w, FLOOR_H, w);
        const vellum = new Mesh(geometry, new MeshStandardMaterial({ color: colorToken('--b-vellum'), transparent: true, opacity: 0.35, roughness: 1, depthWrite: false }));
        vellum.position.set(building.x, y, building.z);
        vellum.userData = { building: building.id, floor: floor.index };
        const ghost = new LineSegments(new EdgesGeometry(geometry), new LineDashedMaterial({ color: colorToken('--del'), dashSize: 0.12, gapSize: 0.07, transparent: true }));
        ghost.computeLineDistances();
        ghost.position.copy(vellum.position);
        group.add(vellum, ghost);
        pickables.push(vellum);
        floors.push({ status: floor.status, mesh: vellum, ghost, base: vellum.material.color.clone() });
        continue;
      }
      const changed = floor.status !== 'same';
      // Untouched files are solid massing (no storey gaps); touched files show
      // their storeys, and the changed ones are painted.
      const height = building.touched ? FLOOR_H : FLOOR_H + FLOOR_GAP;
      const color = changed ? colorToken(statusToken(floor.status)) : building.touched ? clay : foam;
      const mesh = new Mesh(
        new RoundedBoxGeometry(changed ? w + 0.04 : w, height, changed ? w + 0.04 : w, 2, 0.015),
        new MeshStandardMaterial({ color, roughness: changed ? 0.78 : 0.92, transparent: true }),
      );
      mesh.position.set(building.x, building.touched ? y : floor.y0 + height / 2, building.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = { building: building.id, floor: floor.index };
      group.add(mesh);
      pickables.push(mesh);
      floors.push({ status: floor.status, mesh, ghost: null, base: color.clone() });
    }

    // Verdict halo on the board.
    let halo: BuildingParts['halo'] = null;
    const haloOpacity = HALO_OPACITY[building.verdict] ?? 0;
    if (building.touched && haloOpacity > 0) {
      halo = new Mesh(
        new PlaneGeometry(building.side * 2.2, building.side * 2.2),
        new MeshBasicMaterial({ map: ring, color: colorToken(verdictToken(building.verdict)), transparent: true, opacity: haloOpacity, depthWrite: false }),
      );
      halo.rotation.x = -Math.PI / 2;
      halo.position.set(building.x, 0.004, building.z);
      group.add(halo);
    }

    // Selection: an ink outline drawn on the plate around the footprint.
    const outline = new Mesh(frameShape(building.side + 0.12, building.side + 0.12, 0.035, 0.04), new MeshBasicMaterial({ color: colorToken('--b-ink'), transparent: true }));
    outline.position.set(building.x, 0.005, building.z);
    outline.visible = false;
    group.add(outline);

    const pins: BuildingParts['pins'] = [];
    if (building.touched) {
      labels.add(group, roofLabel(building), new Vector3(building.x, building.height + 0.05, building.z), { building: building.id, center: [0.5, 1], occlude: true });
      pinSpots(building, INSET).forEach((spot, i) => {
        const finding = building.findings[i];
        if (finding === undefined) return;
        const color = colorToken(severityToken(finding.severity));
        const stem = new Mesh(new CylinderGeometry(0.012, 0.012, 0.55, 8), new MeshStandardMaterial({ color: colorToken('--b-ink'), roughness: 0.6, transparent: true }));
        stem.position.set(spot.x, spot.y + 0.27, spot.z);
        const head = new Mesh(new SphereGeometry(finding.severity === 'high' ? 0.09 : 0.07, 24, 16), new MeshStandardMaterial({ color, roughness: 0.55, transparent: true }));
        head.position.set(spot.x, spot.y + 0.56, spot.z);
        head.castShadow = true;
        group.add(stem, head);
        pins.push(stem, head);
      });
    }
    parts.set(building.id, { floors, halo, haloOpacity, outline, pins });
    scene.add(group);
  };
  city.buildings.forEach(addBuilding);

  // ---------- reading path: an ink line on the board, numbered stops ----------
  const curve = pathCurve(city, 0.012);
  if (curve !== null) {
    const line = new Mesh(new TubeGeometry(curve, 240, 0.016, 6, false), new MeshBasicMaterial({ color: colorToken('--sig') }));
    scene.add(line);
    for (const stop of city.path) {
      const offset = stop.building.side / 2 + 0.12;
      labels.add(scene, h('div', 'stop', String(stop.order)), new Vector3(stop.building.x - offset, 0.02, stop.building.z + offset));
    }
  }

  // ---------- post: AO, a touch of depth of field ----------
  const composer = hdrComposer(renderer, scene, camera);
  const gtao = new GTAOPass(scene, camera, 1, 1);
  gtao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.4, thickness: 1.2, scale: 1.25, samples: 12, distanceFallOff: 1 });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 8 });
  gtao.blendIntensity = 1;
  composer.addPass(gtao);
  const bokeh = new BokehPass(scene, camera, { focus: 30, aperture: 0.00022, maxblur: 0.0016 });
  composer.addPass(bokeh);
  composer.addPass(new OutputPass());
  const focusUniforms = bokeh.uniforms as unknown as { focus: { value: number } };

  return {
    pickables,
    animated: false,
    paint(building: CityBuilding, state: PaintState) {
      const p = parts.get(building.id);
      if (p === undefined) return;
      for (const floor of p.floors) {
        const dim = state.dimmed || (state.type !== null && floor.status !== state.type);
        const material = floor.mesh.material;
        if (floor.ghost !== null) {
          material.opacity = dim ? 0.08 : 0.35;
          floor.ghost.material.opacity = dim ? 0.15 : 1;
          continue;
        }
        material.opacity = dim ? 0.18 : 1;
        material.depthWrite = !dim;
        material.color.copy(floor.base);
        if (state.hovered) material.color.multiplyScalar(floor.status === 'same' ? 0.86 : 1.12);
      }
      p.outline.visible = state.selected || state.hovered;
      p.outline.material.opacity = state.selected ? 1 : 0.35;
      if (p.halo !== null) p.halo.material.opacity = state.dimmed ? 0.05 : p.haloOpacity * (state.hovered || state.selected ? 1.15 : 1);
      for (const pin of p.pins) pin.material.opacity = state.dimmed ? 0.15 : 1;
    },
    render() {
      focusUniforms.focus.value = camera.position.distanceTo(target);
      composer.render();
    },
    setSize(width, height, pixelRatio) {
      // The maquette is soft by design (depth of field) and its text is HTML:
      // 1.5x is indistinguishable from 2x here and keeps 60 fps on a laptop.
      const scale = Math.min(pixelRatio, 1.5);
      composer.setPixelRatio(scale);
      composer.setSize(width, height);
      // AO is soft and denoised: half resolution is enough.
      gtao.setSize(Math.ceil((width * scale) / 2), Math.ceil((height * scale) / 2));
    },
  };
}

void startDirection({
  id: 'b',
  name: 'Architectural model',
  tagline: 'A clay maquette, coloured only where the agent changed code.',
  toneMapping: ACESFilmicToneMapping,
  exposure: 1.15,
  shadows: VSMShadowMap,
  build,
});

// Direction C, "Night data city": dark glass towers on a fine grid. Floors are
// LED strips in their status colour, building silhouettes are crisp lines in
// the verdict colour, verdicts are holographic tags on light beams, and the
// reading path is a pulse of light running from stop to stop.

import './style.css';

import {
  AdditiveBlending,
  AgXToneMapping,
  BoxGeometry,
  Color,
  DoubleSide,
  EdgesGeometry,
  Fog,
  Group,
  HemisphereLight,
  LineDashedMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  PlaneGeometry,
  PMREMGenerator,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import type { CityBuilding, CityLot, Status } from '../shared/city.js';
import { FLOOR_H } from '../shared/city.js';
import { hdrComposer, pathCurve, pinSpots, roofLabel } from '../shared/kit.js';
import { h } from '../shared/labels.js';
import type { DirectionContext, DirectionScene, PaintState } from '../shared/stage.js';
import { startDirection } from '../shared/stage.js';
import { colorToken, cssToken, severityToken, statusToken, verdictToken } from '../shared/tokens.js';
import { flatText } from '../shared/textures.js';

const INSET = 0.2;
/** HDR gain of the light strips: above 1 they bloom. */
const STRIP_GAIN = 1.9;
const STRIP_GAIN_QUIET = 0.35;

interface FloorParts {
  status: Status;
  glass: Mesh<BoxGeometry, MeshPhysicalMaterial>;
  strip: Mesh<BoxGeometry, MeshBasicMaterial> | null;
  ghost: LineSegments<EdgesGeometry, LineDashedMaterial> | null;
  base: Color;
  gain: number;
}

interface BuildingParts {
  floors: FloorParts[];
  edges: LineSegments2;
  edgeColor: Color;
  beam: Mesh<PlaneGeometry, ShaderMaterial> | null;
  extras: Mesh<SphereGeometry | BoxGeometry, MeshBasicMaterial>[];
}

const GRID_VERTEX = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

// Anti-aliased minor/major grid that fades out with distance from the city.
const GRID_FRAGMENT = /* glsl */ `
  uniform vec3 uGround;
  uniform vec3 uMinor;
  uniform vec3 uMajor;
  uniform vec2 uCenter;
  uniform float uRadius;
  varying vec3 vWorld;
  float gridLine(vec2 p, float step, float width) {
    vec2 coord = p / step;
    vec2 g = abs(fract(coord - 0.5) - 0.5) / fwidth(coord);
    return 1.0 - min(min(g.x, g.y) / width, 1.0);
  }
  void main() {
    vec2 p = vWorld.xz;
    float minor = gridLine(p, 1.0, 1.0);
    float major = gridLine(p, 5.0, 1.2);
    float fade = 1.0 - smoothstep(uRadius * 0.45, uRadius, distance(p, uCenter));
    vec3 color = uGround;
    color = mix(color, uMinor, minor * 0.4 * fade);
    color = mix(color, uMajor, major * 0.8 * fade);
    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// A light pulse along the path: dim base line with bright packets moving
// from the first stop to the last.
const PULSE_VERTEX = /* glsl */ `
  varying float vAlong;
  void main() {
    vAlong = uv.x;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const PULSE_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uLength;
  varying float vAlong;
  void main() {
    float d = vAlong * uLength;
    float packet = fract(d / 2.4 - uTime * 0.55);
    float head = smoothstep(0.78, 0.98, packet) * (1.0 - smoothstep(0.98, 1.0, packet));
    float intensity = 0.55 + head * 3.2;
    gl_FragColor = vec4(uColor * intensity, 1.0);
  }
`;

// Vertical light beam under a holographic badge: bright at the roof, gone at the top.
const BEAM_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    float across = 1.0 - abs(vUv.x - 0.5) * 2.0;
    float alpha = pow(across, 3.0) * (1.0 - vUv.y) * uOpacity;
    gl_FragColor = vec4(uColor * alpha, alpha);
  }
`;
const BEAM_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

function build({ city, scene, camera, renderer, labels, reducedMotion }: DirectionContext): DirectionScene {
  const { bounds } = city;
  const voidColor = colorToken('--c-void');
  scene.background = voidColor;
  scene.fog = new Fog(voidColor, bounds.span * 1.4, bounds.span * 3.4);

  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.2;
  pmrem.dispose();
  scene.add(new HemisphereLight(colorToken('--c-sky'), voidColor, 0.6));

  // ---------- ground grid ----------
  const ground = new Mesh(
    new PlaneGeometry(bounds.span * 8, bounds.span * 8),
    new ShaderMaterial({
      vertexShader: GRID_VERTEX,
      fragmentShader: GRID_FRAGMENT,
      uniforms: {
        uGround: { value: colorToken('--c-ground') },
        uMinor: { value: colorToken('--grid') },
        uMajor: { value: colorToken('--plot-line') },
        uCenter: { value: new Vector2(bounds.cx, bounds.cz) },
        uRadius: { value: bounds.span * 1.5 },
      },
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(bounds.cx, -0.02, bounds.cz);
  scene.add(ground);

  // Fat lines need the viewport size; kept here and updated on resize.
  const lineMaterials: LineMaterial[] = [];
  const fatEdges = (geometry: BoxGeometry, color: Color, width: number): LineSegments2 => {
    const material = new LineMaterial({ color, linewidth: width, transparent: true, worldUnits: false });
    lineMaterials.push(material);
    const lines = new LineSegments2(new LineSegmentsGeometry().fromEdgesGeometry(new EdgesGeometry(geometry)), material);
    return lines;
  };

  // ---------- lots ----------
  const lotMaterial = new MeshPhysicalMaterial({ color: colorToken('--c-lot'), roughness: 0.55, metalness: 0.2 });
  const tierPulse: LineMaterial[] = [];
  const addLot = (lot: CityLot): void => {
    const w = lot.x1 - lot.x0;
    const d = lot.z1 - lot.z0;
    const geometry = new BoxGeometry(w, 0.08, d);
    const plate = new Mesh(geometry, lotMaterial);
    plate.position.set(lot.x0 + w / 2, -0.04, lot.z0 + d / 2);
    scene.add(plate);
    const edge = fatEdges(geometry, lot.tier1 ? colorToken('--tier').multiplyScalar(1.8) : colorToken('--plot-line'), lot.tier1 ? 1.8 : 1);
    edge.position.copy(plate.position);
    scene.add(edge);
    if (lot.tier1) {
      const outer = fatEdges(new BoxGeometry(w + 0.3, 0.001, d + 0.3), colorToken('--tier').multiplyScalar(1.2), 1);
      outer.position.set(plate.position.x, 0, plate.position.z);
      scene.add(outer);
      tierPulse.push(outer.material);
    }
    const label = flatText(`${lot.pkg.path}${lot.tier1 ? '   tier 1' : ''}`, { weight: 500, family: cssToken('--mono'), color: cssToken(lot.tier1 ? '--tier' : '--muted'), size: 0.28, anchor: 'left' }, renderer);
    label.position.set(lot.x0 + 0.3, 0.003, lot.z1 - 0.34);
    scene.add(label);
  };
  city.lots.forEach(addLot);

  // ---------- buildings ----------
  const pickables: Mesh[] = [];
  const parts = new Map<string, BuildingParts>();
  const glassFor = (touched: boolean): MeshPhysicalMaterial =>
    new MeshPhysicalMaterial({
      color: colorToken(touched ? '--c-glass' : '--c-glass-quiet'),
      metalness: 0.25,
      roughness: 0.14,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      transparent: true,
      opacity: touched ? 0.94 : 0.82,
    });

  const addBuilding = (building: CityBuilding): void => {
    const group = new Group();
    const w = building.side - INSET * 2;
    const floors: FloorParts[] = [];
    for (const floor of building.floors) {
      const y = (floor.y0 + floor.y1) / 2;
      const geometry = new BoxGeometry(w, FLOOR_H, w);
      const glass = new Mesh(geometry, glassFor(building.touched));
      glass.position.set(building.x, y, building.z);
      glass.userData = { building: building.id, floor: floor.index };
      pickables.push(glass);
      if (floor.status === 'del') {
        glass.material.opacity = 0.12;
        glass.material.depthWrite = false;
        const ghost = new LineSegments(new EdgesGeometry(geometry), new LineDashedMaterial({ color: colorToken('--del').multiplyScalar(1.6), dashSize: 0.12, gapSize: 0.08, transparent: true }));
        ghost.computeLineDistances();
        ghost.position.copy(glass.position);
        group.add(glass, ghost);
        floors.push({ status: floor.status, glass, strip: null, ghost, base: new Color(), gain: 0 });
        continue;
      }
      const changed = floor.status !== 'same';
      const base = colorToken(statusToken(floor.status));
      const gain = changed ? STRIP_GAIN : building.touched ? STRIP_GAIN_QUIET : STRIP_GAIN_QUIET * 0.5;
      const strip = new Mesh(new BoxGeometry(w + 0.025, changed ? 0.07 : 0.03, w + 0.025), new MeshBasicMaterial({ color: base.clone().multiplyScalar(gain), transparent: true }));
      strip.position.set(building.x, floor.y1 - 0.06, building.z);
      group.add(glass, strip);
      floors.push({ status: floor.status, glass, strip, ghost: null, base, gain });
    }

    // The silhouette: one crisp outline for the whole tower, in the verdict colour.
    // Reviewed-fine towers keep a quiet outline; the verdicts that need a
    // reviewer get the full colour.
    const loud = building.verdict === 'eyes' || building.verdict === 'risky' || building.verdict === 'spec';
    const edgeColor = colorToken(building.touched ? verdictToken(building.verdict) : '--line').multiplyScalar(loud ? 1.3 : building.touched ? 0.5 : 1);
    const edges = fatEdges(new BoxGeometry(w + 0.01, building.height, w + 0.01), edgeColor.clone(), building.touched ? 1.3 : 1);
    edges.position.set(building.x, building.height / 2, building.z);
    group.add(edges);

    let beam: BuildingParts['beam'] = null;
    const extras: BuildingParts['extras'] = [];
    if (building.touched) {
      const top = building.height;
      const alert = building.verdict === 'eyes' || building.verdict === 'risky';
      if (alert) {
        beam = new Mesh(
          new PlaneGeometry(0.5, 1.1),
          new ShaderMaterial({
            vertexShader: BEAM_VERTEX,
            fragmentShader: BEAM_FRAGMENT,
            uniforms: { uColor: { value: colorToken(verdictToken(building.verdict)).multiplyScalar(1.5) }, uOpacity: { value: 0.9 } },
            transparent: true,
            blending: AdditiveBlending,
            depthWrite: false,
            side: DoubleSide,
          }),
        );
        beam.position.set(building.x, top + 0.55, building.z);
        group.add(beam);
      }
      labels.add(group, roofLabel(building), new Vector3(building.x, top + (alert ? 1.05 : 0.3), building.z), { building: building.id, center: [0.5, 1], occlude: true });
      pinSpots(building, INSET).forEach((spot, i) => {
        const finding = building.findings[i];
        if (finding === undefined) return;
        const color = colorToken(severityToken(finding.severity));
        const stem = new Mesh(new BoxGeometry(0.012, 0.5, 0.012), new MeshBasicMaterial({ color: color.clone().multiplyScalar(0.8), transparent: true }));
        stem.position.set(spot.x, spot.y + 0.25, spot.z);
        const head = new Mesh(new SphereGeometry(finding.severity === 'high' ? 0.085 : 0.065, 20, 14), new MeshBasicMaterial({ color: color.clone().multiplyScalar(finding.severity === 'high' ? 3 : 1.8), transparent: true }));
        head.position.set(spot.x, spot.y + 0.52, spot.z);
        group.add(stem, head);
        extras.push(stem, head);
      });
    }
    parts.set(building.id, { floors, edges, edgeColor, beam, extras });
    scene.add(group);
  };
  city.buildings.forEach(addBuilding);

  // ---------- reading path: a pulse of light ----------
  const pulse = new ShaderMaterial({
    vertexShader: PULSE_VERTEX,
    fragmentShader: PULSE_FRAGMENT,
    uniforms: { uColor: { value: colorToken('--sig') }, uTime: { value: 0 }, uLength: { value: 1 } },
  });
  const curve = pathCurve(city, 0.06);
  if (curve !== null) {
    pulse.uniforms['uLength'] = { value: curve.getLength() };
    scene.add(new Mesh(new TubeGeometry(curve, 320, 0.03, 8, false), pulse));
    for (const stop of city.path) {
      const ring = new Mesh(new RingGeometry(0.22, 0.27, 48), new MeshBasicMaterial({ color: colorToken('--sig').multiplyScalar(2), side: DoubleSide }));
      ring.rotation.x = -Math.PI / 2;
      const offset = stop.building.side / 2 + 0.05;
      ring.position.set(stop.building.x - offset, 0.02, stop.building.z + offset);
      scene.add(ring);
      labels.add(scene, h('div', 'stop', String(stop.order)), ring.position.clone());
    }
  }

  // ---------- post: restrained bloom ----------
  const composer = hdrComposer(renderer, scene, camera);
  const bloom = new UnrealBloomPass(new Vector2(256, 256), 0.45, 0.4, 0.9);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const sig = colorToken('--sig');
  return {
    pickables,
    animated: !reducedMotion,
    paint(building: CityBuilding, state: PaintState) {
      const p = parts.get(building.id);
      if (p === undefined) return;
      const lift = state.hovered ? 1.6 : state.selected ? 1.35 : 1;
      for (const floor of p.floors) {
        const dim = state.dimmed || (state.type !== null && floor.status !== state.type);
        if (floor.ghost !== null) {
          floor.ghost.material.opacity = dim ? 0.12 : 1;
          continue;
        }
        floor.glass.material.opacity = dim ? 0.25 : building.touched ? 0.94 : 0.82;
        if (floor.strip !== null) {
          floor.strip.material.color.copy(floor.base).multiplyScalar(dim ? 0.15 : floor.gain * lift);
          floor.strip.material.opacity = dim ? 0.4 : 1;
        }
      }
      const edge = p.edges.material;
      if (state.selected) edge.color.copy(sig).multiplyScalar(2.2);
      else edge.color.copy(p.edgeColor).multiplyScalar(state.hovered ? 2 : 1);
      edge.linewidth = state.selected ? 2.2 : building.touched ? 1.3 : 1;
      edge.opacity = state.dimmed ? 0.15 : 1;
      if (p.beam !== null) (p.beam.material.uniforms['uOpacity'] as { value: number }).value = state.dimmed ? 0 : 0.9;
      for (const extra of p.extras) extra.material.opacity = state.dimmed ? 0.12 : 1;
    },
    render(time) {
      if (!reducedMotion) {
        (pulse.uniforms['uTime'] as { value: number }).value = time;
        const breathe = 0.65 + 0.35 * Math.sin(time * 1.6);
        for (const material of tierPulse) material.opacity = breathe;
      }
      composer.render();
    },
    setSize(width, height, pixelRatio) {
      composer.setPixelRatio(pixelRatio);
      composer.setSize(width, height);
      bloom.resolution.set(width, height);
      for (const material of lineMaterials) material.resolution.set(width, height);
    },
  };
}

void startDirection({
  id: 'c',
  name: 'Night data city',
  tagline: 'Dark glass, light strips and a pulse along the reading path.',
  toneMapping: AgXToneMapping,
  exposure: 1.1,
  shadows: null,
  build,
});

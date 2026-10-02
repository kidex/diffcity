// The night ground (ADR-026): an anti-aliased minor/major grid drawn in a
// shader, fading out with the distance from the city. One draw call.

import { Mesh, PlaneGeometry, ShaderMaterial, Vector2 } from 'three';

import type { CityBounds } from '../../model/city.js';
import { colorToken } from '../tokens.js';

const VERTEX = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FRAGMENT = /* glsl */ `
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

export interface Ground {
  mesh: Mesh<PlaneGeometry, ShaderMaterial>;
  dispose(): void;
}

export function createGround(bounds: CityBounds): Ground {
  const size = Math.max(bounds.span, 10) * 8;
  const geometry = new PlaneGeometry(size, size);
  const material = new ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      uGround: { value: colorToken('--c-ground') },
      uMinor: { value: colorToken('--grid') },
      uMajor: { value: colorToken('--plot-line') },
      uCenter: { value: new Vector2(bounds.cx, bounds.cz) },
      uRadius: { value: Math.max(bounds.span, 10) * 1.5 },
    },
  });
  const mesh = new Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(bounds.cx, -0.02, bounds.cz);
  return {
    mesh,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

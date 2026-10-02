// The renderer around the city (ADR-026): WebGL2 with AgX tone mapping at
// exposure 1.1, an HDR multisampled composer RenderPass → UnrealBloomPass
// (half resolution, strength from --c-bloom, radius 0.4, threshold 0.9) →
// OutputPass, a pixel ratio capped at 2, resizing with the container, and a
// frame drawn only when something asked for one. dispose() frees every GPU
// resource and the context itself.

import {
  AgXToneMapping,
  HalfFloatType,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

export const EXPOSURE = 1.1;
export const BLOOM_RADIUS = 0.4;
export const BLOOM_THRESHOLD = 0.9;

/** The scene pass, counting its own draw calls (the post passes are not part of the scene budget). */
class CountingRenderPass extends RenderPass {
  calls = 0;

  override render(...args: Parameters<RenderPass['render']>): void {
    const [renderer] = args;
    const before = renderer.info.render.calls;
    super.render(...args);
    this.calls = renderer.info.render.calls - before;
  }
}

export interface StageFrame {
  /** Time of the frame, ms (requestAnimationFrame clock). */
  now: number;
}

export interface StageOptions {
  canvas: HTMLCanvasElement;
  /** The element whose size the canvas follows. */
  container: HTMLElement;
  bloomStrength: number;
  /** Called before each frame is drawn; return true to ask for another frame. */
  beforeFrame: (frame: StageFrame) => boolean;
  /** Called after each frame is drawn (labels, occlusion). */
  afterFrame: (frame: StageFrame) => void;
  /** Called on every resize, with the CSS size of the container. */
  onResize: (width: number, height: number) => void;
}

export class Stage {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(32, 1, 0.1, 400);
  readonly size = new Vector2(1, 1);
  readonly pixelRatio: number;
  private readonly composer: EffectComposer;
  private readonly scenePass: CountingRenderPass;
  private readonly bloom: UnrealBloomPass;
  private readonly output: OutputPass;
  private readonly observer: ResizeObserver;
  private readonly options: StageOptions;
  private frameId: number | null = null;
  private continuousUntil = 0;
  private disposed = false;
  /** No frame is drawn before start(). */
  private held = true;
  /** Frames drawn since the stage started. */
  frames = 0;

  /** Throws when WebGL2 is not available. */
  constructor(options: StageOptions) {
    this.options = options;
    this.renderer = new WebGLRenderer({ canvas: options.canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = AgXToneMapping;
    this.renderer.toneMappingExposure = EXPOSURE;
    this.renderer.info.autoReset = false;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(this.pixelRatio);

    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.scenePass = new CountingRenderPass(this.scene, this.camera);
    this.bloom = new UnrealBloomPass(new Vector2(1, 1), options.bloomStrength, BLOOM_RADIUS, BLOOM_THRESHOLD);
    this.output = new OutputPass();
    this.composer.addPass(this.scenePass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.output);

    this.observer = new ResizeObserver(() => {
      this.resize();
    });
    this.observer.observe(options.container);
    this.resize();
  }

  /** Draw calls of the scene in the last frame (the post passes excluded). */
  get sceneCalls(): number {
    return this.scenePass.calls;
  }

  setBloomStrength(strength: number): void {
    this.bloom.strength = strength;
    this.request();
  }

  resize(): void {
    if (this.disposed) return;
    const rect = this.options.container.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    if (width === this.size.x && height === this.size.y && this.frames > 0) return;
    this.size.set(width, height);
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.options.onResize(width, height);
    this.request();
  }

  /** Allows frames; the first one is drawn right away. */
  start(): void {
    this.held = false;
    this.request();
  }

  /** Asks for a frame; several requests before it is drawn give one frame. */
  request(): void {
    if (this.disposed || this.held || this.frameId !== null) return;
    this.frameId = requestAnimationFrame((now) => {
      this.frameId = null;
      this.draw(now);
    });
  }

  /** Draws every frame for `ms` milliseconds (the bench), then goes back to on-demand. */
  runContinuously(ms: number): void {
    this.continuousUntil = performance.now() + ms;
    this.request();
  }

  private draw(now: number): void {
    if (this.disposed) return;
    const again = this.options.beforeFrame({ now });
    this.renderer.info.reset();
    this.composer.render();
    this.frames += 1;
    this.options.afterFrame({ now });
    if (again || now < this.continuousUntil) this.request();
  }

  /**
   * Frees the passes, the render targets and the context. Returns the GPU
   * resources the renderer still held once everything else was released
   * (zero when nothing leaked), for the disposal test.
   */
  dispose(): { geometries: number; textures: number } {
    if (this.disposed) return { geometries: 0, textures: 0 };
    this.disposed = true;
    if (this.frameId !== null) cancelAnimationFrame(this.frameId);
    this.frameId = null;
    this.observer.disconnect();
    this.bloom.dispose();
    this.output.dispose();
    this.scenePass.dispose();
    this.composer.renderTarget1.dispose();
    this.composer.renderTarget2.dispose();
    this.composer.dispose();
    const { geometries, textures } = this.renderer.info.memory;
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    return { geometries, textures };
  }
}

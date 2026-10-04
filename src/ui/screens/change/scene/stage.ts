// The renderer around the city (ADR-026): WebGL2 with AgX tone mapping at
// exposure 1.1, an HDR multisampled composer RenderPass → UnrealBloomPass
// (half resolution, strength from --c-bloom, radius 0.4, threshold 0.9) →
// OutputPass, a pixel ratio capped at 2, resizing with the container, and a
// frame drawn only when something asked for one. One quality level (quality.ts)
// is chosen once from a 500 ms probe after the first frame and never changed
// again. dispose() frees every GPU resource and the context itself.

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

import type { QualityLevel, QualityState } from './quality.js';
import { levelFor, QUALITY_LEVELS, QualityProbe } from './quality.js';

export const EXPOSURE = 1.1;
export const BLOOM_RADIUS = 0.4;
export const BLOOM_THRESHOLD = 0.9;

/** The scene pass, counting its own draw calls (the post passes are not part of the scene budget). */
class CountingRenderPass extends RenderPass {
  calls = 0;
  triangles = 0;

  override render(...args: Parameters<RenderPass['render']>): void {
    const [renderer] = args;
    const before = renderer.info.render.calls;
    const trianglesBefore = renderer.info.render.triangles;
    super.render(...args);
    this.calls = renderer.info.render.calls - before;
    this.triangles = renderer.info.render.triangles - trianglesBefore;
  }
}

/** Bloom whose blur chain starts at `scale` of the drawing buffer instead of the half the pass uses by default. */
class ScaledBloomPass extends UnrealBloomPass {
  /** Fraction of the drawing buffer (0.5 is the pass's own half). */
  scale = 0.5;

  override setSize(width: number, height: number): void {
    super.setSize(width * (this.scale / 0.5), height * (this.scale / 0.5));
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
  /** Debug (`?scene-debug&scene-quality=<0-3>`): use this level and skip the probe, to measure each level on its own. */
  forceLevel?: number;
  /** Called once, when the probe has chosen the quality level (the glass drops its environment map in the last level). */
  onQuality?: (level: QualityLevel) => void;
}

export class Stage {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(32, 1, 0.1, 400);
  readonly size = new Vector2(1, 1);
  readonly pixelRatio: number;
  private readonly composer: EffectComposer;
  private readonly scenePass: CountingRenderPass;
  private readonly bloom: ScaledBloomPass;
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
  /** The quality level in force: full until the probe says otherwise, then fixed. */
  private levelNow: QualityLevel = QUALITY_LEVELS[0] as QualityLevel;
  private probeState: QualityProbe | null = null;
  /** Completed probes: never more than one. */
  private probes = 0;
  private probeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly onVisibility = (): void => {
    this.probeState?.visibility(document.visibilityState === 'visible', performance.now());
    if (this.probeState?.running === true) this.request();
  };
  private probedFps: number | null = null;
  private probeDone = false;

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
    this.bloom = new ScaledBloomPass(new Vector2(1, 1), options.bloomStrength, BLOOM_RADIUS, BLOOM_THRESHOLD);
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

  /** Triangles of the scene in the last frame (the post passes excluded). */
  get sceneTriangles(): number {
    return this.scenePass.triangles;
  }

  /** The quality level in force and how it was chosen, for the debug hook. */
  get quality(): QualityState {
    return { ...this.levelNow, settled: this.probeDone, probes: this.probes, fps: this.probedFps };
  }

  /**
   * Draws every frame for the probe (warm-up, then the measured window), takes
   * the median frame rate and picks the quality level, once (a second call
   * does nothing). A tab hidden at any moment voids the probe: it starts over
   * when the tab is visible again, and a tab hidden at mount starts it on
   * the first show. The level is chosen only by a probe that ran visible.
   */
  probe(): Promise<void> {
    const forced = QUALITY_LEVELS[this.options.forceLevel ?? -1];
    if (forced !== undefined && this.probes === 0) {
      this.probes = 1;
      this.probeDone = true;
      this.applyLevel(forced);
      return Promise.resolve();
    }
    if (this.probeState !== null || this.probes > 0 || this.disposed) return Promise.resolve();
    const probe = new QualityProbe(document.visibilityState === 'visible', performance.now());
    this.probeState = probe;
    document.addEventListener('visibilitychange', this.onVisibility);
    return new Promise((resolve) => {
      const poll = (): void => {
        if (this.disposed) {
          resolve();
          return;
        }
        if (probe.tick(performance.now())) {
          document.removeEventListener('visibilitychange', this.onVisibility);
          this.probeState = null;
          this.probes = 1;
          this.probedFps = probe.fps;
          this.probeDone = true;
          this.applyLevel(levelFor(probe.fps ?? 0));
          resolve();
          return;
        }
        this.probeTimer = setTimeout(poll, 50);
      };
      poll();
      if (probe.running) this.request();
    });
  }

  private applyLevel(next: QualityLevel): void {
    const previous = this.levelNow;
    this.levelNow = next;
    if (next.msaa !== previous.msaa) {
      for (const target of [this.composer.renderTarget1, this.composer.renderTarget2]) {
        target.samples = next.msaa;
        target.dispose();
      }
    }
    if (next.bloomScale !== previous.bloomScale) {
      this.bloom.scale = next.bloomScale;
      this.composer.setSize(this.size.x, this.size.y);
    }
    this.options.onQuality?.(next);
    this.request();
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
    this.probeState?.frame(now);
    const again = this.options.beforeFrame({ now });
    this.renderer.info.reset();
    this.composer.render();
    this.frames += 1;
    this.options.afterFrame({ now });
    if (again || now < this.continuousUntil || this.probeState?.running === true) this.request();
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
    clearTimeout(this.probeTimer);
    document.removeEventListener('visibilitychange', this.onVisibility);
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

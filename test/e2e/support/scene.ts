// Reads the change screen's city through its `?scene-debug` hook
// (window.diffcityScene, src/ui/screens/change/index.ts).

import { expect, type Page } from '@playwright/test';

export interface SceneStats {
  drawCalls: number;
  buildings: number;
  floors: number;
  lots: number;
  labels: number;
  frames: number;
  geometries: number;
  textures: number;
  builds: number;
}

export interface CameraState {
  theta: number;
  phi: number;
  r: number;
}

export interface Disposal {
  live: number;
  lastGeometries: number;
  lastTextures: number;
}

/** Opens a change with the debug hook on and waits for the first frame. */
export async function openCity(page: Page, changeId = 11): Promise<void> {
  await page.goto(`/?scene-debug#/change/${String(changeId)}`);
  await waitReady(page);
}

/**
 * The city's state is only as fast as the first WebGL frame: on a CI runner
 * SwiftShader compiles shaders for seconds, and the next frames follow the
 * same CPU. Every wait on the city's attributes uses this budget, never the
 * 5 s default.
 */
export const CITY_TIMEOUT = 30_000;

/**
 * `expect` with the city's budget, for specs whose assertions follow the
 * scene (roof labels, buildings, camera, selection). The page is one frame
 * loop on SwiftShader: a label or a building shows up when a frame has run.
 */
export const sceneExpect = expect.configure({ timeout: CITY_TIMEOUT });

/** Waits until the city has drawn its first frame (`data-ready`). */
export async function waitForCity(page: Page): Promise<void> {
  await waitForCityAttribute(page, 'data-ready', 'true');
}

/** Waits for one of the city's state attributes (`data-selected`, `data-hovered`; '' for none). */
export async function waitForCityAttribute(page: Page, name: 'data-selected' | 'data-hovered' | 'data-ready', value: string): Promise<void> {
  await expect(page.getByTestId('city')).toHaveAttribute(name, value, { timeout: CITY_TIMEOUT });
}

export async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction('window.diffcityScene !== undefined && window.diffcityScene.ready === true', null, { timeout: CITY_TIMEOUT });
  await waitForCity(page);
}

/**
 * Makes WebGL unavailable, so the change screen renders its fallback table
 * instead of the city. For specs that prove the page around the city (header,
 * routing, lazy loading, live fill-in) and must not pay for a SwiftShader
 * context. Call before `page.goto`.
 */
export async function withoutWebgl(page: Page): Promise<void> {
  await page.addInitScript(`{
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
      return /webgl/i.test(kind) ? null : getContext.call(this, kind, ...rest);
    };
  }`);
}

export const stats = (page: Page): Promise<SceneStats> => page.evaluate<SceneStats>('window.diffcityScene.stats()');
export const camera = (page: Page): Promise<CameraState> => page.evaluate<CameraState>('window.diffcityScene.camera()');
export const firstCamera = (page: Page): Promise<CameraState> => page.evaluate<CameraState>('window.diffcityScene.firstCamera()');
export const selected = (page: Page): Promise<string | null> => page.evaluate<string | null>('window.diffcityScene.selected()');
export const hovered = (page: Page): Promise<string | null> => page.evaluate<string | null>('window.diffcityScene.hovered()');
export const disposal = (page: Page): Promise<Disposal> => page.evaluate<Disposal>('({ ...window.diffcityScene.disposal })');
export const bench = (page: Page, ms: number): Promise<{ fps: number; drawCalls: number }> =>
  page.evaluate<{ fps: number; drawCalls: number }>(`window.diffcityScene.bench(${String(ms)})`);

/** The symbol id of the focused floor of the selected building. */
export const selectedFloor = (page: Page): Promise<string | null> => page.evaluate<string | null>('window.diffcityScene.selectedFloor()');

/** Client point of a building's centre, or of one of its floors' when `symbolId` is given. */
export async function project(page: Page, fileId: string, symbolId?: string): Promise<{ x: number; y: number }> {
  const point = await page.evaluate<{ x: number; y: number } | null>(
    `window.diffcityScene.project(${JSON.stringify(fileId)}${symbolId === undefined ? '' : `, ${JSON.stringify(symbolId)}`})`,
  );
  if (point === null) throw new Error(`${fileId} is not on screen`);
  return point;
}

/** True when the city's canvas holds a live WebGL2 context. */
export function hasWebgl2(page: Page): Promise<boolean> {
  return page.evaluate<boolean>(`(() => {
    const canvas = document.querySelector('[data-testid="city-canvas"]');
    const gl = canvas && canvas.getContext('webgl2');
    return Boolean(gl) && !gl.isContextLost();
  })()`);
}

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

export async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction('window.diffcityScene !== undefined && window.diffcityScene.ready === true', null, { timeout: 30_000 });
  await expect(page.getByTestId('city')).toHaveAttribute('data-ready', 'true');
}

export const stats = (page: Page): Promise<SceneStats> => page.evaluate<SceneStats>('window.diffcityScene.stats()');
export const camera = (page: Page): Promise<CameraState> => page.evaluate<CameraState>('window.diffcityScene.camera()');
export const firstCamera = (page: Page): Promise<CameraState> => page.evaluate<CameraState>('window.diffcityScene.firstCamera()');
export const selected = (page: Page): Promise<string | null> => page.evaluate<string | null>('window.diffcityScene.selected()');
export const hovered = (page: Page): Promise<string | null> => page.evaluate<string | null>('window.diffcityScene.hovered()');
export const disposal = (page: Page): Promise<Disposal> => page.evaluate<Disposal>('({ ...window.diffcityScene.disposal })');
export const bench = (page: Page, ms: number): Promise<{ fps: number; drawCalls: number }> =>
  page.evaluate<{ fps: number; drawCalls: number }>(`window.diffcityScene.bench(${String(ms)})`);

/** Client point of a building's centre. */
export async function project(page: Page, fileId: string): Promise<{ x: number; y: number }> {
  const point = await page.evaluate<{ x: number; y: number } | null>(`window.diffcityScene.project(${JSON.stringify(fileId)})`);
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

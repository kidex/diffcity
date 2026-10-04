// Chromium arguments every Playwright project launches with: WebGL in headless
// Chromium runs on SwiftShader (the change screen's city needs it), and with it
// the whole page is rasterised on the CPU. Shared by test/playwright.config.ts
// and by specs that launch their own browser, so the two cannot drift.
export const WEBGL_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

// Sora (UI) and IBM Plex Mono (code, file names, labels), bundled as local
// woff2 files so the page never calls Google Fonts and the export works
// offline (ADR-022). Same weights as the mockup's Google Fonts link.

import '@fontsource/sora/300.css';
import '@fontsource/sora/400.css';
import '@fontsource/sora/500.css';
import '@fontsource/sora/600.css';
import '@fontsource/sora/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';

/** Resolves once the bundled faces are loaded; canvas text must wait for it. */
export function fontsReady(): Promise<FontFaceSet> {
  return document.fonts.ready;
}

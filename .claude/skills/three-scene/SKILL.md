---
name: three-scene
description: How the 3D city in design/mockup.html is built - tokens, lots, buildings, floors, labels, verdict badges, pins, reading path, camera, orbit, raycast, hover, selection, filters, intro animation - and how to port it to src/ui with the current three release (ADR-003). Use for any change-screen or scene task.
---

# The city scene

`design/mockup.html` is the reference. Port its behaviour exactly; the numbers below come from it.

## Tokens

All colours are CSS custom properties on `:root`, read at runtime through `getComputedStyle`. Dark is the default; light applies under `prefers-color-scheme: light` or `data-theme="light"`.

| Token | Dark | Use |
|---|---|---|
| `--bg` / `--bg-deep` | `#12203A` / `#0D172B` | page / top bar, label outline, badge text |
| `--panel` / `--panel-2` | `#172A4A` / `#1D3358` | panels, chips |
| `--line` / `--line-soft` | `#2A4068` / `#223659` | borders |
| `--ink` / `--ink-2` / `--muted` | `#E9EFFA` / `#B4C2DC` / `#7F92B5` | text |
| `--grid` | `#1B2D4E` | ground grid |
| `--plot` / `--plot-line` | `#16294A` / `#2F4A7A` | lot fill / lot edge |
| `--add` `--mod` `--del` `--sig` | `#6FD3A0` `#F4B94A` `#F0705F` `#B69BFF` | floor status |
| `--same` / `--same-top` | `#2B4068` / `#35507F` | untouched floors |
| `--tier` | `#FF8A5B` | tier 1 outline, "needs your eyes" |
| `--sev-high` `--sev-med` `--sev-low` | `#F0705F` `#F4B94A` `#7FB1FF` | finding pins |

Verdict colours: eyes `#FF8A5B`, risky `#F0705F`, spec `#FF7AC6`, ok `#6FD3A0`, same `#5A6F98`. The mockup hard-codes spec and same; in `src/ui` add them as `--verdict-spec` and `--verdict-same` tokens so no hex lives in TypeScript.

Fonts: Sora (300–700) for UI, IBM Plex Mono (400–500) for code, file names and labels. Wait for `document.fonts.ready` before drawing canvas textures. Bundle the fonts locally; no Google Fonts request (export must work offline).

## Layout

The mockup hand-places lots and buildings on an integer grid (`x, y, w, d` per package and per file). A real `Report` has no coordinates, so `src/ui` needs a layout step: packages as lots, files as buildings with footprint from symbol count, a one-cell gap between lots. This is presentational, so it may live in `src/ui`, but it must be deterministic for the same `Report` so the city does not jump on live updates. The architect decides the algorithm (ADR) at the start of phase 3.

## Geometry

| Element | Construction |
|---|---|
| Ground | `PlaneGeometry(60, 60)` with `ShadowMaterial({ opacity: 0.35 })`, receives shadows, `y = -0.01` |
| Grid | `GridHelper(60, 60)` in `--grid`, opacity 0.7 |
| Lot | `BoxGeometry(w, 0.12, d)` at `y = -0.06`, `MeshStandardMaterial` `--plot`, roughness 0.95; edges `LineSegments(EdgesGeometry)` in `--plot-line` |
| Tier 1 lot | edges in `--tier`, plus a dashed ring `BoxGeometry(w + 0.16, 0.2, d + 0.16)` with `LineDashedMaterial` dash 0.3 / gap 0.2 (call `computeLineDistances`) |
| Lot label | flat-ish sprite at the lot's front-left corner, mono 0.34, `--muted` (tier: `--tier`, suffix `   tier 1`) |
| Building | inset `INSET = 0.18` inside its cell; one floor per symbol |
| Floor | `BoxGeometry(w, FH = 0.5, d)`, stacked with `GAP = 0.06`; `MeshStandardMaterial` in the status colour, roughness 0.55, metalness 0.05, emissive = same colour, emissiveIntensity 0.18 (untouched: 0.05); casts and receives shadows; edges in `--bg-deep` at opacity 0.85 |
| `del` floor | no mesh: `LineSegments(EdgesGeometry)` with `LineDashedMaterial` in `--del`, dash 0.16 / gap 0.1 |
| Untouched building | floors at opacity 0.85, no label, no badge |
| Roof label | sprite, file name, mono 0.3, `--ink`, at `height + 0.32`, only on touched buildings |
| Verdict badge | pill sprite at `height + 0.95`: verdict colour fill, dark dot and text `#0D172B`, Sora 600 26px, height 44px canvas → world scale `0.42 / 44`; `depthTest: false`, `renderOrder: 10` |
| Finding pin | stem `CylinderGeometry(0.02, 0.02, 0.6)` basic material; head `SphereGeometry(high 0.11, else 0.085)` emissive 0.6; placed on the roof's front-right corner, stepping `-0.28` in x per pin; colour by severity |
| Reading path | `Line` through building centres at `y = 0.03`, `LineDashedMaterial` `--sig` dash 0.25 / gap 0.18 |
| Step disc | `CylinderGeometry(0.34, 0.34, 0.06, 32)` in `--sig`, emissive 0.5, with a flat number label (`--bg-deep`, bold, 0.34) |

Text sprites: draw on a 2× canvas, font 28px (labels) with a 6px `--bg-deep` stroke for legibility, `LinearFilter`, `depthWrite: false`. Flat labels are a rotated `PlaneGeometry` instead of a sprite.

## Lights and renderer

- `WebGLRenderer({ antialias: true, alpha: true })`, pixel ratio capped at 2, `PCFSoftShadowMap`.
- `HemisphereLight(0xdfe8ff, 0x1a2a4a, 0.85)`.
- `DirectionalLight(0xffffff, 0.9)` at `(-8, 18, 6)` aimed at the city centre, shadow map 2048, shadow camera ±16, near 1, far 60.

## Camera and controls

- `PerspectiveCamera(32, aspect, 0.1, 200)`, orbiting the city centre (mockup: `(11, 0, 6)`; in `src/ui`: the layout's bounding-box centre).
- Spherical coordinates: home `theta = 0.22π`, `phi = 0.98`, `r = 30`.
- Drag: `theta -= dx * 0.006`, `phi = clamp(phi - dy * 0.005, 0.35, 1.35)`. A drag over 3 px is not a click.
- Wheel: `r = clamp(r * (1 + deltaY * 0.0012), 14, 48)`, `preventDefault`, non-passive listener.
- `R` resets to home. `J` / `K` select the next / previous step.
- Intro: over 1400 ms, `r` eases from 46 to home with ease-out cubic. Skipped under `prefers-reduced-motion`.
- Resize with a `ResizeObserver` on the city container.

## Interaction

- Raycast only floor meshes (`pickables`); each carries `{ id, floor, s }` in `userData`.
- Hover: emissive 0.5 on the building, cursor `pointer`, tooltip with verdict, file, package, counts by status (+added, modified, sig, removed), the floor under the cursor, number of findings. Tooltip follows the pointer, offset 14 px, clamped to the container.
- Click (no drag): select the building, emissive 0.42, highlight and scroll the matching step in the panel.
- Panel hover highlights the building; panel click selects it.
- Default selection on load: the first tier 1 step.

## Filters

- Verdict filter (single, toggle): buildings with another verdict are dimmed.
- Type filter (single, toggle): floors of another status are dimmed; buildings with no floor of that status are dimmed entirely.
- Both combine with AND. "Show everything" clears both.
- Dimmed floors: opacity 0.14. Dimmed `del` skeletons, labels, badges, edges and pins: opacity 0.12.
- Counters: verdict chips count buildings; type chips count floors.

## Porting r128 → current `three` (ADR-003)

| r128 (mockup) | Current |
|---|---|
| `renderer.outputEncoding = sRGBEncoding` | `renderer.outputColorSpace = SRGBColorSpace` (default) |
| `texture.encoding = sRGBEncoding` | `texture.colorSpace = SRGBColorSpace` |
| Legacy light units | Physically correct units only: directional and hemisphere intensities need rescaling (start by multiplying by π) and tuning by eye against the mockup |
| Colours from hex treated without colour management | `ColorManagement.enabled` is on: hex/CSS colours are converted from sRGB to linear; check that floor colours still match the tokens on screen |
| Global `THREE` from CDN | ES module imports from `three`; bundle with Vite; inline into the single-file export |

Done means a side-by-side screenshot of the mockup and `src/ui` on the mockup's sample data shows the same colours, heights, labels and camera framing.

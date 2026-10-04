---
name: three-scene
description: How the change screen's 3D city is built in src/ui/screens/change - the night data city of ADR-026 (direction C) - its module layout, layout rules, tokens, renderer and post chain, instanced geometry and the 40 draw-call budget, labels, camera and orbit, picking, hover and selection, live updates, disposal, the ?scene-debug hook and how to test it. Use for any change-screen or scene task.
---

# The city scene

Look: "Night data city" (ADR-026, SPEC.md section 6). `design/directions/c` is the prototype and `design/directions/screenshots/c-hero.png` the look to match; `design/mockup.html` stays the reference for information and behaviour (what is shown, counters, filters, camera, keys). The prototype builds a mesh per floor; never port that: the product is instanced from the first commit.

## Rules that do not bend

- The screen renders from a `Report` alone (it is also the HTML export, ADR-002). `src/ui/screens/change/**` never imports `src/ui/data/**` (lint enforces it); core types come in with `import type` only (ADR-022).
- Nothing computes status, verdict, tier 1, paths or anchoring. The layout copies them from the Report.
- No colour in TypeScript: every colour is a CSS token read at run time (`scene/tokens.ts`).
- At most 40 scene draw calls at any city size (measured on the scene pass only, post passes excluded).
- The change screen chunk is loaded with `import()` by `src/ui/app/change-route.ts`; Fleet and Repo never download three.js.

## Module layout (`src/ui/screens/change/`)

| File | Role |
|---|---|
| `index.ts` | `mountChange(el, { report }) → { update(report), unmount }`; states: `null` → "Computing the first snapshot of this change…", no files → "No files in this change", no WebGL → `fallback.ts`, else the city; installs `window.diffcityScene` under `?scene-debug` |
| `fallback.ts` | "3D view needs WebGL" and the touched-file table (status, verdict, tier 1) |
| `model/city.ts` | pure layout (no three, no DOM, unit-tested in Node): `buildCity(report, { rowWidth? })`, `sideOf`, `floorsOf`, `labelledBuildings` |
| `model/view.ts` | pure: the mockup's filter rules (`Filters {verdict, type, rule}`, `toggleVerdict/Type/Rule`, `clearFilters`, `ruleIndex`, `pruneFilters`) and `paintCity` / `focusPaint`, which give every building and floor a `PaintState` (`dimmed`, `typeMatch`, `hovered`, `selected`, `focused`, `pulse`, `pulseColor`, `checked`; `focusPaint` takes the focused symbol id and sets `focused` on that floor of the selected building): `pulse` and `pulseColor` come from the `critical` input (`criticalFloors`; on a building `pulse` means its roof strip), `checked` from the `marks` input (a floor takes its symbol's mark, else its file's; a building takes a rewrite on any floor, else its file's mark, else checked or good when every changed floor is) |
| `model/hud.ts` | pure: what the HUD shows from the Report: top-bar counters (`summary`), verdict / type / rule chips, check chips (`report.checks`, unknown state reads not-checked), `changeLevel` ("CI failed" for a pipeline rule's change-level finding or a pipeline check with violations, else a count), tooltip and card data |
| `model/critical.ts` | pure (DC-50): `criticalFloors(report, marks?)` (which floors pulse, by file id: `{ color, floors, roof }`), `Marks`/`MarkKind` (the review overlay by file and symbol id), `floorMark`, the pulse numbers (`PULSE_PERIOD` 1.6 s, `PULSE_MIN` 1, `PULSE_MAX` 2.4, `PULSE_STILL` 1.8), `pulseGain`, `phaseOf(fileId)` |
| `model/markers.ts` | pure: `findingMarkers(city, findings)` places a pin on the roof per finding, an X for a `rule:` source (on the floor of its symbol, else the roof), nothing for a change-level finding; `slot` orders markers sharing a spot |
| `model/path.ts` | pure: `pathStops(city, steps)` (stops by step order, `nth` for stops on one building), `pathPoints` (the buildings the tube crosses) |
| `model/tween.ts` | pure: `tweenCity(from, to, t)`, `needsTween`, `easeOut`, `TWEEN_MS = 400` |
| `ports.ts` | `FleetPort`, `FleetCard`, `FleetCardRow`: types only; without a port the Fleet card is not drawn |
| `panel/` | the reading panel and file view, plain DOM (`index` tabs, selection and J/K; `stops` cards; `lists` the other tabs; `file-view`; `panel.css`); pure data in `model/panel.ts`. It drives the city through `CityView.select(fileId, symbolId?)` and `hover(fileId)` and hears the city through the hooks `select(building, symbolId)` and `click(building, floor)`; the file view opens on `click` and on a panel click |
| `hud/` | plain DOM (textContent / `h()`): `topbar` (counters, eyes badge, check chips, change-level pills, Export PlantUML and Approve as `aria-disabled` with "Arrives in a later version"; own breadcrumb only with `crumb: true`), `filters` (three rows, Rules hidden without rule findings), `legend` (X entry with rule findings), `tooltip`, `card` (selection card), `fleet`, `index` (title, hint, toast) |
| `review/` + `model/review.ts` | review marks (ADR-028, DC-88), only with a `ReviewPort`: `controller` (state, optimistic writes with rollback, refetch on `snapshot-moved` and on the port's change event), `ui` (mark bars on the selection card and the file view header, keys C G W U, "whole file or focused floor" scope), `controls`, `rewrite` and `summary` dialogs over `dialog` (modal, focus trap, Esc); `model/review.ts` is pure (marks to the scene's `Marks`, note check, targets, progress wording, tooltip line). `Filters.hideChecked` lives in `model/view.ts` |
| `scene/view.ts` | ties it together: stage, content (ground, lots, towers, markers, path), labels, orbit, picker, the motion clock and the render loop (`animating()`); `setMarks(marks)` takes the review overlay; `setReport` rebuilds content and keeps camera, selection and the row width; rebuilds on a colour-scheme change; `dispose()` |
| `scene/stage.ts` | `WebGLRenderer`, AgX at exposure 1.1, `EffectComposer` on a half-float 4x MSAA target: `RenderPass` (counting its draw calls) → `UnrealBloomPass` (strength `--c-bloom`, radius 0.4, threshold 0.9; it already works at half resolution) → `OutputPass`; pixel ratio `min(dpr, 2)`; `ResizeObserver`; frames only on request; `runContinuously(ms)` for the bench; `dispose()` frees passes, targets and the context (`forceContextLoss`) |
| `scene/orbit.ts` | the mockup's orbit as plain math plus `bindOrbit` (listeners on an `AbortController`, removed on unmount) |
| `scene/picking.ts` | ray against one box per building (not the meshes); floor from the hit height; the same boxes answer label occlusion |
| `scene/labels.ts` | `CSS2DRenderer` in its own `Scene`; at most 120 labels, re-ranked when the camera rests |
| `scene/tokens.ts` | `colorToken`, `numberToken`, `statusToken`, `verdictColor` |
| `scene/night/ground.ts` | shader grid (minor 1, major 5, anti-aliased with `fwidth`, fading with distance), 1 draw |
| `scene/night/lots.ts` | plates (1 instanced mesh), outlines (batched `LineSegments2`: plain lots, tier 1 lots, tier 1 outer ring, a transparent material whose opacity breathes between 0.3 and 1), lot names in one canvas atlas on one mesh |
| `scene/night/towers.ts` | glass floors (3 instanced meshes: touched, untouched, removed), status strips (1 instanced mesh with instance colours and a per-instance `aPulse` read by a shader chunk with `uTime` / `uStill`), glass opacity per instance (`aOpacity` chunk on the three glass meshes), a halo strip mesh made only under reduced motion, verdict outlines (1 batched `LineSegments2` with per-segment colours), selection outline (1 `LineSegments2`), removed-floor skeletons (1 merged dashed `LineSegments`), beams for eyes and risky (1 instanced camera-facing plane) |
| `scene/night/motion.ts` | the clock the effects share: `time` and `still` uniforms (time stays 0 and `still` is 1 under reduced motion), `breathe(seconds)` for the tier 1 ring |
| `scene/night/markers.ts` | one instanced mesh per shape (pins, X, check mark; the notch and the roof plate share one), growing when a mark needs more instances; `update(city)` follows a tween, `setPaint(paint)` draws the check and rewrite markers from `PaintState.checked`; `list()` for the hook |
| `scene/night/path.ts` | the reading path, only with steps: one `TubeGeometry` with the packet shader, stop rings in one instanced mesh, stop numbers in one mesh over a canvas atlas drawn at 4x (128 px cells, mono face); built for the Report's city and hidden while the towers tween |
| `scene/night/lines.ts` | `fatLines` (`setColor`, `setPositions` in place), `pushBoxEdges`, `pushRect`, per-segment colour updates |

## Night effects (DC-50, DC-52)

- **Pulse.** A floor pulses when it is a changed floor of an eyes or risky file or of a tier 1 file, or has an open `high` finding (`finding.symbolId`); a high finding with no symbol pulses the roof strip, which is the strip of the building's highest floor. The strip takes the file's verdict colour (eyes, risky), else `--sev-high`, at the full 1.9 gain (a quiet floor's strip turns bold while it pulses), and its gain runs x1.0 to x2.4 on a 1.6 s sine, each building on its own phase (`phaseOf(file id)`). Dimmed floors and floors with a current mark (checked, good, rewrite) do not pulse; an outdated mark looks unchecked.
- **Reduced motion.** The same floors hold x1.8 plus a halo strip (`HALO_*` in `towers.ts`, additive), the path's tube holds a steady glow, the tier 1 ring stays at opacity 1.
- **Markers.** A pin on the roof for every finding that is not a rule violation (severity colour, high larger and brighter); an X (`rule:` source) on the front face of the symbol's floor, or lying on the roof; none for a change-level finding. Slots run along the front-right edge and wrap to the next row back.
- **Checked rendering.** A floor with a current mark: strip x0.35, glass opacity 0.6 (a per-instance factor of the material's 0.94 or 0.82). A file whose changed floors are all checked or good (or that has a file mark): check mark above the roof and the outline at half strength. Rewrite: a `--del` notch on the floor's face and a `--del` plate on the roof. The marks come from `setMarks`, which the screen feeds from the ReviewPort (`model/review.ts` `marksOf`; `review/controller.ts` holds the state); specs seed them through the mock API's review routes (`test/e2e/support/review-api.ts`).
- **Render loop.** `animating()` is true only when a strip pulses, the path has a tube or the Report has a tier 1 lot, and the tab is visible, and reduced motion is off; the stage then keeps requesting frames. Otherwise frames are on demand (camera, tween, hover, state change). The clock `motion.time` is set from the frame time before each frame; `visibilitychange` restarts the loop.

## Layout (`model/city.ts`)

- A lot per package, a building per file, a floor per symbol. Floor height 0.5, gap 0.06, inset 0.2.
- Floors bottom to top in source order: `range.start`, then `range.end`, then id. A file without symbols gets one floor in the file's status.
- Footprint: `1.15 + 0.28 * clamp(symbols, 1, 6)`.
- Lots: files shelf-packed in Report order into a row width near `sqrt(area * 1.25)`.
- City: packages with no touched file first, in their own rows at the back (low z, far from the home camera), then the touched ones, each group in Report order. Lots stretch to their row's depth; buildings sit at the back-left, the name strip at the front.
- Row width: the first Report of a view gets a multiple of 8 (`sqrt(area * 1.6)` rounded up). The view passes it back (`buildCity(report, { rowWidth })`) for every later Report, so an added file moves only its own lot and the lots after it; lots before it in its row keep their place and only their plate deepens with the row. A lot wider than the rows stands alone in its own row. The width is chosen afresh only when the fresh width reaches twice the kept one (`REFLOW_FACTOR`).
- A quiet package that gets its first touched file leaves the back rows for the touched block (ADR-026; the move is tweened once live updates animate).
- Deterministic: same Report and no previous width, same coordinates. Tests: `test/unit/ui/city-layout.test.ts`.
- Label priority (`labelledBuildings`, ADR-026): selected and hovered; then eyes and risky; then the other touched files; within a group nearest the camera first, then Report order. Untouched buildings never get a label.

## Tokens

Mockup palette in `src/ui/shared/tokens.css` plus the night city's own:

| Token | Use |
|---|---|
| `--c-void` | scene background and fog |
| `--c-ground` | ground under the grid; grid lines `--grid` (minor) and `--plot-line` (major) |
| `--c-sky` | hemisphere light (intensity 0.6, ground colour `--c-void`) |
| `--c-lot` | lot plates (physical, roughness 0.55, metalness 0.2); edges `--plot-line`, tier 1 `--tier` x1.8 (width 1.8) and outer ring `--tier` x1.2 |
| `--c-glass` / `--c-glass-quiet` | touched (opacity 0.94) and untouched (0.82) glass: physical, metalness 0.25, roughness 0.14, clearcoat 1; removed floors 0.12 |
| `--c-bloom` | bloom strength (0.45 dark, 0.12 light) |
| `--add` `--mod` `--sig` `--del` / `--same-top` | strips: changed x1.9 (they bloom), touched-same x0.35, untouched x0.175; skeletons `--del` x1.6, dash 0.12 / gap 0.08 |
| `--verdict-*` | outlines: eyes, risky, spec x1.3; ok x0.5; untouched `--line`; hover x2; selection `--sig` x2.2 at width 2.2; beams x1.5 |

Light theme: the same scene on pale `--c-*` values with a weaker bloom.

Environment: `RoomEnvironment` through `PMREMGenerator` (sigma 0.04), intensity 0.2. Dispose the room, the generator and the PMREM render target (disposing only its texture leaks it).

## Labels (`scene/labels.ts`, styles in `change.css`)

- `.roof.v-<verdict>`: `.badge` (holographic tag: scanlines, glow, verdict colour through `--c`) over `.file` (mono 11 px). Reviewed-fine tags are smaller and quieter.
- Anchor at the roof + 0.3, or + 1.05 for eyes and risky (above the beam); element bottom-centre on the anchor.
- When the camera rests (120 ms after it last moved, never on drag frames) and on a selection or hover that changes the set: the 120 are re-ranked from the camera position (labels that stay are reused), then `.is-occluded` if another building's box hides the anchor, `.is-crowded` if it overlaps a label of higher priority on screen (the tie-breaker after priority). `.is-hover` and `.is-selected` always show.
- Lot names are not DOM: one atlas texture (mono 500, `--muted`, tier 1 in `--tier` with `   tier 1`), font shrunk until the atlas fits 4096 x 4096. Wait for the mono face (`document.fonts.load`) before drawing it.

## Camera (`scene/orbit.ts`)

- `PerspectiveCamera(32)`, target at the city centre (y 0.4, z + 3% of the span).
- Home `theta = 0.22π`, `phi = 0.98`, `r = 1.45 * span`. Limits scale the mockup's 14 / 30 and 48 / 30 of home (the minimum never above 14); `phi` in [0.35, 1.35].
- Drag: `theta -= dx * 0.006`, `phi -= dy * 0.005`; more than 3 px is a drag, not a click. Wheel: `r *= 1 + deltaY * 0.0012`, non-passive. `R` resets, `Escape` clears the selection; keys are ignored in inputs and with modifiers.
- Intro: `r` from 46 / 30 of home to home in 1.4 s, ease-out cubic, starting with the first drawn frame; skipped under `prefers-reduced-motion`.
- `update(report)` keeps the camera; only the home (for `R`) and the limits follow the new city.

## HUD and filters

- `mountChange(el, { report, crumb?, fleet? })`: the top bar sits above the city, everything else is one overlay inside `.city`. The filters live in `index.ts`, survive `update(report)` and are pruned of a rule the new Report no longer has.
- The scene never decides what is dimmed: `view.setFilters` and hover / selection go through `paintCity` + `focusPaint` (hover only patches the two buildings concerned), and `towers.setPaint(paint)` maps the states to instance colours. A dimmed part fades toward `--c-void` (glass, strips, outlines, skeleton vertices; beams go black); the glass material is white and each instance carries its colour. Hover lifts strips x1.6 and doubles the outline. Labels of dimmed buildings get `.is-dim`.
- Hover reports building, floor and pointer to the HUD tooltip; selection to the card; a selected file that leaves the Report clears the selection and shows a toast.

## Live update tween

`setReport` builds the new city and, unless reduced motion or `needsTween` says nothing moved, tweens from what is on screen: buildings in both Reports move and grow over 400 ms (ease-out), new ones rise, removed ones sink. Lots and ground take the new layout at once; the towers lay the frame out in the buffers they have (`towers.update(city)`), and are built again only when the frame needs a different number of instances (`stats().builds` counts the builds); the markers follow every frame, the reading path and the roof labels (`.is-tweening`) are hidden until the end. The clock starts with the first frame drawn. Frames are requested only while the tween runs. Camera, selection and filters stay.

## Interaction

- Hover: pointer cursor, outline x2, strips x1.6, `.is-hover` label.
- Click: selection outline (violet, wider), strips x1.35, `.is-selected` label; the floor under the pointer is focused (its strip x2.1, `data-selected-floor`, `selectedFloor()`), and the reading panel opens the file view. Escape or a click on empty ground clears it. The selection survives `update` while its file exists.
- New scene elements go in as instanced or batched geometry inside the same draw-call budget; the budget is asserted with every effect on, in both motion modes, on the golden Report and on 2,000 files.

## Disposal

Every geometry, material, texture and render target is disposed on rebuild and on unmount; listeners, the `ResizeObserver`, the media-query listener and the frame request are removed; the context is released with `forceContextLoss`. Only the renderer's own lookup texture is left when the context closes.

## Testing

- Unit (Node): `test/unit/ui/city-layout.test.ts`, `orbit.test.ts`, `view.test.ts`, `hud-model.test.ts`, `tween.test.ts`, `critical.test.ts` (critical floors, paint of pulse and marks, pulse numbers, marker and path placement).
- e2e screens: `test/e2e/screens/change/*.spec.ts` with `test/e2e/support/scene.ts`. Open `/?scene-debug#/change/<id>` and wait for `window.diffcityScene.ready`. The hook has `project(fileId, symbolId?)` (client point of a building, or of a floor's centre), `selectedFloor()` (the focused floor's symbol id), `stats()` (draw calls, buildings, floors, lots, labels, frames, GPU memory, tower builds), `bench(ms)` (fps and draw calls while rendering every frame), `paint()` (dimmed building ids and dimmed floor indices), `shown()` (x, z and height of every building as drawn, mid-tween included), `tweening()`, `tweenTrace()` (heights of the newest tweened building, else the first building, on each frame), `effects()` (read-only: `mode`, `pulsing`, `halos`, `pulse` by file id with floors and phase, `checked`, `gains`, `markers` with kind, file, floor, severity and position, `path` with stops, tube, animated and visible, `tier` ring and opacity, `continuous`), `camera()`, `firstCamera()`, `selected()`, `hovered()` and `disposal` (views alive, what the last one left). `[data-testid="city"]` carries `data-ready`, `data-selected`, `data-hovered` and `data-filters` (`verdict=eyes;type=;rule=`) without the hook. Under the hook, `window.diffcityFleet` is read as the FleetPort (the SPA has no audit data to build one from) and `window.diffcityNoDiffs = true` mounts the screen without a DiffPort, as the export does. The panel's specs use `test/e2e/support/panel.ts` (`panelReport`, `noSpecReport`, `noStepsReport`, `openPanel`). Specs for the effects use the fixture Reports in `test/e2e/support/effects.ts` (`effectsReport`, `calmReport`, `withEveryEffect`, `marksFor`, `setTabVisible`).
- Headless Chromium runs WebGL on SwiftShader (`--use-angle=swiftshader --enable-unsafe-swiftshader` in `test/playwright.config.ts`); frames there take long, so never assert on timing.
- `test/fixtures/ui/gen-large-city.mjs` writes the seeded 2,000-file Report (`test/fixtures/ui/generated/`, not committed) in the global setup.
- Acceptance: `test/e2e/acceptance/city-from-daemon-report.spec.ts` against the real daemon.

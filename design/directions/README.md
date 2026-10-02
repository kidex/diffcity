# Visual directions for the city

Three renderings of the same change. Direction C, the night data city, is the one the change screen is built on (ADR-026); A and B are kept as reference. Every page reads the golden Report of the `order-discounts` scenario (`test/fixtures/scenarios/order-discounts/expected.json`) through `shared/report.ts` and shows the same things as `design/mockup.html`: lots per package (tier 1 marked), a building per file (untouched files present but quiet), a floor per symbol coloured by status (`del` as a ghost), verdict badges and file names above touched buildings, orbit, zoom, `R` to reset, `J`/`K` through the reading path, a hover tooltip, and click to select. The HUD (top bar, verdict and type filters, legend, selection card) is shared and restyled per direction.

```sh
npm run design:directions          # http://127.0.0.1:4400/a/, /b/, /c/
npm run design:directions:build    # .tmp/design-directions
node design/directions/shoot.mjs   # screenshots, with the dev server running
```

That Report has no execution path and no findings yet, so the pages add a small static sample of both, pointing at real symbol ids (`shared/report.ts`), to show the reading path and the finding pins. The HUD says so. Verdicts are the Report's, so a "Reviewed, fine" building can carry a sample high-severity pin.

## Shared parts

- `shared/city.ts`: the layout. Each package is a lot, packed with its files in Report order; a file's square footprint grows with its symbol count, its height is one floor per symbol. Lots are shelf-packed into straight rows, each row stretched to the widest one, with packages that have no touched file placed first (the back row from the home camera), so quiet towers never stand in front of the change. Deterministic: the same Report gives the same city.
- `shared/stage.ts`: renderer, orbit camera ported from the mockup (same angles, limits scaled to the city, light damping), a 2.4 s intro move skipped under `prefers-reduced-motion`, picking, hover, selection, filters, and a render loop that only draws when something changed.
- Labels are HTML pinned to 3D points (`CSS2DRenderer`), so they are as crisp as the page; a label hides when a building stands between it and the camera. Ground text is canvas drawn at 4x with anisotropic filtering. Colours come only from CSS tokens: the app's `tokens.css` plus a few per-direction tints in each `style.css`.

## A, Glass & light

Acrylic towers in a white studio: every floor is a slab of clear glass (`MeshPhysicalMaterial` with transmission, clearcoat, a little iridescence; `RoundedBoxGeometry`) with an inner band in its status colour, lit by a `RoomEnvironment` through PMREM, with soft shadows and contact shadows under each tower. Untouched files are frosted glass with a pale core, so they read as context. Eyes and risky buildings get a glowing roof beacon and a soft glow around their changed floors. It reads like a product render: the colour is inside the glass and the stack of bands shows where the change is. A full-screen `UnrealBloomPass` was dropped: the glass reflects the studio's hot emitters, and the bloom washed out the whole light scene. The glows are depth-tested sprites, and the page renders without a composer, so the background and the bands keep their exact token colours while the glass goes through ACES. Cost in phase 3: moderate. Transmission is the most expensive material in three.js (one extra opaque pass per frame) and needs care with dimming, because a transparent band behind glass disappears. It holds 60 fps here; a city of several hundred files would need instancing and fewer transmissive meshes, for example one glass shell per building instead of one per floor.

## B, Architectural model

A matte clay maquette on a paper board: white towers with visible storeys, untouched files as solid foam-grey massing without storeys, and colour only on the changed floors, as painted slabs. Removed floors are translucent vellum with a dashed red outline. Verdicts are soft rings on the board around the building; labels are thin annotations, a small-caps verdict over a mono file name on a hairline leader. Shadows are soft (VSM), and `GTAOPass` adds ambient occlusion in the gaps between floors and at the base. A gentle `BokehPass` focused on the orbit centre gives the scale-model feel. It reads calmly: the eye goes straight to the colour, which is exactly the change. Cost in phase 3: the post chain is the expensive part. AO runs at half resolution with 12 samples, the shadow map is drawn once (the city does not move), and the page renders at 1.5x DPR rather than 2x, which together keep 60 fps. Live updates would need the shadow map redrawn on each change. Depth of field blurs the ground labels at the edges of the frame, so it should stay optional.

## C, Night data city

Dark glass towers on a night grid (an anti-aliased shader grid that fades with distance). Each floor is an LED strip in its status colour; untouched floors are faint strips. Each tower has one crisp outline (`LineSegments2`): full verdict colour for eyes, risky and outside the spec, half strength for reviewed-fine, neutral for untouched; the selection turns it violet. Verdicts are holographic tags (scanlines, glow) and, for eyes and risky, sit on a light beam rising from the roof. The reading path is a tube with packets of light running from stop to stop; tier 1 lots have a breathing orange outline. A restrained `UnrealBloomPass` with AgX tone mapping works here because only the strips, edges, beams and pins exceed 1.0. It reads fastest of the three: status and verdict both glow, and the path's direction can be seen. Cost in phase 3: low to moderate. No shadows, no transmission; the bloom pass and the fat lines (their resolution is updated on resize) are the only extras. It is the only direction that animates continuously, and that stops under `prefers-reduced-motion`. AgX pales saturated greens a little at full gain.

## Screenshots

`screenshots/<direction>-hero.png` after the intro move, and `screenshots/<direction>-hover.png` with `orders.service.ts` hovered (1600x1000 at 2x, Chrome).

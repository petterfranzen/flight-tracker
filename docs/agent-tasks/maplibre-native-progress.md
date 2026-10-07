# MapLibre-native migration: progress log

Brief: `docs/agent-tasks/maplibre-native.md`. Branches: `feat/maplibre-native`
(Stage B, merged) and `feat/gl-planes` (Stage C). Stage B done; Stage C done
(all suites green, see its own Results below).

## Done (Stage B)

- One plain `maplibregl.Map` (`src/map/map.ts`), wrapped in the `FlightMap`
  adapter: app (Leaflet) zoom units = MapLibre zoom + 1, `[lat, lon]`
  positions, container pixels. Tests reach it as `._flightMap` on
  `.map-container`.
- Native wheel/touchpad/pinch: `setWheelZoomRate(1 / 113.5)` (one 100 px
  notch is about half a level), touchpad rate default, no rotation or
  pitch, `renderWorldCopies: false`, `maxBounds` for the world (longitudes
  pulled in by 1e-9: at exactly ±180 MapLibre computes a 0 px wide world and
  zooms to infinity), minimum zoom from `zoomLimits.ts`, re-fit on resize.
- `basemapReady` is the map's first `idle`, capped (`maplibreBasemap.ts`).
  Deleted: `wheelZoom.ts`, `pinchResolution.ts`, the zoom-out patch, the
  blank TileLayer, the ±1 warm-up. Removed `leaflet`,
  `@maplibre/maplibre-gl-leaflet`, `@types/leaflet` and the unpkg CSS link.
  maplibre-gl is a static import, in its own `maplibre` chunk
  (`vite.config.ts` manualChunks).
- Planes: one `maplibregl.Marker` per drawn plane. The Marker's element is a
  bare `.plane-marker` wrapper around today's `.plane-icon` markup (the
  Marker writes inline opacity on its element, which would override the
  dimmed/exiting CSS). Reuse by icao24 and `MAX_DRAWN_MARKERS` kept; restyle
  in place on zoom. z-index: dimmed 0, normal 1, selected 2, airports 3.
- Fractional zoom: icon sizes round (as before); overview requests and
  their cache key use `overviewZoom()` (nearest whole level below 8);
  prefetch uses `Math.round(zoom) ± 1`; the /live vs overview threshold
  stays on the raw zoom (so /live is never requested below 8).
- Trail (`map/route.ts`): GeoJSON source `flight-route` + line layer
  `flight-route-line`, colour from `--color-accent`. The SVG dash-travel
  animation is gone (a GL line is drawn dashed but static).
- Airports: `.default-airport-icon` DOM markers. Scale bar: a MapLibre
  control (bottom-left). Debug overlay, follow-selected, initial view and
  off-screen check ported to the adapter.
- Tests: helpers and every spec migrated off `.leaflet-*` and Leaflet
  methods. Replaced `wheel-zoom`, `pinch-resolution`,
  `basemap-zoom-coverage`, `basemap-warmup` with `map-zoom.spec.ts`
  (notch ≈ 0.5, fast notches all count, ctrl+wheel stream is continuous,
  zoom around pointer, canvas covers the viewport while zooming, whole-level
  data keys) and `basemap-ready.spec.ts`; `pinch-zoom.spec.ts` gained the
  "ends fractional" case. The five failures left by the first commit, plus
  one that surfaced under MapLibre: the boot screen intercepting input
  (stale-dim's forced click; the pinch now waits for it to lift), a racy
  prefetch count (now counts requests per zoom level), attribution width
  (box-sizing on the MapLibre strip), a 0 px read of a re-rendering panel
  (mobile-layout, polled); airport-density's click passes as is on
  MapLibre markers.
- `CLAUDE.md` / `README.md` updated (one theme, the adapter, zoom units).

## Results (cloud session, Node 22, software WebGL)

- `npx tsc --noEmit -p .`, `npm run build`: clean.
- `npm run test:e2e`: 94 passed (production-build.spec.ts included).
- `npm run test:perf`: 2 passed, budget unchanged (200 ms). Three runs:
  max long task 167 / 113 / 127 ms at slowdown 1, 73-81 tasks over 50 ms,
  select 354-436 ms.
- `npm run test:scenarios`: 5 passed (twice).
- `cd backend && mvn -B verify -Pwith-frontend`: passes.

## Left for Stage C or the owner

- Planes are still DOM markers (Stage C moves them to a symbol layer).
  MapLibre re-places every marker on each `move` frame; fine at the
  300/150 caps here.
- The trail's dash-travel animation was an SVG stroke animation and is
  gone; the GL line is dashed but static. Animating `line-dasharray` per
  frame is possible if wanted.
- Airports stay above every plane, the selected one included (as under
  Leaflet), so an airport label can cover the selected plane's callsign
  chip.
- The attribution uses MapLibre's default light strip (as Leaflet's was).

## Known failures

- None. `production-build.spec.ts`'s real-tile check is expected to fail
  in a cloud session (blocked host) but passed here.

---

# Stage C: planes as a GL layer

Branch `feat/gl-planes`, from main at 2248cfc.

## Done (Stage C)

- Planes are drawn by the map (`src/map/planes.ts`): a GeoJSON source for
  the unselected ones and one for the selected one, with symbol layers
  `planes` (+ `planes-entering`), `plane-selected-halo`, `plane-selected`
  and `plane-selected-label`. `map/markers.ts` is gone.
- Images are drawn on a 2D canvas from the theme tokens and registered with
  `addImage`: the dart in resting, selected and unknown-heading looks, and
  the selected plane's halo (`map/glImages.ts` holds the canvas, label and
  on-demand-image helpers, shared with the airports). New tokens in
  `FlightMap.css` for what used to be hard-coded in the plane/airport CSS
  (`--color-plane-outline`, `--color-plane-shadow`, `--color-marker-halo`,
  `--color-label-bg`, `--color-airport*`).
- `icon-rotate` is the heading with `icon-rotation-alignment: map`;
  `icon-size` interpolates the old `ICON_SIZE_BY_ZOOM` sizes (mobile factor
  included, selected 1.25x) so a fractional zoom gives an intermediate size;
  dimmed planes are `icon-opacity` 0.35 and sort under live ones
  (`symbol-sort-key`); the selected plane's callsign chip is an image drawn
  on demand (`setMissingStyleImageResolver`) and kept beside the plane by a
  zoom-interpolated `icon-translate`.
  - `icon-size` is a zoom *and feature* expression (`* coalesce(scale, 1)`).
    MapLibre caps a plain camera size at its value one zoom level above the
    tile's — the size the tile's collision boxes were built for — so the
    sizes that shrink past z14 were drawn a level early (43 px at z15
    instead of 52). A composite size is not capped.
- A small batch of arrivals (<= 40, as before) fades in over 220 ms through
  the entering layer's `icon-opacity`, then joins the main layer; data goes
  to the sources with `setData` only when something drawn changed.
- Airports (`ui/defaultAirports.ts`) are one symbol layer too, under the
  trail and the planes, so an airport code can no longer cover the selected
  plane; the rank-per-zoom rule is a `step` filter on the layer.
  `DefaultAirports.css` is gone. The trail (`map/route.ts`) is added below
  the plane layers.
- Clicks and hovers go through the adapter: modules register a hit test
  (`FlightMap.addHitTarget`), `hitAt` picks the selected plane first, then
  the nearest plane (its whole icon box, as the DOM marker's was) or
  airport dot; the canvas gets a pointer cursor on hover. Selection still
  goes through `handleSelectAircraft`.
- Test hooks on the adapter: `renderedPlanes()` (icao24, callsign, lat/lon,
  container x/y, size, selected, dimmed, label, fadedIn, drawnSince) and
  `renderedAirports()`. `tests/helpers.ts` exposes them in page pixels
  (`renderedPlanes`, `renderedAirports`, `waitForPlanes`, `planeTarget`,
  `findMarkerNear`, `clickAirport`); the scenario harness reads and clicks
  planes the same way. No spec queries plane or airport DOM any more.
- New `tests/gl-planes.spec.ts`: fractional zoom gives an intermediate size
  (measured off a screenshot, not just the hook), a click on a plane's icon
  box selects it while one beside it does not, overlapping planes keep only
  the first discovered even after the server reorders them, the selected
  plane is drawn where it overlaps an earlier one, and it is drawn and hit
  above an airport's dot and code.
- `CLAUDE.md` / `README.md` updated (planes and airports as GL layers, the
  hit test, the test hooks).

## The declutter decision: `pickNonOverlapping` stays

MapLibre's symbol collision was measured in this app (MapLibre 6.7,
throwaway spec, software WebGL) before deciding:

- "First discovered wins" *is* reproducible: with `symbol-sort-key` = the
  discovery rank and `icon-allow-overlap: false`, the lower rank won every
  pair tested, including pairs straddling a tile boundary in both
  directions and a pair whose first-discovered plane came second in the
  data. Active-before-inactive is just a lower sort key.
- What does not work is the *distance*. Collision uses the icon's box plus
  `icon-padding`; today's rule hides planes closer than 0.7 of the box.
  A negative padding can shrink the box, but the box is sized from
  `icon-size` evaluated one zoom level *above* the tile's, not from the
  drawn size: at app z9 (drawn 40 px, z10's size 50 px) icons 30 and 36 px
  apart were hidden although the rule keeps them, with the same result at
  z9.5. Since the sizes grow to z14 and taper after it, a padding tuned per
  level would still be wrong between levels and from z14 to z17 (where the
  next level is smaller) icons would overlap. Collision also re-runs on
  every frame of a gesture, and cannot express the MAX_DRAWN caps' even
  thinning (a crowded view keeps its spread instead of clumping).

So the screen-space pick (`map/declutter.ts`, `main.ts`
`renderAircraftLayer`) decides what is drawn, the caps stay, the server-side
overview thinning stays, and the layers draw exactly the kept set with
`icon-allow-overlap: true`.

## Results (cloud session, Node 22, software WebGL)

- `npx tsc --noEmit -p .`, `npm run build`: clean.
- `npm run test:e2e`: 99 passed (production-build.spec.ts included).
- `npm run test:perf`: 2 passed, four runs, budget unchanged (200 ms).
  Max long task 167 / 195 / 126 / 171 ms at slowdown 1, select 265-335 ms.
  For comparison, main measured in the same session: 114 / 139 / 121 ms,
  select 259-389 ms. The map now repaints more often (about 170 frames in
  that run against 78), which is what a GL layer updating its data does;
  the extra frames are what pushed the worst task up, and each is
  software-rasterised here. Not loosened; worth re-checking on a GPU.
- `npm run test:scenarios`: 5 passed.
- `cd backend && mvn -B verify -Pwith-frontend`: passes.

## Left for the owner

- The halo under the selected plane is static (the DOM marker pulsed, which
  reduced-motion already turned off). Animating it would mean a paint
  property per frame; its reduced-motion look is what ships now.
- The trail's dash-travel animation is still gone (Stage B).
- Plane and airport images are drawn at 3x and 2x device pixels
  respectively, not at the real `devicePixelRatio` cap: fine up to a 3x
  phone, slightly soft beyond it.

## Known failures (Stage C)

- None. `production-build.spec.ts`'s real-tile check is expected to fail in
  a cloud session (blocked host) but passed here.
